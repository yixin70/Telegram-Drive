//! Channel identities never change. Only this minimal, append-only placement log
//! travels between devices. No names, secrets, file metadata or bytes are copied.
use crate::{
    commands::TelegramState, db::DbConnection, models::FolderMetadata, workspace::AccountGuard,
};
use grammers_client::{types::InputMessage, Client};
use serde::{Deserialize, Serialize};
use sqlite::{Connection, State};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::{Manager, State as TauriState};

pub const PREFIX: &str = "TDHIERARCHY:";
pub(crate) static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    version: u8,
    owner: i64,
    id: String,
    clock: i64,
    base: i64,
    folder: i64,
    parent: Option<i64>,
    order: i32,
    deleted: bool,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub folders: Vec<FolderMetadata>,
    pub pending: usize,
    pub conflicts: usize,
    pub needs_scan: bool,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(crate) fn transaction<T>(
    conn: &Connection,
    account: &AccountGuard,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    account.validate()?;
    crate::folder_layout::activate(conn, &account.root, account.owner)?;
    conn.execute("BEGIN IMMEDIATE").map_err(err)?;
    let result = action().and_then(|value| {
        account.validate()?;
        Ok(value)
    });
    match result {
        Ok(value) => {
            if let Err(error) = conn.execute("COMMIT") {
                let _ = conn.execute("ROLLBACK");
                return Err(err(error));
            }
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute("ROLLBACK");
            Err(error)
        }
    }
}

fn operations(conn: &Connection, owner: i64) -> Result<Vec<(Operation, bool)>, String> {
    let mut query = conn
        .prepare("SELECT payload,published FROM folder_hierarchy_ops WHERE owner=?")
        .map_err(err)?;
    query.bind((1, owner)).map_err(err)?;
    let mut result = Vec::new();
    while query.next().map_err(err)? == State::Row {
        let op = serde_json::from_str(&query.read::<String, _>(0).map_err(err)?).map_err(err)?;
        result.push((op, query.read::<i64, _>(1).map_err(err)? != 0));
    }
    Ok(result)
}

fn put(conn: &Connection, op: &Operation, published: bool) -> Result<(), String> {
    let payload = serde_json::to_string(op).map_err(err)?;
    let mut insert = conn.prepare("INSERT INTO folder_hierarchy_ops(owner,op_id,payload,published) VALUES(?,?,?,?) ON CONFLICT(owner,op_id) DO UPDATE SET published=MAX(published,excluded.published)").map_err(err)?;
    insert.bind((1, op.owner)).map_err(err)?;
    insert.bind((2, op.id.as_str())).map_err(err)?;
    insert.bind((3, payload.as_str())).map_err(err)?;
    insert.bind((4, i64::from(published))).map_err(err)?;
    insert.next().map_err(err)?;
    Ok(())
}

fn queue(
    conn: &Connection,
    owner: i64,
    folder: i64,
    parent: Option<i64>,
    order: i32,
    deleted: bool,
) -> Result<(), String> {
    let base = operations(conn, owner)?
        .iter()
        .map(|(op, _)| op.clock)
        .max()
        .unwrap_or(0);
    let clock = base
        .checked_add(1)
        .ok_or("Folder hierarchy clock exhausted")?;
    put(
        conn,
        &Operation {
            version: 1,
            owner,
            id: uuid::Uuid::new_v4().to_string(),
            clock,
            base,
            folder,
            parent,
            order,
            deleted,
        },
        false,
    )
}

pub(crate) fn check_parent(
    conn: &Connection,
    folder: i64,
    parent: Option<i64>,
) -> Result<(), String> {
    let folders = crate::commands::folder_groups::enriched_folders(conn)?;
    let map: HashMap<_, _> = folders.iter().map(|f| (f.id, f.parent_id)).collect();
    let mut cursor = parent;
    let mut visited = HashSet::new();
    while let Some(id) = cursor {
        if id == folder || !visited.insert(id) {
            return Err("HIERARCHY_CYCLE: Choose a destination outside this folder".into());
        }
        cursor = *map
            .get(&id)
            .ok_or("HIERARCHY_PARENT_MISSING: Refresh folders before choosing this destination")?;
    }
    Ok(())
}

pub(crate) fn ensure_leaf(conn: &Connection, folder: i64) -> Result<(), String> {
    let mut query = conn
        .prepare("SELECT 1 FROM folder_metadata WHERE parent_id=? LIMIT 1")
        .map_err(err)?;
    query.bind((1, folder)).map_err(err)?;
    if query.next().map_err(err)? == State::Row {
        return Err(
            "HIERARCHY_HAS_CHILDREN: Move child folders before deleting this channel".into(),
        );
    }
    Ok(())
}

