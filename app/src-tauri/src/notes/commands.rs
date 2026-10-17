//! Desktop IPC. Locations are untrusted; identities and protection are always
//! resolved from the authenticated account's actual Telegram media in Rust.
use super::{access, backup, identity, store::Store, Payload, Result};
use crate::{
    commands::{utils::resolve_peer, TelegramState},
    crypto::{secret::SecretBytes, state::CryptoState},
    workspace::AccountGuard,
};
use grammers_client::{
    types::{Media, Message, Peer},
    Client,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Manager, State};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub folder_id: Option<i64>,
    pub message_id: i32,
}
impl Location {
    fn alias(&self) -> Result<String> {
        let alias = format!(
            "{}:{}",
            self.folder_id
                .map_or_else(|| "saved".into(), |v| v.to_string()),
            self.message_id
        );
        if !super::valid_alias(&alias) {
            return Err("NOTES_INVALID".into());
        }
        Ok(alias)
    }
}

async fn resolve(
    app: &tauri::AppHandle,
    account: &AccountGuard,
    client: &Client,
    crypto: &CryptoState,
    location: &Location,
    message: &Message,
    peer: Peer,
    secret: Option<&SecretBytes>,
) -> Result<(String, Option<Vec<u8>>)> {
    let alias = location.alias()?;
    account.validate()?;
    let (fingerprint, header) = if crate::multipart::is_manifest(message.text()) {
        let credential = crypto.current_credential().ok();
        let transport = crate::multipart::telegram::Telegram::operation(
            app,
            account.clone(),
            client.clone(),
            peer,
            location.folder_id,
            crypto,
            credential.as_ref().map(|(session, _)| *session),
        );
        let credentials = crate::multipart::Credentials {
            mode: "auto",
            vault: credential.as_ref().map(|(_, key)| key),
            passphrase: secret,
        };
        crate::multipart::notes_material(
            &transport,
            location.message_id,
            location.folder_id,
            &credentials,
        )
        .await?
    } else {
        let media = message.media().ok_or("NOTES_MISSING")?;
        let Media::Document(document) = &media else {
            return Err("NOTES_UNSUPPORTED".into());
        };
        let envelope = crate::commands::fs::resolve_remote_envelope(
            account,
            client,
            location.folder_id,
            location.message_id,
            &media,
            message.text(),
        )
        .await?;
        if let Some(envelope) = envelope {
            let header = envelope.header_blob.ok_or("NOTES_AUTH")?;
            let parsed = crate::crypto::envelope::EnvelopeHeader::parse(&header)
                .map_err(|_| "NOTES_AUTH")?;
            (
                format!(
                    "protected:{}",
                    uuid::Uuid::from_bytes(parsed.core.file_uuid)
                ),
                Some(header),
            )
        } else {
            (format!("document:{}", document.id()), None)
        }
    };
    Ok((identity::resolve(account, &alias, &fingerprint)?, header))
}

