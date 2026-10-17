use super::{Record, Result};
use crate::workspace::AccountGuard;
use sqlite::{Connection, State, Value};
use std::path::PathBuf;

pub struct Store {
    db: Connection,
    pub root: PathBuf,
}

fn database_version(db: &Connection) -> Result<i64> {
    let mut query = db
        .prepare("PRAGMA user_version")
        .map_err(|_| "NOTES_STORAGE")?;
    query.next().map_err(|_| "NOTES_STORAGE")?;
    query.read::<i64, _>(0).map_err(|_| "NOTES_STORAGE".into())
}

impl Store {
    pub fn open(account: &AccountGuard) -> Result<Self> {
        account.validate()?;
        let root = account.root.join("notes");
        std::fs::create_dir_all(&root).map_err(|_| "NOTES_STORAGE")?;
        let mut db = sqlite::open(root.join("notes.db")).map_err(|_| "NOTES_STORAGE")?;
        db.set_busy_timeout(5000).map_err(|_| "NOTES_STORAGE")?;
        let version = database_version(&db)?;
        // Refuse future databases before changing any persistent PRAGMA.
        if !(0..=1).contains(&version) {
            return Err("NOTES_VERSION".into());
        }
        if version == 0 {
            // Reserve schema creation across processes, then reread the version:
            // another first-use connection may have finished while we waited.
            db.execute("BEGIN IMMEDIATE").map_err(|_| "NOTES_STORAGE")?;
            let initialize = (|| -> Result<()> {
                match database_version(&db)? {
                    1 => return Ok(()),
                    0 => {}
                    _ => return Err("NOTES_VERSION".into()),
                }
                let mut schema = db
                    .prepare("SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
                    .map_err(|_| "NOTES_STORAGE")?;
                schema.next().map_err(|_| "NOTES_STORAGE")?;
                if schema.read::<i64, _>(0).map_err(|_| "NOTES_STORAGE")? != 0 {
                    return Err("NOTES_VERSION".into());
                }
                drop(schema);
                db.execute("CREATE TABLE notes (owner TEXT NOT NULL, identity TEXT NOT NULL, id TEXT NOT NULL,
                    record TEXT NOT NULL, PRIMARY KEY(owner,identity), UNIQUE(owner,id));
                CREATE TABLE aliases (owner TEXT NOT NULL, alias TEXT NOT NULL, identity TEXT NOT NULL,
                    PRIMARY KEY(owner,alias), FOREIGN KEY(owner,identity) REFERENCES notes(owner,identity) ON DELETE CASCADE);
                CREATE TABLE moves (owner TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
                    identity TEXT NOT NULL, PRIMARY KEY(owner,source,target));
                PRAGMA user_version=1;").map_err(|_| "NOTES_STORAGE")?;
                Ok(())
            })();
            if let Err(error) =
                initialize.and_then(|()| db.execute("COMMIT").map_err(|_| "NOTES_STORAGE".into()))
            {
                let _ = db.execute("ROLLBACK");
                return Err(error);
            }
        }
        db.execute("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;")
            .map_err(|_| "NOTES_STORAGE")?;
        account.validate()?;
        Ok(Self { db, root })
    }

    pub fn transaction<T>(
        &self,
        account: &AccountGuard,
        action: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        account.validate()?;
        self.db
            .execute("BEGIN IMMEDIATE")
            .map_err(|_| "NOTES_STORAGE")?;
        struct Rollback<'a>(&'a Connection);
        impl Drop for Rollback<'_> {
            fn drop(&mut self) {
                let _ = self.0.execute("ROLLBACK");
            }
        }
        let _rollback = Rollback(&self.db);
        let value = action()?;
        account.validate()?;
        self.db.execute("COMMIT").map_err(|_| "NOTES_STORAGE")?;
        Ok(value)
    }

    fn execute(&self, sql: &str, args: &[Value]) -> Result<()> {
        let mut query = self.db.prepare(sql).map_err(|_| "NOTES_STORAGE")?;
        query.bind(args).map_err(|_| "NOTES_STORAGE")?;
        query.next().map_err(|_| "NOTES_STORAGE")?;
        Ok(())
    }

    pub fn read(&self, account: &AccountGuard, identity: &str) -> Result<Option<Record>> {
        account.validate()?;
        let mut query = self
            .db
            .prepare("SELECT record FROM notes WHERE owner=? AND identity=?")
            .map_err(|_| "NOTES_STORAGE")?;
        query
            .bind(
                &[
                    Value::String(account.owner.to_string()),
                    Value::String(identity.into()),
                ][..],
            )
            .map_err(|_| "NOTES_STORAGE")?;
        let result = if query.next().map_err(|_| "NOTES_STORAGE")? == State::Row {
            let record: Record =
                serde_json::from_str(&query.read::<String, _>(0).map_err(|_| "NOTES_STORAGE")?)
                    .map_err(|_| "NOTES_INVALID")?;
            record.validate(account.owner)?;
            Some(record)
        } else {
            None
        };
        account.validate()?;
        Ok(result)
    }

    pub fn list(&self, account: &AccountGuard) -> Result<Vec<Record>> {
        account.validate()?;
        let mut query = self
            .db
            .prepare("SELECT record FROM notes WHERE owner=? ORDER BY id")
            .map_err(|_| "NOTES_STORAGE")?;
        query
            .bind((1, account.owner.to_string().as_str()))
            .map_err(|_| "NOTES_STORAGE")?;
        let mut records = Vec::new();
        while query.next().map_err(|_| "NOTES_STORAGE")? == State::Row {
            if records.len() >= super::MAX_RECORDS {
                return Err("NOTES_LIMIT".into());
            }
            let record: Record =
                serde_json::from_str(&query.read::<String, _>(0).map_err(|_| "NOTES_STORAGE")?)
                    .map_err(|_| "NOTES_INVALID")?;
            record.validate(account.owner)?;
            records.push(record);
        }
        account.validate()?;
        Ok(records)
    }

    pub(super) fn put(&self, account: &AccountGuard, record: &Record) -> Result<()> {
        account.validate()?;
        record.validate(account.owner)?;
        let owner = Value::String(record.owner.clone());
        let identity = Value::String(record.identity.clone());
        let encoded = serde_json::to_string(record).map_err(|_| "NOTES_INVALID")?;
        let mut usage = self.db.prepare("SELECT COUNT(*), COALESCE(SUM(length(CAST(record AS BLOB))),0) FROM notes WHERE owner=? AND identity<>?")
            .map_err(|_| "NOTES_STORAGE")?;
        usage
            .bind(&[owner.clone(), identity.clone()][..])
            .map_err(|_| "NOTES_STORAGE")?;
        usage.next().map_err(|_| "NOTES_STORAGE")?;
        let count = usage.read::<i64, _>(0).map_err(|_| "NOTES_STORAGE")?;
        let bytes = usage.read::<i64, _>(1).map_err(|_| "NOTES_STORAGE")?;
        // Include JSON separators and a bounded allowance for the envelope.
        // Every successful save must remain exportable in one supported backup.
        if count >= super::MAX_RECORDS as i64
            || bytes + encoded.len() as i64 + count + 1024 > super::MAX_BACKUP as i64
        {
            return Err("NOTES_LIMIT".into());
        }
        drop(usage);
        self.execute("INSERT INTO notes(owner,identity,id,record) VALUES(?,?,?,?) ON CONFLICT(owner,identity) DO UPDATE SET id=excluded.id,record=excluded.record",
            &[owner.clone(), identity.clone(), Value::String(record.id.clone()), Value::String(encoded)])?;
        self.execute(
            "DELETE FROM aliases WHERE owner=? AND identity=?",
            &[owner.clone(), identity.clone()],
        )?;
        for alias in &record.aliases {
            self.execute(
                "INSERT INTO aliases(owner,alias,identity) VALUES(?,?,?)",
                &[
                    owner.clone(),
                    Value::String(alias.clone()),
                    identity.clone(),
                ],
            )?;
        }
        Ok(())
    }

    /// Called inside a save transaction after native media verification. Keep
    /// replaced attachments' text recoverable, but never attach it to new media.
    pub(super) fn release_alias(
        &self,
        account: &AccountGuard,
        alias: &str,
        identity: &str,
    ) -> Result<()> {
        if let Some(mut previous) = self.by_alias(account, alias)? {
            if previous.identity != identity {
                previous.aliases.retain(|old| old != alias);
                previous.revision = previous.revision.checked_add(1).ok_or("NOTES_LIMIT")?;
                previous.updated_at = super::now().max(previous.updated_at);
                self.put(account, &previous)?;
            }
        }
        Ok(())
    }

    pub fn by_alias(&self, account: &AccountGuard, alias: &str) -> Result<Option<Record>> {
        account.validate()?;
        let mut query = self
            .db
            .prepare("SELECT identity FROM aliases WHERE owner=? AND alias=?")
            .map_err(|_| "NOTES_STORAGE")?;
        query
            .bind(
                &[
                    Value::String(account.owner.to_string()),
                    Value::String(alias.into()),
                ][..],
            )
            .map_err(|_| "NOTES_STORAGE")?;
        let identity = if query.next().map_err(|_| "NOTES_STORAGE")? == State::Row {
            Some(query.read::<String, _>(0).map_err(|_| "NOTES_STORAGE")?)
        } else {
            None
        };
        drop(query);
        identity
            .map(|identity| self.read(account, &identity))
            .transpose()
            .map(Option::flatten)
    }

    pub fn prepare_move(
        &self,
        account: &AccountGuard,
        source: &str,
        target_folder: &str,
    ) -> Result<()> {
        if !super::valid_alias(source) || !super::valid_folder(target_folder) {
            return Err("NOTES_INVALID".into());
        }
        self.transaction(account, || {
            if let Some(record) = self.by_alias(account, source)? {
                self.execute(
                    "INSERT OR IGNORE INTO moves VALUES(?,?,?,?)",
                    &[
                        Value::String(account.owner.to_string()),
                        Value::String(source.into()),
                        Value::String(target_folder.into()),
                        Value::String(record.identity),
                    ],
                )?;
            }
            Ok(())
        })
    }

    /// Call only after verifying the forwarded destination's media identity,
    /// before deleting the source. A crash can leave both aliases, never no alias.
    pub fn finish_move(
        &self,
        account: &AccountGuard,
        source: &str,
        target: &str,
        identity: &str,
    ) -> Result<()> {
        if !super::valid_alias(source) || !super::valid_alias(target) {
            return Err("NOTES_INVALID".into());
        }
        self.transaction(account, || {
            let Some(mut record) = self.by_alias(account, source)? else {
                return Ok(());
            };
            if record.identity != identity {
                return Err("NOTES_IDENTITY".into());
            }
            let target_folder = target.split_once(':').ok_or("NOTES_INVALID")?.0;
            let mut query = self
                .db
                .prepare("SELECT identity FROM moves WHERE owner=? AND source=? AND target=?")
                .map_err(|_| "NOTES_STORAGE")?;
            query
                .bind(
                    &[
                        Value::String(account.owner.to_string()),
                        Value::String(source.into()),
                        Value::String(target_folder.into()),
                    ][..],
                )
                .map_err(|_| "NOTES_STORAGE")?;
            let pending = if query.next().map_err(|_| "NOTES_STORAGE")? == State::Row {
                Some(query.read::<String, _>(0).map_err(|_| "NOTES_STORAGE")?)
            } else {
                None
            };
            drop(query);
            match pending {
                Some(pending) if pending != identity => return Err("NOTES_IDENTITY".into()),
                None => {
                    // An acknowledged move may be replayed after a crash. Only
                    // an already-committed, same-note destination is a no-op.
                    return if record.aliases.iter().any(|alias| alias == target)
                        && self
                            .by_alias(account, target)?
                            .is_some_and(|other| other.id == record.id)
                    {
                        Ok(())
                    } else {
                        Err("NOTES_IDENTITY".into())
                    };
                }
                _ => {}
            }
            if !record.aliases.iter().any(|alias| alias == target) {
                record.aliases.push(target.into());
                record.revision = record.revision.checked_add(1).ok_or("NOTES_LIMIT")?;
                record.updated_at = super::now().max(record.updated_at);
                self.put(account, &record)?;
            }
            self.execute(
                "DELETE FROM moves WHERE owner=? AND source=? AND target=?",
                &[
                    Value::String(account.owner.to_string()),
                    Value::String(source.into()),
                    Value::String(target_folder.into()),
                ],
            )
        })
    }

    pub fn delete(&self, account: &AccountGuard, identity: &str, expected: i64) -> Result<()> {
        self.transaction(account, || {
            let Some(record) = self.read(account, identity)? else {
                return Err("NOTES_CONFLICT".into());
            };
            if record.revision != expected {
                return Err("NOTES_CONFLICT".into());
            }
            self.execute(
                "DELETE FROM notes WHERE owner=? AND identity=?",
                &[
                    Value::String(account.owner.to_string()),
                    Value::String(identity.into()),
                ],
            )
        })
    }

    /// VACUUM INTO is a SQLite-consistent backup even with concurrent readers.
    pub fn backup(&self, account: &AccountGuard) -> Result<PathBuf> {
        account.validate()?;
        let folder = self.root.join("backups");
        std::fs::create_dir_all(&folder).map_err(|_| "NOTES_STORAGE")?;
        let path = folder.join(format!("before-import-{}.db", uuid::Uuid::new_v4()));
        // A second read connection lets import hold its writer reservation on
        // self.db while taking the exact pre-import committed snapshot.
        let mut source = sqlite::open(self.root.join("notes.db")).map_err(|_| "NOTES_STORAGE")?;
        source
            .set_busy_timeout(5_000)
            .map_err(|_| "NOTES_STORAGE")?;
        let mut vacuum = source
            .prepare("VACUUM INTO ?")
            .map_err(|_| "NOTES_STORAGE")?;
        vacuum
            .bind((1, path.to_string_lossy().as_ref()))
            .map_err(|_| "NOTES_STORAGE")?;
        vacuum.next().map_err(|_| "NOTES_STORAGE")?;
        drop(vacuum);
        drop(source);
        let verify = sqlite::open(&path).map_err(|_| "NOTES_STORAGE")?;
        let mut query = verify
            .prepare("PRAGMA integrity_check")
            .map_err(|_| "NOTES_STORAGE")?;
        if query.next().map_err(|_| "NOTES_STORAGE")? != State::Row
            || query.read::<String, _>(0).map_err(|_| "NOTES_STORAGE")? != "ok"
        {
            return Err("NOTES_STORAGE".into());
        }
        // Windows FlushFileBuffers requires a write-capable file handle.
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .and_then(|f| f.sync_all())
            .map_err(|_| "NOTES_BACKUP_SYNC")?;
        account.validate()?;
        Ok(path)
    }
}