/// Replay from roots, never from a previous projection. Total order is causal
/// Lamport order plus a random operation-ID tie break, independent of clocks.
fn project(conn: &Connection, owner: i64) -> Result<Snapshot, String> {
    let folders = crate::commands::folder_groups::enriched_folders(conn)?;
    let known: HashSet<_> = folders.iter().map(|f| f.id).collect();
    let mut ops = operations(conn, owner)?;
    let pending = ops.iter().filter(|(_, published)| !published).count();
    ops.sort_by(|(a, _), (b, _)| (a.clock, &a.id).cmp(&(b.clock, &b.id)));
    let deleted: HashSet<_> = ops
        .iter()
        .filter(|(op, _)| op.deleted)
        .map(|(op, _)| op.folder)
        .collect();
    let mut parents = HashMap::<i64, Option<i64>>::new();
    let mut orders = HashMap::new();
    let mut revisions = HashMap::new();
    let mut conflicts = 0;
    for (op, _) in &ops {
        if op.deleted || deleted.contains(&op.folder) {
            continue;
        }
        if revisions
            .get(&op.folder)
            .is_some_and(|clock| *clock > op.base)
        {
            conflicts += 1;
        }
        revisions.insert(op.folder, op.clock);
        let mut parent = op.parent.filter(|id| !deleted.contains(id));
        if parent != op.parent {
            conflicts += 1;
        }
        let mut cursor = parent;
        let mut seen = HashSet::new();
        while let Some(id) = cursor {
            if id == op.folder || !seen.insert(id) {
                parent = None;
                conflicts += 1;
                break;
            }
            cursor = parents.get(&id).copied().flatten();
        }
        parents.insert(op.folder, parent);
        orders.insert(op.folder, op.order);
    }
    let needs_scan = ops
        .iter()
        .any(|(op, _)| !op.deleted && !deleted.contains(&op.folder) && !known.contains(&op.folder));
    for folder in folders {
        // A tombstone hides a removed channel, but replay NEVER deletes Telegram data.
        // A later complete scan reconciles the cached inventory.
        if deleted.contains(&folder.id) {
            let mut remove = conn
                .prepare("DELETE FROM folder_metadata WHERE channel_id=?")
                .map_err(err)?;
            remove.bind((1, folder.id)).map_err(err)?;
            remove.next().map_err(err)?;
            continue;
        }
        let requested_parent = parents.get(&folder.id).copied().flatten();
        let parent = requested_parent.filter(|id| known.contains(id));
        if parent != requested_parent {
            conflicts += 1;
        }
        let order = orders
            .get(&folder.id)
            .copied()
            .unwrap_or(folder.display_order);
        let mut update = conn
            .prepare("UPDATE folder_metadata SET parent_id=?,display_order=? WHERE channel_id=?")
            .map_err(err)?;
        update.bind((1, parent)).map_err(err)?;
        update.bind((2, i64::from(order))).map_err(err)?;
        update.bind((3, folder.id)).map_err(err)?;
        update.next().map_err(err)?;
    }
    Ok(Snapshot {
        folders: crate::commands::folder_groups::enriched_folders(conn)?,
        pending,
        conflicts,
        needs_scan,
    })
}

pub(crate) fn move_at(
    conn: &Connection,
    account: &AccountGuard,
    folder: i64,
    parent: Option<i64>,
    order: i32,
) -> Result<Snapshot, String> {
    transaction(conn, account, || {
        let folders = crate::commands::folder_groups::enriched_folders(conn)?;
        if !folders.iter().any(|f| f.id == folder) {
            return Err("Folder not found".into());
        }
        check_parent(conn, folder, parent)?;
        queue(conn, account.owner, folder, parent, order, false)?;
        project(conn, account.owner)
    })
}

pub(crate) fn created_at(
    conn: &Connection,
    account: &AccountGuard,
    folder: &FolderMetadata,
    parent: Option<i64>,
) -> Result<Snapshot, String> {
    transaction(conn, account, || {
        // Persist a remotely created channel even if its original parent vanished.
        let parent = parent.filter(|id| check_parent(conn, folder.id, Some(*id)).is_ok());
        let mut insert = conn.prepare("INSERT OR IGNORE INTO folder_metadata(channel_id,name,username,is_public,display_order,parent_id) VALUES(?,?,?,?,?,?)").map_err(err)?;
        insert.bind((1, folder.id)).map_err(err)?;
        insert.bind((2, folder.name.as_str())).map_err(err)?;
        insert.bind((3, folder.username.as_deref())).map_err(err)?;
        insert.bind((4, i64::from(folder.is_public))).map_err(err)?;
        insert
            .bind((5, i64::from(folder.display_order)))
            .map_err(err)?;
        insert.bind((6, parent)).map_err(err)?;
        insert.next().map_err(err)?;
        queue(
            conn,
            account.owner,
            folder.id,
            parent,
            folder.display_order,
            false,
        )?;
        project(conn, account.owner)
    })
}

