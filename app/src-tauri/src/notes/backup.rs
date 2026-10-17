use super::{Record, Result, MAX_BACKUP, MAX_RECORDS};
use crate::workspace::AccountGuard;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub owner: String,
    pub exported_at: i64,
    pub records: Vec<Record>,
}

impl Backup {
    pub fn parse(bytes: &[u8], owner: i64) -> Result<Self> {
        if bytes.len() > MAX_BACKUP {
            return Err("NOTES_LIMIT".into());
        }
        let backup: Self = serde_json::from_slice(bytes).map_err(|_| "NOTES_INVALID")?;
        backup.validate(owner)?;
        Ok(backup)
    }
    pub fn validate(&self, owner: i64) -> Result<()> {
        if self.format != "telegram-drive-notes" || self.version != 1 {
            return Err("NOTES_VERSION".into());
        }
        if self.owner != owner.to_string() {
            return Err("ACCOUNT_CHANGED".into());
        }
        if self.records.len() > MAX_RECORDS {
            return Err("NOTES_LIMIT".into());
        }
        if self.exported_at < 0 {
            return Err("NOTES_INVALID".into());
        }
        if serde_json::to_vec(self).map_err(|_| "NOTES_INVALID")?.len() > MAX_BACKUP {
            return Err("NOTES_LIMIT".into());
        }
        let mut ids = HashSet::new();
        let mut identities = HashSet::new();
        let mut aliases = HashSet::new();
        for record in &self.records {
            record.validate(owner)?;
            if !ids.insert(&record.id)
                || !identities.insert(&record.identity)
                || record.aliases.iter().any(|alias| !aliases.insert(alias))
            {
                return Err("NOTES_INVALID".into());
            }
        }
        Ok(())
    }
}

pub fn export(account: &AccountGuard) -> Result<Backup> {
    let store = super::store::Store::open(account)?;
    let backup = Backup {
        format: "telegram-drive-notes".into(),
        version: 1,
        owner: account.owner.to_string(),
        exported_at: super::now(),
        records: store.list(account)?,
    };
    if serde_json::to_vec(&backup)
        .map_err(|_| "NOTES_INVALID")?
        .len()
        > MAX_BACKUP
    {
        return Err("NOTES_LIMIT".into());
    }
    Ok(backup)
}

#[derive(Default, Serialize)]
pub struct ImportResult {
    pub added: usize,
    pub replaced: usize,
    pub unchanged: usize,
    pub conflicts: usize,
}

fn same_content(left: &Record, right: &Record) -> bool {
    left.id == right.id
        && left.owner == right.owner
        && left.identity == right.identity
        && left.created_at == right.created_at
        && left.aliases == right.aliases
        && left.payload == right.payload
}

// A stable alternate ID makes keep-both repeatable without a permanent receipt
// that could incorrectly suppress restoration after the original was deleted.
fn alternate_id(record: &Record) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(b"telegram-drive:notes:v1:import-alternate\0");
    hash.update(serde_json::to_vec(record).map_err(|_| "NOTES_INVALID")?);
    let digest = hash.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8, application-defined SHA-256 input.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

pub fn import(account: &AccountGuard, backup: Backup, policy: &str) -> Result<ImportResult> {
    backup.validate(account.owner)?;
    if !matches!(policy, "keep" | "replace" | "both") {
        return Err("NOTES_INVALID".into());
    }
    let store = super::store::Store::open(account)?;
    store.backup(account)?;
    store.transaction(account, || {
        let mut result = ImportResult::default();
        for mut record in backup.records {
            if let Some(existing) = store.read(account, &record.identity)? {
                if same_content(&existing, &record) {
                    result.unchanged += 1;
                    continue;
                }
                result.conflicts += 1;
                if policy == "keep" {
                    result.unchanged += 1;
                    continue;
                }
                if std::mem::discriminant(&existing.payload)
                    != std::mem::discriminant(&record.payload)
                {
                    return Err("NOTES_PROTECTION".into());
                }
                if policy == "both" {
                    // The original authenticated note UUID stays in encrypted context.
                    // This storage UUID names only the unattached recoverable alternate.
                    record.id = alternate_id(&record)?;
                    record.identity = format!("alternate:{}", record.id);
                    record.aliases.clear();
                    if let Some(alternate) = store.read(account, &record.identity)? {
                        if !same_content(&alternate, &record) {
                            return Err("NOTES_CONFLICT".into());
                        }
                        result.unchanged += 1;
                        continue;
                    }
                    result.added += 1;
                } else {
                    record.revision = existing
                        .revision
                        .max(record.revision)
                        .checked_add(1)
                        .ok_or("NOTES_LIMIT")?;
                    record.updated_at = super::now().max(record.updated_at);
                    result.replaced += 1;
                }
            } else {
                result.added += 1;
            }
            store.put(account, &record)?;
        }
        if store.list(account)?.len() > MAX_RECORDS {
            return Err("NOTES_LIMIT".into());
        }
        Ok(result)
    })
}

/// Called with a path selected by a native save dialog, never an IPC path.
/// A no-clobber publication cannot destroy an existing backup on failure.
pub fn write_file(account: &AccountGuard, path: &std::path::Path) -> Result<()> {
    use std::io::Write;
    let bytes = serde_json::to_vec(&export(account)?).map_err(|_| "NOTES_INVALID")?;
    if bytes.len() > MAX_BACKUP {
        return Err("NOTES_LIMIT".into());
    }
    let parent = path.parent().ok_or("NOTES_STORAGE")?;
    let temporary = parent.join(format!(".tdnotes-{}.tmp", uuid::Uuid::new_v4()));
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(temporary.clone());
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|_| "NOTES_STORAGE")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "NOTES_STORAGE")?;
    drop(file);
    account.validate()?;
    // Atomic creation, not rename-overwrite: cancellation or any failure leaves
    // an existing user-selected backup byte-for-byte intact.
    std::fs::hard_link(&temporary, path).map_err(|_| "NOTES_EXPORT_EXISTS_OR_UNSUPPORTED")?;
    Ok(())
}

pub fn read_file(path: &std::path::Path, owner: i64) -> Result<Backup> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| "NOTES_STORAGE")?;
    if file.metadata().map_err(|_| "NOTES_STORAGE")?.len() > MAX_BACKUP as u64 {
        return Err("NOTES_LIMIT".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BACKUP as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "NOTES_STORAGE")?;
    Backup::parse(&bytes, owner)
}
