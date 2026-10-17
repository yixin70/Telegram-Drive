//! Explicit recovery never guesses filenames or deletes a committed logical file.
use super::*;

#[derive(Serialize)]
pub(crate) struct Pending {
    pub group: String,
    pub folder: Option<i64>,
    pub name: String,
    pub mode: String,
    pub confirmed: usize,
}

async fn journals<T: Transport>(
    transport: &T,
    credentials: &Credentials<'_>,
) -> Result<Vec<Journal>> {
    transport.check()?;
    let store = Store::open(&transport.account().root, transport.account().owner).map_err(err)?;
    let records: Vec<Vec<u8>> = store.records(JOURNAL).map_err(err)?;
    if records.len() > 128 {
        return Err(err(
            "Too many recovery records; inspect the account before cleanup",
        ));
    }
    let mut journals = Vec::new();
    for record in records {
        // Different per-file passwords are deliberately not revealed by listing.
        let Ok(bytes) = unseal(record, credentials).await else {
            continue;
        };
        let journal: Journal = serde_json::from_slice(&bytes).map_err(err)?;
        if journal.manifest.owner != transport.account().owner
            || !valid_group(&journal.manifest.group)
        {
            return Err(err("Recovery account mismatch"));
        }
        if journal.committed.is_none() {
            journals.push(journal);
        }
    }
    transport.check()?;
    Ok(journals)
}

pub(crate) async fn list<T: Transport>(
    transport: &T,
    credentials: &Credentials<'_>,
) -> Result<Vec<Pending>> {
    Ok(journals(transport, credentials)
        .await?
        .into_iter()
        .map(|j| Pending {
            group: j.manifest.group,
            folder: j.manifest.folder,
            name: j.manifest.name,
            mode: j.manifest.mode,
            confirmed: j.manifest.parts.len(),
        })
        .collect())
}

pub(crate) async fn cleanup<T: Transport>(
    transport: &T,
    folder: Option<i64>,
    group: &str,
    credentials: &Credentials<'_>,
) -> Result<()> {
    let _mutation = mutation_lock(transport).await?;
    if !valid_group(group) {
        return Err(err("Invalid recovery group"));
    }
    let journal = journals(transport, credentials)
        .await?
        .into_iter()
        .find(|j| j.manifest.group == group && j.manifest.folder == folder)
        .ok_or_else(|| err("No unlocked pending upload matches this account, folder and group"))?;
    if checked(transport, transport.find(&manifest_caption(group)))
        .await?
        .is_some()
    {
        return Err(err(
            "A committed manifest exists; delete the logical file instead",
        ));
    }
    // Confirmed entries stay recorded until *all* removals succeed. Missing
    // entries are idempotently accepted by remove(), so a failed cleanup retries.
    for (index, part) in journal.manifest.parts.iter().enumerate() {
        if part.index as usize != index
            || part.remote.caption != part_caption(group, index)
            || part.remote.name
                != format!(
                    "tdrive_{group}_{index}.tdpart{}",
                    if journal.manifest.mode == "standard" {
                        ""
                    } else {
                        ".tdenc"
                    }
                )
        {
            return Err(err("Recovery piece identity mismatch"));
        }
        checked(transport, transport.remove(&part.remote)).await?;
    }
    let index = journal.manifest.parts.len();
    if let Some(pending) = checked(transport, transport.find(&part_caption(group, index))).await? {
        if pending.name
            != format!(
                "tdrive_{group}_{index}.tdpart{}",
                if journal.manifest.mode == "standard" {
                    ""
                } else {
                    ".tdenc"
                }
            )
        {
            return Err(err("Pending recovery document changed"));
        }
        if let Some(expected) = journal.pending_header {
            let (_, mut reader) = checked(transport, transport.open(pending.id)).await?;
            if checked(transport, header(&mut reader)).await? != expected {
                return Err(err("Pending recovery envelope changed"));
            }
        } else if journal.manifest.mode != "standard" {
            return Err(err("Pending encrypted identity is not recoverable"));
        }
        checked(transport, transport.remove(&pending)).await?;
    }
    transport.check()?;
    Store::open(&transport.account().root, transport.account().owner)
        .map_err(err)?
        .remove_record(JOURNAL, &journal.storage_key)
        .map_err(err)?;
    transport.check()
}