pub(crate) fn deleted_at(
    conn: &Connection,
    account: &AccountGuard,
    folder: i64,
) -> Result<(), String> {
    transaction(conn, account, || {
        queue(conn, account.owner, folder, None, 0, true)?;
        let mut delete = conn
            .prepare("DELETE FROM folder_metadata WHERE channel_id=?")
            .map_err(err)?;
        delete.bind((1, folder)).map_err(err)?;
        delete.next().map_err(err)?;
        project(conn, account.owner)?;
        Ok(())
    })
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Placement {
    folder: i64,
    parent: Option<i64>,
    order: i32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    version: u8,
    owner: i64,
    placements: Vec<Placement>,
    operations: Vec<Operation>,
}

pub(crate) fn export_at(conn: &Connection, account: &AccountGuard) -> Result<String, String> {
    transaction(conn, account, || {
        let placements = crate::commands::folder_groups::enriched_folders(conn)?
            .into_iter()
            .map(|f| Placement {
                folder: f.id,
                parent: f.parent_id,
                order: f.display_order,
            })
            .collect();
        let operations = operations(conn, account.owner)?
            .into_iter()
            .map(|(op, _)| op)
            .collect();
        serde_json::to_string_pretty(&Backup {
            version: 1,
            owner: account.owner,
            placements,
            operations,
        })
        .map_err(err)
    })
}

/// Validation and preview share the same transaction as apply. Import is an
/// explicit merge/repair through the outbox, never a blind whole-tree replacement.
pub(crate) fn import_at(
    conn: &Connection,
    account: &AccountGuard,
    body: &str,
    apply: bool,
) -> Result<Snapshot, String> {
    if body.len() > 16 * 1024 * 1024 {
        return Err("Hierarchy backup exceeds 16 MiB".into());
    }
    let backup: Backup = serde_json::from_str(body).map_err(err)?;
    if backup.version != 1 || backup.owner != account.owner {
        return Err("Backup version or account does not match".into());
    }
    transaction(conn, account, || {
        let local = operations(conn, account.owner)?;
        let mut by_id: HashMap<_, _> = local
            .iter()
            .map(|(op, _)| (op.id.clone(), op.clone()))
            .collect();
        let validated = decode(
            backup
                .operations
                .iter()
                .map(|op| format!("{PREFIX}{}", serde_json::to_string(op).unwrap()))
                .collect(),
            account.owner,
        )?;
        for op in validated.values() {
            if by_id.get(&op.id).is_some_and(|previous| previous != op) {
                return Err("Backup operation identity collision".into());
            }
            by_id.insert(op.id.clone(), op.clone());
        }
        let deleted: HashSet<_> = by_id
            .values()
            .filter(|op| op.deleted)
            .map(|op| op.folder)
            .collect();
        let folders = crate::commands::folder_groups::enriched_folders(conn)?;
        let mut parents: HashMap<_, _> = folders.iter().map(|f| (f.id, f.parent_id)).collect();
        let known: HashSet<_> = parents.keys().copied().collect();
        let mut seen = HashSet::new();
        for p in &backup.placements {
            if !seen.insert(p.folder)
                || !known.contains(&p.folder)
                || deleted.contains(&p.folder)
                || p.parent
                    .is_some_and(|id| !known.contains(&id) || deleted.contains(&id))
            {
                return Err("Backup contains duplicate, missing or deleted folders; refresh before restoring".into());
            }
            parents.insert(p.folder, p.parent);
        }
        for id in parents.keys() {
            let mut cursor = Some(*id);
            let mut visited = HashSet::new();
            while let Some(id) = cursor {
                if !visited.insert(id) {
                    return Err("HIERARCHY_CYCLE: Backup contains a folder cycle".into());
                }
                cursor = parents.get(&id).copied().flatten();
            }
        }
        // Preview must replay imported tombstones and conflict resolution too,
        // not just overlay the requested placements onto the cached inventory.
        // Use the actual apply path, but roll back all preview writes.
        if !apply {
            conn.execute("SAVEPOINT hierarchy_preview").map_err(err)?;
        }
        let placement_count = backup.placements.len();
        for op in validated.values() {
            put(conn, op, false)?;
        }
        // Explicit repair republishes identical immutable IDs, including records
        // the user removed in Saved Messages. Newer local operations are retained.
        let mut repair = conn
            .prepare("UPDATE folder_hierarchy_ops SET published=0 WHERE owner=?")
            .map_err(err)?;
        repair.bind((1, account.owner)).map_err(err)?;
        repair.next().map_err(err)?;
        // Detach the restored nodes first: a valid final tree must not be
        // rejected because an intermediate edge still exists in the old tree.
        for p in &backup.placements {
            queue(conn, account.owner, p.folder, None, p.order, false)?;
        }
        for p in backup.placements {
            queue(conn, account.owner, p.folder, p.parent, p.order, false)?;
        }
        let mut snapshot = project(conn, account.owner)?;
        if !apply {
            conn.execute("ROLLBACK TO hierarchy_preview; RELEASE hierarchy_preview")
                .map_err(err)?;
            snapshot.pending = placement_count;
        }
        Ok(snapshot)
    })
}

#[tauri::command]
pub async fn cmd_folder_hierarchy_backup(
    app: tauri::AppHandle,
    owner_id: String,
    body: Option<String>,
    apply: Option<bool>,
    path: Option<String>,
    db: TauriState<'_, DbConnection>,
) -> Result<serde_json::Value, String> {
    let account = AccountGuard::open(&app.path().app_data_dir().map_err(err)?, Some(&owner_id))?;
    let _gate = GATE.lock().await;
    crate::db::with_connection(db.inner().clone(), move |conn| {
        if let Some(body) = body {
            return serde_json::to_value(import_at(conn, &account, &body, apply.unwrap_or(false))?)
                .map_err(err);
        }
        let body = export_at(conn, &account)?;
        if let Some(path) = path {
            use std::io::Write;
            account.validate()?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(path).map_err(err)?;
            file.write_all(body.as_bytes()).map_err(err)?;
            file.sync_all().map_err(err)?;
        }
        Ok(serde_json::Value::String(body))
    })
    .await
}

/// The transport must return a complete paginated history, or an error. A
/// partial pull is never authoritative. Kept generic for process E2E fixtures.
pub(crate) trait Transport {
    async fn read(&self) -> Result<Vec<String>, String>;
    async fn publish(&self, payload: String) -> Result<(), String>;
}

struct TelegramTransport<'a> {
    account: &'a AccountGuard,
    client: &'a Client,
    peer: grammers_client::types::Peer,
}
impl Transport for TelegramTransport<'_> {
    async fn read(&self) -> Result<Vec<String>, String> {
        // Telegram server-side search paginates beyond busy Saved Messages;
        // there is deliberately no fixed recent-message or result-count cap.
        let mut messages = self.client.search_messages(&self.peer).query("TDHIERARCHY");
        let mut found = Vec::new();
        while let Some(message) = messages.next().await.map_err(err)? {
            self.account.validate()?;
            if message.text().starts_with(PREFIX) {
                found.push(message.text().to_string());
            }
        }
        Ok(found)
    }
    async fn publish(&self, payload: String) -> Result<(), String> {
        self.account.validate()?;
        self.client
            .send_message(&self.peer, InputMessage::new().text(payload))
            .await
            .map_err(err)?;
        self.account.validate()
    }
}

