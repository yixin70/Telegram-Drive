//! Vault-protected names. Only authenticated ciphertext belongs in persistent
//! folder layouts or Telegram control messages; plaintext is a session projection.
use crate::{crypto::state::CryptoState, models::FolderMetadata, workspace::AccountGuard};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use grammers_client::{types::Peer, Client, InputMessage};
use std::collections::{HashMap, HashSet};
use tauri::{Manager, State};

pub const PREFIX: &str = "TDFOLDERNAME1:";
pub const MARKER: &str = "[TD-ENCRYPTED]";
const MAX_RECORD: usize = 1024;

pub fn protected(name: &str) -> bool {
    name.starts_with(PREFIX) || name.contains(MARKER)
}

/// Read only the active account's layout. Never activate/swap a layout from a
/// publication callback, or fall back to another account's shared rows.
pub fn cached(account: &AccountGuard) -> Result<Vec<FolderMetadata>, String> {
    account.validate()?;
    if !crate::folder_layout::readable_by(&account.root, Some(account.owner)) {
        return Ok(Vec::new());
    }
    let path = account.root.join("shares.db");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let mut conn =
        sqlite::Connection::open_with_flags(path, sqlite::OpenFlags::new().with_read_only())
            .map_err(|e| e.to_string())?;
    conn.set_busy_timeout(1000).map_err(|e| e.to_string())?;
    let folders = crate::commands::folder_groups::enriched_folders(&conn)?;
    account.validate()?;
    Ok(folders)
}

pub fn has_protected_ancestor(folders: &[FolderMetadata], id: i64) -> bool {
    let mut cursor = Some(id);
    let mut seen = HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id) {
            return true;
        }
        let Some(folder) = folders.iter().find(|f| f.id == id) else {
            break;
        };
        if protected(&folder.name) {
            return true;
        }
        cursor = folder.parent_id;
    }
    false
}

pub fn ensure_readable(
    account: &AccountGuard,
    crypto: &CryptoState,
    folder: Option<i64>,
) -> Result<(), String> {
    let Some(id) = folder else {
        return Ok(());
    };
    let raw = cached(account)?;
    if has_protected_ancestor(&raw, id)
        && !project(crypto, account.owner, raw)
            .iter()
            .any(|f| f.id == id && !f.is_locked)
    {
        return Err("[VAULT_LOCKED] Unlock the vault to open this folder.".into());
    }
    Ok(())
}

fn aad(owner: i64, folder: i64) -> String {
    format!("telegram-drive:folder-name:v1:{owner}:{folder}")
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err("Folder names must contain 1–120 characters without control characters".into());
    }
    Ok(())
}

pub fn seal(crypto: &CryptoState, owner: i64, folder: i64, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let (session, key) = crypto
        .current_credential()
        .map_err(|_| "[FOLDER_NAME_VAULT_LOCKED] Unlock the vault to encrypt this folder name.")?;
    let nonce = crate::crypto::random::random_wrap_nonce();
    let cipher = XChaCha20Poly1305::new(key.expose().into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: name.as_bytes(),
                aad: aad(owner, folder).as_bytes(),
            },
        )
        .map_err(|_| "Unable to encrypt folder name")?;
    let record = format!(
        "{PREFIX}{}",
        STANDARD.encode([nonce.as_slice(), &ciphertext].concat())
    );
    crypto
        .with_current_session(session, || record)
        .map_err(|e| e.to_string())
}

fn open(crypto: &CryptoState, owner: i64, folder: i64, record: &str) -> Result<String, String> {
    if record.len() > MAX_RECORD {
        return Err("Invalid encrypted folder name".into());
    }
    let encoded = record
        .strip_prefix(PREFIX)
        .ok_or("Missing encrypted folder name")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid encrypted folder name")?;
    if bytes.len() < 41 {
        return Err("Invalid encrypted folder name".into());
    }
    let (session, key) = crypto.current_credential().map_err(|e| e.to_string())?;
    let plaintext = XChaCha20Poly1305::new(key.expose().into())
        .decrypt(
            XNonce::from_slice(&bytes[..24]),
            Payload {
                msg: &bytes[24..],
                aad: aad(owner, folder).as_bytes(),
            },
        )
        .map_err(|_| "Unable to authenticate encrypted folder name")?;
    let plaintext = zeroize::Zeroizing::new(plaintext);
    let name = std::str::from_utf8(&plaintext)
        .map_err(|_| "Invalid encrypted folder name")?
        .to_string();
    validate_name(&name)?;
    crypto
        .with_current_session(session, || name)
        .map_err(|e| e.to_string())
}

