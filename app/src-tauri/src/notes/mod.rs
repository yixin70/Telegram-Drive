//! Durable user content. Never place this database in workspace/cache storage.
pub(crate) mod access;
pub mod backup;
pub mod commands;
pub(crate) mod identity;
pub mod store;

use crate::workspace::AccountGuard;
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_TEXT: usize = 65_536;
pub const MAX_BACKUP: usize = 67_108_864;
pub const MAX_RECORDS: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedContext {
    pub version: u32,
    pub note_id: String,
    pub header: Vec<u8>,
    pub file_uuid: String,
    pub binding: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Payload {
    Plain {
        text: String,
    },
    Encrypted {
        context: ProtectedContext,
        nonce: Vec<u8>,
        ciphertext: Vec<u8>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub owner: String,
    pub identity: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub aliases: Vec<String>,
    pub payload: Payload,
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn bounded_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":-_".contains(&c))
}

impl Record {
    pub fn validate(&self, owner: i64) -> Result<()> {
        if self.owner != owner.to_string() {
            return Err("ACCOUNT_CHANGED".into());
        }
        if uuid::Uuid::parse_str(&self.id).is_err()
            || !bounded_identifier(&self.identity)
            || self.revision < 1
            || self.created_at < 0
            || self.updated_at < self.created_at
            || self.aliases.len() > 128
            || self.aliases.iter().any(|a| !valid_alias(a))
            || self
                .aliases
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.aliases.len()
        {
            return Err("NOTES_INVALID".into());
        }
        match &self.payload {
            Payload::Plain { text } if text.len() <= MAX_TEXT => Ok(()),
            Payload::Plain { .. } => Err("NOTES_LIMIT".into()),
            Payload::Encrypted {
                context,
                nonce,
                ciphertext,
            } => {
                if context.version != 1 {
                    return Err("NOTES_VERSION".into());
                }
                if context.header.len() > crate::crypto::policy::MAX_HEADER_LENGTH
                    || nonce.len() != 24
                    || ciphertext.len() < 16
                    || ciphertext.len() > MAX_TEXT + 16
                {
                    return Err("NOTES_LIMIT".into());
                }
                let header = crate::crypto::envelope::EnvelopeHeader::parse(&context.header)
                    .map_err(|_| "NOTES_INVALID")?;
                if uuid::Uuid::parse_str(&context.file_uuid).is_err()
                    || uuid::Uuid::parse_str(&context.note_id).is_err()
                    || (context.note_id != self.id
                        && !(self.identity.starts_with("alternate:") && self.aliases.is_empty()))
                    || !bounded_identifier(&context.binding)
                    || uuid::Uuid::from_bytes(header.core.file_uuid).to_string()
                        != context.file_uuid
                {
                    return Err("NOTES_INVALID".into());
                }
                Ok(())
            }
        }
    }
}

pub fn valid_alias(value: &str) -> bool {
    let Some((folder, message)) = value.split_once(':') else {
        return false;
    };
    valid_folder(folder)
        && message
            .parse::<i32>()
            .is_ok_and(|v| v > 0 && v.to_string() == message)
}

pub(super) fn valid_folder(value: &str) -> bool {
    value == "saved"
        || value
            .parse::<i64>()
            .is_ok_and(|v| v != 0 && v.to_string() == value)
}

/// Caller must obtain identity from native-verified media, never directly from IPC.
pub fn save_plain(
    account: &AccountGuard,
    identity: &str,
    alias: &str,
    text: String,
    expected: i64,
) -> Result<Record> {
    if text.len() > MAX_TEXT {
        return Err("NOTES_LIMIT".into());
    }
    let store = store::Store::open(account)?;
    store.transaction(account, || {
        let previous = store.read(account, identity)?;
        if previous.as_ref().map_or(0, |r| r.revision) != expected {
            return Err("NOTES_CONFLICT".into());
        }
        if previous
            .as_ref()
            .is_some_and(|r| !matches!(r.payload, Payload::Plain { .. }))
        {
            return Err("NOTES_PROTECTION".into());
        }
        let timestamp = now();
        let mut record = previous.unwrap_or_else(|| Record {
            id: uuid::Uuid::new_v4().to_string(),
            owner: account.owner.to_string(),
            identity: identity.into(),
            revision: 0,
            created_at: timestamp,
            updated_at: timestamp,
            aliases: Vec::new(),
            payload: Payload::Plain {
                text: String::new(),
            },
        });
        record.revision = record.revision.checked_add(1).ok_or("NOTES_LIMIT")?;
        record.updated_at = timestamp.max(record.updated_at);
        if !record.aliases.iter().any(|a| a == alias) {
            record.aliases.push(alias.into());
        }
        record.payload = Payload::Plain { text };
        store.release_alias(account, alias, identity)?;
        store.put(account, &record)?;
        Ok(record)
    })
}