fn decode(messages: Vec<String>, owner: i64) -> Result<BTreeMap<String, Operation>, String> {
    let mut result = BTreeMap::new();
    for message in messages {
        let body = message
            .strip_prefix(PREFIX)
            .ok_or("Invalid hierarchy record")?;
        let op: Operation = serde_json::from_str(body).map_err(|_| "HIERARCHY_RECOVERY: Invalid or unsupported remote metadata; cached folders were preserved")?;
        if op.version != 1
            || op.owner != owner
            || op.folder <= 0
            || op.parent.is_some_and(|id| id <= 0)
            || op.clock <= op.base
            || op.base < 0
            || uuid::Uuid::parse_str(&op.id).is_err()
        {
            return Err(
                "HIERARCHY_RECOVERY: Unsupported remote metadata; cached folders were preserved"
                    .into(),
            );
        }
        if let Some(previous) = result.insert(op.id.clone(), op.clone()) {
            if previous != op {
                return Err("HIERARCHY_RECOVERY: Conflicting operation identity".into());
            }
        }
    }
    Ok(result)
}

fn accept(
    conn: &Connection,
    account: &AccountGuard,
    remote: &BTreeMap<String, Operation>,
) -> Result<Snapshot, String> {
    transaction(conn, account, || {
        let local = operations(conn, account.owner)?;
        for (op, published) in &local {
            if let Some(found) = remote.get(&op.id) {
                if found != op {
                    return Err(
                        "HIERARCHY_RECOVERY: Changed remote operation; cached tree preserved"
                            .into(),
                    );
                }
            } else if *published {
                return Err("HIERARCHY_RECOVERY: Remote history is missing; cached tree and pending edits were preserved. Restore the missing Saved Messages records before retrying.".into());
            }
        }
        for op in remote.values() {
            put(conn, op, true)?;
        }
        // Migrate pre-feature sibling ordering without overriding any remote move.
        let recorded: HashSet<_> = operations(conn, account.owner)?
            .iter()
            .map(|(op, _)| op.folder)
            .collect();
        for folder in crate::commands::folder_groups::enriched_folders(conn)? {
            if !recorded.contains(&folder.id) {
                queue(
                    conn,
                    account.owner,
                    folder.id,
                    folder.parent_id,
                    folder.display_order,
                    false,
                )?;
            }
        }
        project(conn, account.owner)
    })
}

