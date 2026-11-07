//! Owned, durable sources for New File. Content is never transfer metadata.
use crate::workspace::AccountGuard;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf};
use tauri::Manager;

pub const MAX_BYTES: usize = 1_048_576;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileRequest {
    pub id: String,
    pub owner_id: String,
    pub folder_id: Option<i64>,
    pub filename: String,
    pub content: String,
    pub protection_mode: String,
    pub protect_metadata: bool,
    pub prompt_token: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSource {
    pub id: String,
    pub fingerprint: String,
    pub content_hash: String,
    pub filename: String,
}

pub fn validate_name(name: &str) -> Result<(), String> {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_uppercase();
    if name.trim().is_empty()
        || name.encode_utf16().count() > 120
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
        )
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    {
        return Err("[FILE_NAME_INVALID] Choose a safe filename of at most 120 characters".into());
    }
    Ok(())
}

pub fn validate_text(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("[TEXT_EMPTY] Enter at least one byte of text".into());
    }
    if content.len() > MAX_BYTES {
        return Err("[TEXT_TOO_LARGE] Text exceeds 1 MiB".into());
    }
    Ok(())
}

impl CreateFileRequest {
    pub fn validate(&self) -> Result<CreatedSource, String> {
        validate_name(&self.filename)?;
        validate_text(&self.content)?;
        validate_id(&self.id)?;
        if !matches!(
            self.protection_mode.as_str(),
            "standard" | "vault" | "passphrase" | "vault_and_passphrase"
        ) {
            return Err("Invalid protection mode".into());
        }
        let mut hash = Sha256::new();
        // Length-delimited binding prevents reusing an id with another request.
        for part in [
            self.owner_id.as_bytes(),
            &self
                .folder_id
                .map(|id| id.to_string())
                .unwrap_or_default()
                .into_bytes(),
            self.filename.as_bytes(),
            self.content.as_bytes(),
            self.protection_mode.as_bytes(),
            &[u8::from(self.protect_metadata)],
        ] {
            hash.update((part.len() as u64).to_le_bytes());
            hash.update(part);
        }
        Ok(CreatedSource {
            id: self.id.clone(),
            filename: self.filename.clone(),
            fingerprint: format!("{:x}", hash.finalize()),
            content_hash: format!("{:x}", Sha256::digest(self.content.as_bytes())),
        })
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 || id.to_lowercase() != id {
        return Err("Invalid creation request ID".into());
    }
    Ok(())
}

fn private_dir(path: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Unsafe creation staging directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn directory(account: &AccountGuard, source: &CreatedSource) -> Result<PathBuf, String> {
    validate_id(&source.id)?;
    let base = account.root.join("created-files");
    private_dir(&base)?;
    let owner = base.join(account.owner.to_string());
    private_dir(&owner)?;
    let dir = owner.join(&source.id);
    private_dir(&dir)?;
    Ok(dir)
}

/// Exclusive receipt remains after cleanup: clearing a queue cannot resurrect an id.
pub fn stage(
    account: &AccountGuard,
    request: &CreateFileRequest,
    source: &CreatedSource,
) -> Result<PathBuf, String> {
    account.validate()?;
    let dir = directory(account, source)?;
    let receipt = dir.join("receipt");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&receipt)
        .map_err(|_| {
            "[CREATE_REVIEW_REQUIRED] This request was already admitted; review the transfer queue"
                .to_string()
        })?;
    file.write_all(&serde_json::to_vec(source).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    let sources = dir.join("source");
    private_dir(&sources)?;
    let path = sources.join(&request.filename);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut created = false;
    let result = (|| {
        let mut output = options.open(&path).map_err(|e| e.to_string())?;
        created = true;
        output
            .write_all(request.content.as_bytes())
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        if std::fs::read(&path).map_err(|e| e.to_string())? != request.content.as_bytes() {
            return Err("Creation staging verification failed".into());
        }
        account.validate()?;
        Ok(path.clone())
    })();
    if result.is_err() {
        if created {
            let _ = std::fs::remove_file(&path);
        }
        let _ = std::fs::remove_file(receipt);
    }
    result
}

pub fn verify(account: &AccountGuard, source: &CreatedSource, path: &str) -> Result<(), String> {
    verify_owned(account, source, path, true)
}

fn verify_owned(
    account: &AccountGuard,
    source: &CreatedSource,
    path: &str,
    check_content: bool,
) -> Result<(), String> {
    let dir = directory(account, source)?;
    let path = std::path::Path::new(path);
    let sources = dir.join("source");
    private_dir(&sources)?;
    if path.parent() != Some(sources.as_path()) || path.file_name().is_none() {
        return Err("Invalid owned creation source".into());
    }
    validate_name(&path.file_name().unwrap().to_string_lossy())?;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || (check_content && (metadata.len() == 0 || metadata.len() > MAX_BYTES as u64))
    {
        return Err("Invalid owned creation source".into());
    }
    if serde_json::from_slice::<CreatedSource>(
        &std::fs::read(dir.join("receipt")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?
        != *source
        || path.file_name().unwrap() != source.filename.as_str()
    {
        return Err("Creation receipt mismatch".into());
    }
    if check_content
        && format!(
            "{:x}",
            Sha256::digest(std::fs::read(path).map_err(|e| e.to_string())?)
        ) != source.content_hash
    {
        return Err("Creation source changed".into());
    }
    account.validate()
}

pub fn publication_result(
    account: &AccountGuard,
    source: &CreatedSource,
) -> Result<Option<i32>, String> {
    account.validate()?;
    let dir = directory(account, source)?;
    if dir.join("published").exists() {
        return std::fs::read_to_string(dir.join("published"))
            .map_err(|e| e.to_string())?
            .parse::<i32>()
            .map(Some)
            .map_err(|e| e.to_string());
    }
    if dir.join("publishing").exists() {
        return Err("[CREATE_REVIEW_REQUIRED] Telegram publication is uncertain. Review the destination before creating another file; this transfer will not resend.".into());
    }
    Ok(None)
}

tokio::task_local! { static PUBLICATION: (AccountGuard, CreatedSource); }

pub async fn with_source<T>(
    account: AccountGuard,
    source: CreatedSource,
    future: impl std::future::Future<Output = T>,
) -> T {
    PUBLICATION.scope((account, source), future).await
}

/// Called immediately before send_message, not before uploading its parts.
pub async fn begin_publication(
    app: &tauri::AppHandle,
    folder: Option<i64>,
    filename: &str,
    authorize: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if let Ok((account, source)) = PUBLICATION.try_with(Clone::clone) {
        crate::commands::fs::check_creation_destination(app, &account, folder, filename).await?;
        let path = directory(&account, &source)?
            .join("source")
            .join(&source.filename);
        verify(&account, &source, &path.to_string_lossy())?;
        // Scanning may await the network. Recheck cancellation and the original
        // credential after that await, before recording any possible send.
        if app
            .state::<crate::TelegramState>()
            .cancelled_transfers
            .read()
            .await
            .contains(&source.id)
        {
            return Err("Transfer cancelled".into());
        }
        authorize()?;
        latch_publication(&account, &source)?;
    }
    Ok(())
}

pub fn latch_publication(account: &AccountGuard, source: &CreatedSource) -> Result<(), String> {
    account.validate()?;
    if publication_result(account, source)?.is_some() {
        return Err("[CREATE_REVIEW_REQUIRED] This file has already been published".into());
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory(account, source)?.join("publishing"))
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

pub fn finish_publication(message_id: i32) -> Result<(), String> {
    PUBLICATION
        .try_with(|(account, source)| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory(account, source)?.join("published"))
                .map_err(|e| e.to_string())?;
            file.write_all(message_id.to_string().as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())
        })
        .unwrap_or(Ok(()))
}

pub fn is_creation() -> bool {
    PUBLICATION.try_with(|_| true).unwrap_or(false)
}

pub fn cleanup(account: &AccountGuard, source: &CreatedSource, path: &str) -> Result<(), String> {
    // Ownership, not a checksum, authorizes removal: a crash during writing can
    // leave a partial owned file that still needs private-content cleanup.
    verify_owned(account, source, path, false)?;
    // Never recursively delete an input path. Receipts and publication latches remain.
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

/// Runs under the engine mutation/creation locks. Preserve every queued source;
/// only exact, receipted files orphaned before admission or after deletion go.
pub fn sweep_orphans(
    account: &AccountGuard,
    jobs: &[crate::transfer_engine::TransferJob],
) -> Result<(), String> {
    account.validate()?;
    let owner = account
        .root
        .join("created-files")
        .join(account.owner.to_string());
    if !owner.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&owner).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path().join("receipt")) else {
            continue;
        };
        let Ok(source) = serde_json::from_slice::<CreatedSource>(&bytes) else {
            continue;
        };
        if entry.file_name() != source.id.as_str()
            || validate_id(&source.id).is_err()
            || validate_name(&source.filename).is_err()
        {
            continue;
        }
        let retained = jobs.iter().any(|job| {
            job.owner_id.as_deref() == Some(&account.owner.to_string())
                && job.created_source.as_ref() == Some(&source)
                && (job.status != crate::transfer_engine::TransferStatus::Completed
                    || job.persistence_pending)
        });
        if !retained {
            let path = entry.path().join("source").join(&source.filename);
            if path.exists() {
                cleanup(account, &source, &path.to_string_lossy())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_create_file(
    app: tauri::AppHandle,
    request: CreateFileRequest,
    engine: tauri::State<'_, std::sync::Arc<crate::transfer_engine::TransferEngine>>,
) -> Result<crate::transfer_engine::TransferJob, String> {
    let _ = app.path().app_data_dir().map_err(|e| e.to_string())?;
    engine.create_file(request).await
}
