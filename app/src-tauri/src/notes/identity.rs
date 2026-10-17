//! Only native media resolvers may supply fingerprints to this module.
use super::{store::Store, Result};
use crate::workspace::AccountGuard;

pub(crate) fn resolve(account: &AccountGuard, alias: &str, fingerprint: &str) -> Result<String> {
    if !super::valid_alias(alias) {
        return Err("NOTES_INVALID".into());
    }
    let prefix = format!("{fingerprint}:at:");
    let store = Store::open(account)?;
    if let Some(record) = store.by_alias(account, alias)? {
        if record.identity.starts_with(&prefix) {
            return Ok(record.identity);
        }
    }
    // Origin makes two copies of the same Telegram document independent.
    // A verified move installs an alias to the immutable original identity.
    Ok(format!("{prefix}{alias}"))
}

pub(crate) struct PendingMove {
    source: String,
    identity: String,
}
pub(crate) fn prepare_move(
    account: &AccountGuard,
    source: &str,
    target_folder: Option<i64>,
    fingerprint: &str,
) -> Result<Option<PendingMove>> {
    if !account.root.join("notes/notes.db").is_file() {
        return Ok(None);
    }
    let store = Store::open(account)?;
    let Some(record) = store.by_alias(account, source)? else {
        return Ok(None);
    };
    if !record.identity.starts_with(&format!("{fingerprint}:at:")) {
        return Ok(None);
    }
    store.prepare_move(
        account,
        source,
        &target_folder.map_or_else(|| "saved".into(), |id| id.to_string()),
    )?;
    Ok(Some(PendingMove {
        source: source.into(),
        identity: record.identity,
    }))
}
impl PendingMove {
    pub(crate) fn finish(
        &self,
        account: &AccountGuard,
        folder: Option<i64>,
        message: i32,
    ) -> Result<()> {
        Store::open(account)?.finish_move(
            account,
            &self.source,
            &format!(
                "{}:{message}",
                folder.map_or_else(|| "saved".into(), |id| id.to_string())
            ),
            &self.identity,
        )
    }
}
