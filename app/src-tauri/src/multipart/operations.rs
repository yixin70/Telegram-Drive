//! Whole-set mutations. A sealed, account-scoped deletion record survives a
//! partially successful remote delete. Copies commit a destination manifest
//! before attempting any removal from the original folder.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Deletion {
    manifest: Manifest,
    commit: Remote,
    remaining: Vec<Remote>,
}

pub(crate) fn pending_delete(account: &AccountGuard, folder: Option<i64>, id: i32) -> Result<bool> {
    account.validate()?;
    let store = Store::open(&account.root, account.owner).map_err(err)?;
    Ok(store
        .record::<Vec<u8>>("multipart-delete-v1", &format!("{folder:?}:{id}"))
        .map_err(err)?
        .is_some())
}

pub(crate) async fn delete<T: Transport>(
    transport: &T,
    id: i32,
    folder: Option<i64>,
    credentials: &Credentials<'_>,
) -> Result<()> {
    let _mutation = mutation_lock(transport).await?;
    delete_inner(transport, id, folder, credentials).await
}

async fn delete_inner<T: Transport>(
    transport: &T,
    id: i32,
    folder: Option<i64>,
    credentials: &Credentials<'_>,
) -> Result<()> {
    transport.check()?;
    let key = format!("{folder:?}:{id}");
    let store = Store::open(&transport.account().root, transport.account().owner).map_err(err)?;
    let saved: Option<Vec<u8>> = store.record("multipart-delete-v1", &key).map_err(err)?;
    let mut deletion: Deletion = if let Some(saved) = saved {
        serde_json::from_slice(&unseal(saved, credentials).await?).map_err(err)?
    } else {
        let manifest = read_manifest(transport, id, folder, credentials).await?;
        let (commit, _) = checked(transport, transport.open(id)).await?;
        let mut remaining: Vec<_> = manifest.parts.iter().map(|p| p.remote.clone()).collect();
        remaining.push(commit.clone());
        Deletion {
            manifest,
            commit,
            remaining,
        }
    };
    validate(
        &deletion.manifest,
        transport.account(),
        folder,
        &deletion.manifest.group,
    )?;
    let mut all: Vec<_> = deletion
        .manifest
        .parts
        .iter()
        .map(|part| part.remote.clone())
        .collect();
    all.push(deletion.commit.clone());
    if deletion.commit.id != id
        || deletion.commit.caption != manifest_caption(&deletion.manifest.group)
        || deletion.commit.name
            != format!(
                "tdrive_{}.tdmp{}",
                deletion.manifest.group,
                if deletion.manifest.mode == "standard" {
                    ""
                } else {
                    ".tdenc"
                }
            )
        || !all.ends_with(&deletion.remaining)
    {
        return Err(err("Invalid deletion checkpoint references"));
    }
    let actual = Credentials {
        mode: &deletion.manifest.mode,
        vault: credentials.vault,
        passphrase: credentials.passphrase,
    };
    let save = |deletion: &Deletion| serde_json::to_vec(deletion).map_err(err);
    let encoded = seal(save(&deletion)?, &actual).await?;
    store
        .put_record("multipart-delete-v1", &key, &encoded)
        .map_err(err)?;
    while let Some(remote) = deletion.remaining.first().cloned() {
        transport.check()?;
        checked(transport, transport.remove(&remote)).await?;
        deletion.remaining.remove(0);
        let bytes = seal(save(&deletion)?, &actual).await?;
        transport.check()?;
        store
            .put_record("multipart-delete-v1", &key, &bytes)
            .map_err(err)?;
    }
    transport.check()?;
    store
        .remove_record("multipart-delete-v1", &key)
        .map_err(err)?;
    Ok(())
}

pub(crate) async fn move_file<T: Transport>(
    source: &T,
    target: &T,
    id: i32,
    source_folder: Option<i64>,
    target_folder: Option<i64>,
    credentials: &Credentials<'_>,
) -> Result<i32> {
    let _mutation = mutation_lock(source).await?;
    source.check()?;
    target.check()?;
    if source.account().owner != target.account().owner || source_folder == target_folder {
        return Err(err("Invalid move scope"));
    }
    let mut manifest = read_manifest(source, id, source_folder, credentials).await?;
    let original = manifest.clone();
    for part in &mut manifest.parts {
        source.check()?;
        target.check()?;
        let copied = checked(
            target,
            target.copy_from(
                source,
                &part.remote,
                &format!("move:{}:{}:{}", manifest.group, id, part.index),
            ),
        )
        .await?;
        if copied.size != part.remote.size
            || copied.document != part.remote.document
            || copied.caption != part.remote.caption
            || copied.name != part.remote.name
        {
            return Err(err("Copied piece identity mismatch"));
        }
        verify_remote(target, &copied, &part.sha256).await?;
        part.remote = copied;
    }
    manifest.folder = target_folder;
    validate(&manifest, target.account(), target_folder, &manifest.group)?;
    let actual = Credentials {
        mode: &manifest.mode,
        vault: credentials.vault,
        passphrase: credentials.passphrase,
    };
    let caption = manifest_caption(&manifest.group);
    let commit = if let Some(remote) = checked(target, target.find(&caption)).await? {
        if read_manifest(target, remote.id, target_folder, &actual).await? != manifest {
            return Err(err(
                "Destination already has a different manifest for this set",
            ));
        }
        remote
    } else {
        let mut bytes = MAGIC.to_vec();
        bytes.extend(serde_json::to_vec(&manifest).map_err(err)?);
        let bytes = seal(bytes, &actual).await?;
        if bytes.len() > MAX_MANIFEST {
            return Err(err("Moved manifest exceeds size limit"));
        }
        let mut hold = BandwidthReservation::upload(target.bandwidth(), bytes.len() as u64)?;
        let name = format!(
            "tdrive_{}.tdmp{}",
            manifest.group,
            if manifest.mode == "standard" {
                ""
            } else {
                ".tdenc"
            }
        );
        let commit = checked(
            target,
            target.put(
                Box::new(std::io::Cursor::new(bytes.clone())),
                bytes.len() as u64,
                &name,
                &caption,
                &format!("move-manifest:{}:{id}", manifest.group),
                None,
            ),
        )
        .await?;
        hold.commit();
        commit
    };
    // Validate the remotely published destination before touching the originals.
    if read_manifest(target, commit.id, target_folder, &actual).await? != manifest {
        return Err(err("Moved manifest verification failed"));
    }
    source.check()?;
    if read_manifest(source, id, source_folder, credentials).await? != original {
        return Err(err("The source changed during the move"));
    }
    delete_inner(source, id, source_folder, credentials).await?;
    Ok(commit.id)
}
