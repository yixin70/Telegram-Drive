//! Short-lived file-scoped keys never cross IPC or enter the database.
use super::{store::Store, Payload, ProtectedContext, Record, Result, MAX_TEXT};
use crate::{
    crypto::{
        self,
        secret::{SecretBytes, SecretKey},
        state::CryptoState,
    },
    workspace::AccountGuard,
};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload as AadPayload},
    XChaCha20Poly1305, XNonce,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use zeroize::Zeroize;

#[derive(Clone)]
struct Access {
    account: AccountGuard,
    identity: String,
    alias: String,
    header: Vec<u8>,
    file_uuid: String,
    key: SecretKey,
    generation: u64,
    expires: Instant,
}
static ACCESS: LazyLock<Mutex<HashMap<String, Access>>> = LazyLock::new(Default::default);

pub(crate) fn revoke_all() {
    ACCESS.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

pub(crate) async fn authorize(
    account: &AccountGuard,
    crypto: &CryptoState,
    identity: String,
    alias: String,
    header: Vec<u8>,
    passphrase: Option<SecretBytes>,
) -> Result<String> {
    account.validate()?;
    crypto.lock_if_auto_lock_due();
    let generation = crypto.notes_generation();
    let vault = crypto.get_current_wrapping_key().ok();
    let bytes = header.clone();
    let key = crypto::kdf::blocking(move || -> Result<SecretKey> {
        let (dek, _) = crate::commands::fs::authenticated_file_dek(
            &bytes,
            vault.as_ref(),
            passphrase.as_ref(),
        )?;
        let hkdf = hkdf::Hkdf::<sha2::Sha256>::new(None, dek.expose());
        let mut key = [0u8; 32];
        hkdf.expand(b"telegram-drive:file-notes:v1", &mut key)
            .map_err(|_| "NOTES_AUTH")?;
        Ok(SecretKey::new(key))
    })
    .await??;
    let parsed = crypto::envelope::EnvelopeHeader::parse(&header).map_err(|_| "NOTES_AUTH")?;
    let file_uuid = uuid::Uuid::from_bytes(parsed.core.file_uuid).to_string();
    account.validate()?;
    if generation != crypto.notes_generation() {
        return Err("NOTES_LOCKED".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let result = crypto.publish_notes_access(generation, || {
        let mut entries = ACCESS.lock().map_err(|_| "NOTES_LOCKED")?;
        entries.retain(|_, entry| entry.expires > Instant::now() && entry.generation == generation);
        if let Some((token, _)) = entries.iter().find(|(_, entry)| {
            entry.account.owner == account.owner
                && entry.account.root == account.root
                && entry.identity == identity
                && entry.header == header
        }) {
            return Ok((token.clone(), false));
        }
        if entries.len() >= 512 {
            return Err("NOTES_LIMIT".into());
        }
        entries.insert(
            token.clone(),
            Access {
                account: account.clone(),
                identity,
                alias,
                header,
                file_uuid,
                key,
                generation,
                expires: Instant::now() + Duration::from_secs(900),
            },
        );
        Ok((token, true))
    })?;
    let (result, inserted) = result;
    let expiry_token = result.clone();
    if inserted {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(900)).await;
            if let Ok(mut entries) = ACCESS.lock() {
                if entries
                    .get(&expiry_token)
                    .is_some_and(|entry| entry.expires <= Instant::now())
                {
                    entries.remove(&expiry_token);
                }
            }
        });
    }
    Ok(result)
}

