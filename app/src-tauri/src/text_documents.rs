//! Small protected documents are decrypted only in memory, never in preview files.
use crate::{
    crypto::{
        envelope::EnvelopeHeader,
        policy,
        secret::{SecretBytes, SecretKey},
        state::CryptoState,
    },
    workspace::AccountGuard,
};
use std::future::Future;
use zeroize::Zeroizing;

pub(crate) const MAX_BYTES: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

pub(crate) struct Upload {
    pub bytes: Vec<u8>,
    pub header: Vec<u8>,
    pub remote_name: String,
}

/// Only Telegram is substituted in the native process journeys.
pub(crate) trait Remote: Sync {
    fn download(&self, maximum: u64) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn publish(
        &self,
        upload: Upload,
        authorize: &(dyn Fn() -> Result<()> + Sync),
    ) -> impl Future<Output = Result<i32>> + Send;
    fn delete(&self) -> impl Future<Output = Result<()>> + Send;
}

pub(crate) struct Access {
    account: AccountGuard,
    crypto: CryptoState,
    pub generation: u64,
    vault_key: Option<SecretKey>,
    passphrase: Option<SecretBytes>,
    header: Vec<u8>,
    dek: SecretKey,
    metadata: Zeroizing<Vec<u8>>,
    mode: &'static str,
    size: u64,
}