fn locked(error: &str) -> bool {
    [
        "KEY_REQUIRED",
        "VAULT_LOCKED",
        "WRONG_KEY_OR_CORRUPT",
        "NOTES_LOCKED",
    ]
    .iter()
    .any(|code| error.contains(code))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cmd_file_notes(
    app: tauri::AppHandle,
    state: State<'_, TelegramState>,
    owner_id: String,
    action: String,
    locations: Option<Vec<Location>>,
    token: Option<String>,
    text: Option<String>,
    expected: Option<i64>,
    prompt_token: Option<u64>,
) -> Result<Value> {
    let account = AccountGuard::open(
        &app.path().app_data_dir().map_err(|_| "NOTES_STORAGE")?,
        Some(&owner_id),
    )?;
    let crypto = app.state::<CryptoState>();
    if let Some(token) = token {
        let result = match action.as_str() {
            "read" => serde_json::to_value(access::read(&account, &crypto, &token)?),
            "save" => {
                let text = zeroize::Zeroizing::new(text.ok_or("NOTES_INVALID")?);
                serde_json::to_value(access::save(
                    &account,
                    &crypto,
                    &token,
                    &text,
                    expected.ok_or("NOTES_INVALID")?,
                )?)
            }
            "delete" => {
                access::delete(&account, &crypto, &token, expected.ok_or("NOTES_INVALID")?)?;
                Ok(json!({"text":"", "revision":0}))
            }
            _ => return Err("NOTES_INVALID".into()),
        }
        .map_err(|_| "NOTES_INVALID".to_string())?;
        account.validate()?;
        return Ok(result);
    }
    let locations = locations.ok_or("NOTES_INVALID")?;
    if locations.is_empty() || locations.len() > 64 || (action != "read" && locations.len() != 1) {
        return Err("NOTES_LIMIT".into());
    }
    if !matches!(action.as_str(), "read" | "unlock" | "save" | "delete") {
        return Err("NOTES_INVALID".into());
    }
    let client = state.client.lock().await.clone().ok_or("NOTES_REMOTE")?;
    account.validate_client(&client).await?;
    let secret = prompt_token
        .map(|token| crypto.consume_prompt_secret(token))
        .transpose()
        .map_err(|_| "NOTES_LOCKED")?;
    let generation = crypto.notes_generation();
    let mut groups = std::collections::BTreeMap::<Option<i64>, Vec<i32>>::new();
    for location in &locations {
        location.alias()?;
        groups
            .entry(location.folder_id)
            .or_default()
            .push(location.message_id);
    }
    let mut remote = std::collections::HashMap::new();
    for (folder, ids) in groups {
        let peer = resolve_peer(&client, folder, &state.peer_cache).await?;
        let messages = client
            .get_messages_by_id(&peer, &ids)
            .await
            .map_err(|_| "NOTES_REMOTE")?;
        account.validate()?;
        for (id, message) in ids.into_iter().zip(messages) {
            if let Some(message) = message {
                remote.insert((folder, id), (peer.clone(), message));
            }
        }
    }
    let mut output = Vec::with_capacity(locations.len());
    for location in locations {
        let alias = location.alias()?;
        let result: Result<Value> = async {
            let (peer, message) = remote.get(&(location.folder_id, location.message_id)).ok_or("NOTES_MISSING")?;
            let (identity, header) = resolve(&app, &account, &client, &crypto, &location, message, peer.clone(), secret.as_ref()).await?;
            if let Some(header) = header {
                // Plain save/delete requests cannot downgrade an encrypted file.
                if matches!(action.as_str(), "save" | "delete") { return Err("NOTES_LOCKED".into()); }
                let token = access::authorize(&account, &crypto, identity, alias.clone(), header, secret.clone()).await?;
                let readable = access::read(&account, &crypto, &token)?;
                let expires_at = access::expires_at(&account, &crypto, &token)?;
                return Ok(json!({"key":alias,"state":"ready","protected":true,"token":token,"expiresAt":expires_at,"text":readable.text,"revision":readable.revision}));
            }
            let store = Store::open(&account)?;
            let readable = match action.as_str() {
                "save" => Some(super::save_plain(&account, &identity, &alias, text.clone().ok_or("NOTES_INVALID")?, expected.ok_or("NOTES_INVALID")?)?),
                "delete" => { store.delete(&account, &identity, expected.ok_or("NOTES_INVALID")?)?; None },
                _ => store.read(&account, &identity)?,
            };
            let (text, revision) = match readable {
                Some(record) => match record.payload { Payload::Plain {text} => (text, record.revision), _ => return Err("NOTES_PROTECTION".into()) },
                None => (String::new(), 0),
            };
            Ok(json!({"key":alias,"state":"ready","protected":false,"text":text,"revision":revision}))
        }.await;
        account.validate()?;
        match result {
            Ok(value) => output.push(value),
            Err(error) if action == "read" => output.push(json!({"key":alias,"state": if locked(&error) {"locked"} else {"error"},"error": if locked(&error) {"NOTES_LOCKED"} else {"NOTES_UNAVAILABLE"}})),
            Err(error) => return Err(error),
        }
    }
    account.validate()?;
    if generation != crypto.notes_generation() {
        use zeroize::Zeroize;
        for value in &mut output {
            if let Some(Value::String(text)) = value.get_mut("text") {
                text.zeroize();
            }
        }
        return Err("NOTES_LOCKED".into());
    }
    Ok(json!(output))
}

struct PendingImport {
    account: AccountGuard,
    backup: backup::Backup,
    expires: std::time::Instant,
}
static IMPORTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, PendingImport>>,
> = std::sync::LazyLock::new(Default::default);

#[tauri::command]
pub async fn cmd_notes_backup(
    app: tauri::AppHandle,
    owner_id: String,
    action: String,
    preview_token: Option<String>,
    policy: Option<String>,
) -> Result<Value> {
    use tauri_plugin_opener::OpenerExt;
    let account = AccountGuard::open(
        &app.path().app_data_dir().map_err(|_| "NOTES_STORAGE")?,
        Some(&owner_id),
    )?;
    if action == "open" {
        let store = Store::open(&account)?;
        app.opener()
            .open_path(store.root.to_string_lossy(), None::<&str>)
            .map_err(|_| "NOTES_STORAGE")?;
        return Ok(json!(true));
    }
    tokio::task::spawn_blocking(move || -> Result<Value> {
        if action == "info" {
            return Ok(json!({"path":Store::open(&account)?.root}));
        }
        if action == "cancel" {
            let mut pending = IMPORTS.lock().map_err(|_| "NOTES_STORAGE")?;
            if let Some(token) = preview_token {
                if pending.get(&token).is_some_and(|item| {
                    item.account.owner == account.owner && item.account.root == account.root
                }) {
                    pending.remove(&token);
                }
            }
            return Ok(Value::Null);
        }
        if action == "export" {
            let Some(path) = rfd::FileDialog::new()
                .set_file_name("video-notes.tdnotes.json")
                .save_file()
            else {
                return Ok(Value::Null);
            };
            account.validate()?;
            backup::write_file(&account, &path)?;
            return Ok(json!(true));
        }
        if action == "preview" {
            let Some(path) = rfd::FileDialog::new().pick_file() else {
                return Ok(Value::Null);
            };
            account.validate()?;
            let backup = backup::read_file(&path, account.owner)?;
            let store = Store::open(&account)?;
            let mut conflicts = 0;
            for record in &backup.records {
                if store.read(&account, &record.identity)?.is_some() {
                    conflicts += 1;
                }
            }
            let token = uuid::Uuid::new_v4().to_string();
            let result =
                json!({"token":token,"records":backup.records.len(),"conflicts":conflicts});
            let mut pending = IMPORTS.lock().map_err(|_| "NOTES_STORAGE")?;
            pending.retain(|_, item| {
                item.expires > std::time::Instant::now()
                    && item.account.validate().is_ok()
                    && !(item.account.owner == account.owner && item.account.root == account.root)
            });
            if pending.len() >= 4 {
                return Err("NOTES_LIMIT".into());
            }
            pending.insert(
                token,
                PendingImport {
                    account: account.clone(),
                    backup,
                    expires: std::time::Instant::now() + std::time::Duration::from_secs(300),
                },
            );
            return Ok(result);
        }
        if action == "import" {
            let item = IMPORTS
                .lock()
                .map_err(|_| "NOTES_STORAGE")?
                .remove(&preview_token.ok_or("NOTES_INVALID")?)
                .ok_or("NOTES_INVALID")?;
            item.account.validate()?;
            if item.account.owner != account.owner
                || item.account.root != account.root
                || item.expires <= std::time::Instant::now()
            {
                return Err("ACCOUNT_CHANGED".into());
            }
            return serde_json::to_value(backup::import(
                &account,
                item.backup,
                policy.as_deref().ok_or("NOTES_INVALID")?,
            )?)
            .map_err(|_| "NOTES_INVALID".into());
        }
        Err("NOTES_INVALID".into())
    })
    .await
    .map_err(|_| "NOTES_STORAGE".to_string())?
}