pub(crate) fn expires_at(account: &AccountGuard, crypto: &CryptoState, token: &str) -> Result<i64> {
    let entry = get(account, crypto, token)?;
    Ok(super::now()
        + i64::try_from(
            entry
                .expires
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .map_err(|_| "NOTES_LOCKED")?)
}

fn get(account: &AccountGuard, crypto: &CryptoState, token: &str) -> Result<Access> {
    crypto.lock_if_auto_lock_due();
    let entry = ACCESS
        .lock()
        .map_err(|_| "NOTES_LOCKED")?
        .get(token)
        .cloned()
        .ok_or("NOTES_LOCKED")?;
    entry.account.validate()?;
    account.validate()?;
    if entry.account.owner != account.owner
        || entry.account.root != account.root
        || entry.generation != crypto.notes_generation()
        || entry.expires <= Instant::now()
    {
        ACCESS.lock().map_err(|_| "NOTES_LOCKED")?.remove(token);
        return Err("NOTES_LOCKED".into());
    }
    Ok(entry)
}

fn aad(owner: &str, context: &ProtectedContext) -> Result<Vec<u8>> {
    serde_json::to_vec(&("telegram-drive:file-notes:v1", owner, context))
        .map_err(|_| "NOTES_AUTH".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Readable {
    pub text: String,
    pub revision: i64,
}

pub(crate) fn read(account: &AccountGuard, crypto: &CryptoState, token: &str) -> Result<Readable> {
    let entry = get(account, crypto, token)?;
    let store = Store::open(account)?;
    let Some(record) = store.read(account, &entry.identity)? else {
        return Ok(Readable {
            text: String::new(),
            revision: 0,
        });
    };
    let Payload::Encrypted {
        context,
        nonce,
        ciphertext,
    } = &record.payload
    else {
        return Err("NOTES_PROTECTION".into());
    };
    if context.binding != entry.identity || context.file_uuid != entry.file_uuid {
        return Err("NOTES_IDENTITY".into());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(entry.key.expose()).map_err(|_| "NOTES_AUTH")?;
    let mut bytes = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            AadPayload {
                msg: ciphertext,
                aad: &aad(&record.owner, context)?,
            },
        )
        .map_err(|_| "NOTES_AUTH")?;
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => {
            bytes.zeroize();
            return Err("NOTES_AUTH".into());
        }
    };
    bytes.zeroize();
    if get(account, crypto, token).is_err() {
        let mut text = text;
        text.zeroize();
        return Err("NOTES_LOCKED".into());
    }
    Ok(Readable {
        text,
        revision: record.revision,
    })
}

pub(crate) fn save(
    account: &AccountGuard,
    crypto: &CryptoState,
    token: &str,
    text: &str,
    expected: i64,
) -> Result<Readable> {
    if text.len() > MAX_TEXT {
        return Err("NOTES_LIMIT".into());
    }
    let entry = get(account, crypto, token)?;
    let store = Store::open(account)?;
    let revision = store.transaction(account, || {
        let previous = store.read(account, &entry.identity)?;
        if previous.as_ref().map_or(0, |record| record.revision) != expected {
            return Err("NOTES_CONFLICT".into());
        }
        if previous
            .as_ref()
            .is_some_and(|record| !matches!(record.payload, Payload::Encrypted { .. }))
        {
            return Err("NOTES_PROTECTION".into());
        }
        let timestamp = super::now();
        let id = previous.as_ref().map_or_else(
            || uuid::Uuid::new_v4().to_string(),
            |record| record.id.clone(),
        );
        let context = ProtectedContext {
            version: 1,
            note_id: id.clone(),
            header: entry.header.clone(),
            file_uuid: entry.file_uuid.clone(),
            binding: entry.identity.clone(),
        };
        let mut nonce = vec![0u8; 24];
        use rand::RngCore;
        rand::rng().fill_bytes(&mut nonce);
        let cipher =
            XChaCha20Poly1305::new_from_slice(entry.key.expose()).map_err(|_| "NOTES_AUTH")?;
        let owner = account.owner.to_string();
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                AadPayload {
                    msg: text.as_bytes(),
                    aad: &aad(&owner, &context)?,
                },
            )
            .map_err(|_| "NOTES_AUTH")?;
        let revision = expected.checked_add(1).ok_or("NOTES_LIMIT")?;
        let mut aliases = previous
            .as_ref()
            .map_or_else(Vec::new, |record| record.aliases.clone());
        if !aliases.contains(&entry.alias) {
            aliases.push(entry.alias.clone());
        }
        let record = Record {
            id,
            owner,
            identity: entry.identity.clone(),
            revision,
            created_at: previous
                .as_ref()
                .map_or(timestamp, |record| record.created_at),
            updated_at: timestamp.max(previous.as_ref().map_or(0, |record| record.updated_at)),
            aliases,
            payload: Payload::Encrypted {
                context,
                nonce,
                ciphertext,
            },
        };
        get(account, crypto, token)?;
        store.release_alias(account, &entry.alias, &entry.identity)?;
        store.put(account, &record)?;
        get(account, crypto, token)?;
        Ok(revision)
    })?;
    get(account, crypto, token)?;
    Ok(Readable {
        text: text.into(),
        revision,
    })
}

pub(crate) fn delete(
    account: &AccountGuard,
    crypto: &CryptoState,
    token: &str,
    expected: i64,
) -> Result<()> {
    let entry = get(account, crypto, token)?;
    Store::open(account)?.delete(account, &entry.identity, expected)?;
    get(account, crypto, token)?;
    Ok(())
}