impl Access {
    pub async fn open(
        account: AccountGuard,
        crypto: CryptoState,
        header: Vec<u8>,
        prompt_token: Option<u64>,
        expected_generation: Option<u64>,
    ) -> Result<Self> {
        account.validate()?;
        let generation = crypto.text_access_generation();
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err("[VAULT_LOCKED] Reopen this text file after unlocking".into());
        }
        let credential = crypto.current_credential().ok();
        let passphrase = prompt_token
            .map(|token| crypto.consume_prompt_secret(token))
            .transpose()
            .map_err(|e| e.to_string())?;
        let parsed = EnvelopeHeader::parse(&header).map_err(|e| e.to_string())?;
        if parsed.core.total_plaintext_length > MAX_BYTES as u64 {
            return Err("[TEXT_TOO_LARGE] This text file is too large to edit".into());
        }
        let mode = crate::commands::fs::text_protection_mode(&parsed)?;
        // The upload helper wraps for every credential supplied. Never add an
        // access route just because an unrelated vault is currently unlocked
        // or an unused file passphrase was staged by the caller.
        let vault_key = credential
            .as_ref()
            .filter(|_| mode != "passphrase")
            .map(|(_, key)| key.clone());
        let passphrase = passphrase.filter(|_| mode != "vault");
        let (bytes, key, secret) = (header.clone(), vault_key.clone(), passphrase.clone());
        let (dek, metadata) = crate::crypto::kdf::blocking(move || {
            let (dek, _) =
                crate::commands::fs::authenticated_file_dek(&bytes, key.as_ref(), secret.as_ref())?;
            let parsed = EnvelopeHeader::parse(&bytes).map_err(|e| e.to_string())?;
            let metadata = parsed
                .verify_and_decrypt_metadata(&dek)
                .map_err(|e| e.to_string())?;
            Ok::<_, String>((dek, Zeroizing::new(metadata)))
        })
        .await??;
        // File type and name come from authenticated metadata, never an IPC name.
        if metadata.is_empty() {
            return Err(
                "[TEXT_TYPE_UNSUPPORTED] An authenticated .txt filename is required".into(),
            );
        }
        let value: serde_json::Value =
            serde_json::from_slice(&metadata).map_err(|e| e.to_string())?;
        if value["schema_version"] != 1
            || !value["original_name"]
                .as_str()
                .is_some_and(|name| name.to_ascii_lowercase().ends_with(".txt"))
        {
            return Err("[TEXT_TYPE_UNSUPPORTED] Only .txt documents can be edited".into());
        }
        let access = Self {
            account,
            crypto,
            generation,
            vault_key,
            passphrase,
            header,
            dek,
            metadata,
            mode,
            size: parsed.core.total_plaintext_length,
        };
        access.validate()?;
        Ok(access)
    }

    fn validate(&self) -> Result<()> {
        self.account.validate()?;
        self.crypto
            .with_text_access(self.generation, || ())
            .map_err(|_| "[VAULT_LOCKED] Text access was revoked".to_string())
    }

    async fn plaintext(&self, remote: &impl Remote) -> Result<Zeroizing<Vec<u8>>> {
        self.validate()?;
        let parsed = EnvelopeHeader::parse(&self.header).map_err(|e| e.to_string())?;
        let maximum = crate::crypto::envelope::length::calculate_ciphertext_length(
            self.size,
            parsed.core.chunk_size,
            parsed.core.header_length,
        )
        .map_err(|e| e.to_string())?;
        let bytes = remote.download(maximum).await?;
        self.validate()?;
        if bytes.len() as u64 != maximum || !bytes.starts_with(&self.header) {
            return Err("[WRONG_KEY_OR_CORRUPT] Text document changed or is incomplete".into());
        }
        let mut reader = crate::crypto::envelope::decrypt_reader::DecryptReader::new(
            &self.header,
            self.dek.clone(),
        )
        .map_err(|e| e.to_string())?;
        let plaintext = Zeroizing::new(
            reader
                .feed(&bytes[self.header.len()..])
                .map_err(|_| "[WRONG_KEY_OR_CORRUPT] Text authentication failed".to_string())?,
        );
        reader
            .finish()
            .map_err(|_| "[WRONG_KEY_OR_CORRUPT] Text authentication failed".to_string())?;
        self.validate()?;
        Ok(plaintext)
    }

    pub async fn read(&self, remote: &impl Remote) -> Result<String> {
        let bytes = self.plaintext(remote).await?;
        self.account.validate()?;
        self.crypto
            .with_text_access(self.generation, || {
                String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                    .into_owned()
            })
            .map_err(|_| "[VAULT_LOCKED] Text access was revoked".into())
    }

    pub async fn replace(&self, remote: &impl Remote, content: String) -> Result<i32> {
        use tokio::io::AsyncReadExt;
        let content = Zeroizing::new(content);
        if content.len() > MAX_BYTES {
            return Err("[TEXT_TOO_LARGE] Text exceeds 1 MiB".into());
        }
        // Authenticate the complete original before replacing anything.
        drop(self.plaintext(remote).await?);
        // Every existing access route must be preserved. In particular, a vault
        // unlock must not silently replace or drop a hybrid file's passphrase.
        let (header, vault, passphrase) = (
            self.header.clone(),
            self.vault_key.clone(),
            self.passphrase.clone(),
        );
        crate::crypto::kdf::blocking(move || {
            let parsed = EnvelopeHeader::parse(&header).map_err(|e| e.to_string())?;
            for slot in &parsed.key_slots {
                let _dek = if slot.kind == policy::SlotKind::Vault as u8 {
                    crate::commands::fs::authenticated_file_dek(&header, vault.as_ref(), None)?.0
                } else if slot.kind == policy::SlotKind::Passphrase as u8 {
                    crate::commands::fs::authenticated_file_dek(&header, None, passphrase.as_ref())?
                        .0
                } else {
                    return Err("[TEXT_TYPE_UNSUPPORTED] Unsupported encryption slot".into());
                };
            }
            Ok::<_, String>(())
        })
        .await??;
        let stream = crate::commands::fs::protected_upload_stream_off_worker(
            content.as_bytes(),
            content.len() as u64,
            self.mode,
            self.vault_key.as_ref(),
            self.passphrase.as_ref(),
            self.metadata.to_vec(),
            None,
        )
        .await?;
        let mut reader = stream.reader;
        let mut ciphertext = Vec::new();
        reader
            .read_to_end(&mut ciphertext)
            .await
            .map_err(|e| e.to_string())?;
        self.validate()?;
        let message_id = remote
            .publish(
                Upload {
                    bytes: ciphertext,
                    header: stream.header,
                    remote_name: stream.remote_name,
                },
                &|| self.validate(),
            )
            .await?;
        self.validate()?;
        // No rollback/delete until the replacement and its registry are durable.
        remote.delete().await?;
        self.validate()?;
        Ok(message_id)
    }
}