/// Fail closed for missing keys, malformed metadata and names from another
/// owner/folder. Child names cannot leak through a locked ancestor.
pub fn project(
    crypto: &CryptoState,
    owner: i64,
    mut folders: Vec<FolderMetadata>,
) -> Vec<FolderMetadata> {
    let session = crypto.current_session();
    for folder in &mut folders {
        folder.is_encrypted = protected(&folder.name);
        folder.is_locked = false;
        if folder.is_encrypted {
            match open(crypto, owner, folder.id, &folder.name) {
                Ok(name) => folder.name = name,
                Err(_) => {
                    folder.name = "Encrypted".into();
                    folder.is_locked = true;
                }
            }
        }
    }
    // If revocation raced the projection, discard every decrypted name.
    if session != crypto.current_session() {
        for folder in &mut folders {
            if folder.is_encrypted {
                folder.name = "Encrypted".into();
                folder.is_locked = true;
            }
        }
    }
    let parents: HashMap<_, _> = folders.iter().map(|f| (f.id, f.parent_id)).collect();
    let locked: HashSet<_> = folders
        .iter()
        .filter(|f| f.is_locked)
        .map(|f| f.id)
        .collect();
    folders.retain(|folder| {
        let mut parent = folder.parent_id;
        let mut seen = HashSet::new();
        while let Some(id) = parent {
            if locked.contains(&id) || !seen.insert(id) {
                return false;
            }
            parent = parents.get(&id).copied().flatten();
        }
        true
    });
    folders
}

pub fn project_app(
    app: &tauri::AppHandle,
    expected_owner: Option<i64>,
    folders: Vec<FolderMetadata>,
) -> Result<Vec<FolderMetadata>, String> {
    if folders.is_empty() {
        return Ok(folders);
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, None)?;
    if Some(account.owner) != expected_owner {
        return Err("Account changed".into());
    }
    let projected = project(app.state::<CryptoState>().inner(), account.owner, folders);
    account.validate()?;
    Ok(projected)
}

/// Newest immutable name record wins. Text-only records never enter the media
/// catalog. Missing/corrupt remote metadata must not replace a good local scan.
pub async fn remote_name(client: &Client, peer: &Peer) -> Result<String, String> {
    // Walk newest-first history rather than Telegram's eventually indexed text
    // search: a scan immediately after rename must see the new control record.
    let mut messages = client.iter_messages(peer);
    while let Some(message) = messages.next().await.map_err(|e| e.to_string())? {
        if message.text().starts_with(PREFIX) {
            if message.text().len() > MAX_RECORD {
                return Err("Invalid encrypted folder metadata".into());
            }
            return Ok(message.text().to_string());
        }
    }
    Err("Encrypted folder name record is missing; cached folders were retained".into())
}

pub async fn publish_name(client: &Client, peer: &Peer, record: &str) -> Result<(), String> {
    client
        .send_message(peer, InputMessage::new().text(record))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_encrypt_folder_name(
    app: tauri::AppHandle,
    owner_id: String,
    folder_id: i64,
    state: State<'_, crate::commands::TelegramState>,
    db: State<'_, crate::db::DbConnection>,
    crypto: State<'_, CryptoState>,
) -> Result<Vec<FolderMetadata>, String> {
    let account = AccountGuard::open(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        Some(&owner_id),
    )?;
    let client = state
        .client
        .lock()
        .await
        .clone()
        .ok_or("Client not connected")?;
    account.validate_client(&client).await?;
    let peer =
        crate::commands::utils::resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;
    let transport = TelegramNameTransport {
        client,
        peer,
        state: state.inner(),
    };
    encrypt(&account, &crypto, db.inner().clone(), folder_id, &transport).await
}

pub trait NameTransport: Sync {
    fn publish<'a>(&'a self, record: &'a str)
        -> futures::future::BoxFuture<'a, Result<(), String>>;
    fn mask(&self, folder: i64) -> futures::future::BoxFuture<'_, Result<(), String>>;
}

pub(crate) struct TelegramNameTransport<'a> {
    pub client: Client,
    pub peer: Peer,
    pub state: &'a crate::commands::TelegramState,
}
impl NameTransport for TelegramNameTransport<'_> {
    fn publish<'a>(
        &'a self,
        record: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<(), String>> {
        Box::pin(publish_name(&self.client, &self.peer, record))
    }
    fn mask(&self, folder: i64) -> futures::future::BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            crate::commands::fs::rename_folder_inner(
                folder,
                "Encrypted [TD-ENCRYPTED]",
                &self.client,
                &self.state.peer_cache,
            )
            .await?;
            Ok(())
        })
    }
}