pub(crate) async fn synchronize(
    account: &AccountGuard,
    db: DbConnection,
    transport: &impl Transport,
) -> Result<Snapshot, String> {
    account.validate()?;
    let remote = decode(transport.read().await?, account.owner)?;
    let captured = account.clone();
    crate::db::with_connection(db.clone(), move |conn| accept(conn, &captured, &remote)).await?;
    let captured = account.clone();
    let pending = crate::db::with_connection(db.clone(), move |conn| {
        captured.validate()?;
        operations(conn, captured.owner)
    })
    .await?;
    for (op, published) in pending {
        if !published {
            transport
                .publish(format!(
                    "{PREFIX}{}",
                    serde_json::to_string(&op).map_err(err)?
                ))
                .await?;
        }
    }
    // Confirmation, not send success, is the durability boundary. A lost send
    // reply is deduplicated by operation ID on the next pull before any retry.
    let remote = decode(transport.read().await?, account.owner)?;
    let captured = account.clone();
    crate::db::with_connection(db, move |conn| accept(conn, &captured, &remote)).await
}

pub(crate) async fn sync_locked(
    account: &AccountGuard,
    db: DbConnection,
    state: &TelegramState,
) -> Result<Snapshot, String> {
    let client = state
        .client
        .lock()
        .await
        .clone()
        .ok_or("Client not connected")?;
    account.validate_client(&client).await?;
    let peer = crate::commands::utils::resolve_peer(&client, None, &state.peer_cache).await?;
    let transport = TelegramTransport {
        account,
        client: &client,
        peer,
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(90),
        synchronize(account, db, &transport),
    )
    .await
    .map_err(|_| "Hierarchy sync timed out; pending edits are retained".to_string())?
}

#[tauri::command]
pub async fn cmd_sync_folder_hierarchy(
    app: tauri::AppHandle,
    owner_id: String,
    state: TauriState<'_, TelegramState>,
    db: TauriState<'_, DbConnection>,
) -> Result<Snapshot, String> {
    let account = AccountGuard::open(&app.path().app_data_dir().map_err(err)?, Some(&owner_id))?;
    let _gate = GATE.lock().await;
    let mut snapshot = sync_locked(&account, db.inner().clone(), state.inner()).await?;
    snapshot.folders =
        crate::folder_names::project_app(&app, Some(account.owner), snapshot.folders)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn cmd_move_folder(
    app: tauri::AppHandle,
    owner_id: String,
    folder_id: i64,
    parent_id: Option<i64>,
    display_order: i32,
    db: TauriState<'_, DbConnection>,
) -> Result<Snapshot, String> {
    let account = AccountGuard::open(&app.path().app_data_dir().map_err(err)?, Some(&owner_id))?;
    let _gate = GATE.lock().await;
    let owner = account.owner;
    let crypto = app.state::<crate::crypto::state::CryptoState>();
    crate::folder_names::ensure_readable(&account, &crypto, Some(folder_id))?;
    crate::folder_names::ensure_readable(&account, &crypto, parent_id)?;
    let mut snapshot = crate::db::with_connection(db.inner().clone(), move |conn| {
        move_at(conn, &account, folder_id, parent_id, display_order)
    })
    .await?;
    snapshot.folders = crate::folder_names::project_app(&app, Some(owner), snapshot.folders)?;
    Ok(snapshot)
}