/// Full name-protection lifecycle; native journeys replace only Telegram I/O.
pub async fn encrypt(
    account: &AccountGuard,
    crypto: &CryptoState,
    db: crate::db::DbConnection,
    folder_id: i64,
    transport: &dyn NameTransport,
) -> Result<Vec<FolderMetadata>, String> {
    let _gate = crate::folder_hierarchy::GATE.lock().await;
    let captured = account.clone();
    let folders = crate::db::with_connection(db.clone(), move |conn| {
        captured.validate()?;
        crate::folder_layout::activate(conn, &captured.root, captured.owner)?;
        crate::commands::folder_groups::enriched_folders(conn)
    })
    .await?;
    let folder = folders
        .iter()
        .find(|f| f.id == folder_id)
        .ok_or("Folder not found")?;
    if folder.is_public {
        return Err(
            "[FOLDER_NAME_PRIVATE_REQUIRED] Make this folder private before encrypting its name."
                .into(),
        );
    }
    let session = crypto
        .current_session()
        .ok_or("[FOLDER_NAME_VAULT_LOCKED] Unlock the vault to encrypt this folder name.")?;
    let record = if protected(&folder.name) {
        // Retrying an interrupted title update must never double-encrypt.
        open(crypto, account.owner, folder_id, &folder.name)?;
        folder.name.clone()
    } else {
        ensure_readable(account, crypto, Some(folder_id))?;
        seal(crypto, account.owner, folder_id, &folder.name)?
    };
    crypto
        .validate_session(session)
        .map_err(|e| e.to_string())?;
    transport.publish(&record).await?;
    account.validate()?;
    // Durable recovery metadata and local protection must exist before masking
    // Telegram. A failed/ambiguous title update remains protected locally and
    // can be safely retried; a database failure never removes the remote name.
    crypto
        .validate_session(session)
        .map_err(|e| e.to_string())?;
    let saved = account.clone();
    let folders = crate::db::with_connection(db, move |conn| {
        crate::folder_hierarchy::transaction(conn, &saved, || {
            persist(conn, folder_id, &record)?;
            crate::commands::folder_groups::enriched_folders(conn)
        })
    })
    .await?;
    crate::api_catalog::invalidate(account.owner);
    crate::local_search::invalidate();
    account.validate()?;
    transport.mask(folder_id).await.map_err(|_| {
        "[FOLDER_NAME_MASK_PENDING] Telegram title update was not confirmed".to_string()
    })?;
    account.validate()?;
    Ok(project(crypto, account.owner, folders))
}

pub fn persist(conn: &sqlite::Connection, folder: i64, record: &str) -> Result<(), String> {
    let mut update = conn
        .prepare("UPDATE folder_metadata SET name=? WHERE channel_id=?")
        .map_err(|e| e.to_string())?;
    update.bind((1, record)).map_err(|e| e.to_string())?;
    update.bind((2, folder)).map_err(|e| e.to_string())?;
    update.next().map_err(|e| e.to_string())?;
    Ok(())
}

/// Caller holds the hierarchy gate. A rename never sends the new plaintext
/// title to Telegram, including when repairing an interrupted initial mask.
pub async fn rename_protected(
    account: &AccountGuard,
    crypto: &CryptoState,
    db: crate::db::DbConnection,
    folder: i64,
    name: &str,
    transport: &dyn NameTransport,
) -> Result<bool, String> {
    ensure_readable(account, crypto, Some(folder))?;
    let session = crypto.current_session().ok_or("[VAULT_LOCKED]")?;
    let record = seal(crypto, account.owner, folder, name)?;
    account.validate()?;
    crypto
        .validate_session(session)
        .map_err(|e| e.to_string())?;
    transport.publish(&record).await?;
    let saved = account.clone();
    crate::db::with_connection(db, move |conn| {
        crate::folder_hierarchy::transaction(conn, &saved, || persist(conn, folder, &record))
    })
    .await?;
    crate::api_catalog::invalidate(account.owner);
    crate::local_search::invalidate();
    account.validate()?;
    transport.mask(folder).await.map_err(|_| {
        "[FOLDER_NAME_MASK_PENDING] Telegram title update was not confirmed".to_string()
    })?;
    account.validate()?;
    Ok(true)
}
