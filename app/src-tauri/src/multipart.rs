//! TDMP1 is a transport container, not a revision of TDENC2. Every protected
//! object is an independent, ordinary TDENC2 envelope. The manifest is the only
//! commit point; neither journals nor filenames are needed to read a remote set.
pub(crate) mod operations;
pub(crate) mod recovery;
pub(crate) mod telegram;
use crate::bandwidth::{BandwidthManager, BandwidthReservation};
use crate::commands::download_destination::{
    publish_download_file, DownloadCollisionPolicy, DownloadPublication,
};
use crate::commands::fs::{
    initialize_tdenc2_decryptor_off_worker, protected_upload_stream_off_worker,
};
use crate::crypto::{
    policy,
    secret::{SecretBytes, SecretKey},
};
use crate::workspace::{store::Store, AccountGuard};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, ReadBuf};
use zeroize::Zeroize;

pub(crate) const MANIFEST_PREFIX: &str = "TDMP1 ";
pub(crate) const PART_PREFIX: &str = "TDMPART1 ";
const MAGIC: &[u8] = b"TDMP1\n";
const MAX_MANIFEST: usize = 2 * 1024 * 1024;
const MAX_PARTS: usize = 4096;
const JOURNAL: &str = "multipart-v1";
pub(crate) const UNSUPPORTED: &str = "[MULTIPART_UNSUPPORTED] Download this multipart file with Telegram Drive before using this operation";
type Result<T> = std::result::Result<T, String>;
pub(crate) type Reader = Box<dyn AsyncRead + Unpin + Send>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Remote {
    pub id: i32,
    pub document: i64,
    pub size: u64,
    pub name: String,
    pub caption: String,
}

/// Implementations are the Telegram boundary (or a process fixture). The
/// publication key MUST be idempotent, including a lost SendMedia response.
pub(crate) trait Transport: Sync {
    fn account(&self) -> &AccountGuard;
    fn bandwidth(&self) -> Arc<BandwidthManager>;
    fn check(&self) -> Result<()>;
    fn progress(&self, _bytes: u64, _total: u64) {}
    fn put(
        &self,
        reader: Reader,
        size: u64,
        name: &str,
        caption: &str,
        key: &str,
        header: Option<&[u8]>,
    ) -> impl std::future::Future<Output = Result<Remote>> + Send;
    fn open(&self, id: i32) -> impl std::future::Future<Output = Result<(Remote, Reader)>> + Send;
    fn lookup(&self, id: i32) -> impl std::future::Future<Output = Result<Option<Remote>>> + Send;
    fn find(
        &self,
        caption: &str,
    ) -> impl std::future::Future<Output = Result<Option<Remote>>> + Send;
    fn remove(&self, remote: &Remote) -> impl std::future::Future<Output = Result<()>> + Send;
    fn copy_from(
        &self,
        source: &Self,
        remote: &Remote,
        key: &str,
    ) -> impl std::future::Future<Output = Result<Remote>> + Send;
}

pub(crate) struct Credentials<'a> {
    pub mode: &'a str,
    pub vault: Option<&'a SecretKey>,
    pub passphrase: Option<&'a SecretBytes>,
}

impl Credentials<'_> {
    // Available credentials must not silently add a second key slot to a mode
    // that requested only one. Capacity and the manifest bind the selected mode.
    fn writing_vault(&self) -> Option<&SecretKey> {
        self.vault
            .filter(|_| matches!(self.mode, "vault" | "vault_and_passphrase"))
    }
    fn writing_passphrase(&self) -> Option<&SecretBytes> {
        self.passphrase
            .filter(|_| matches!(self.mode, "passphrase" | "vault_and_passphrase"))
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Part {
    pub index: u32,
    pub remote: Remote,
    pub length: u64,
    pub sha256: String,
    pub envelope: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub group: String,
    pub owner: i64,
    pub folder: Option<i64>,
    pub mode: String,
    pub name: String,
    pub mime: String,
    pub length: u64,
    pub sha256: String,
    pub parts: Vec<Part>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    storage_key: String,
    manifest: Manifest,
    source: String,
    capacity: u64,
    committed: Option<Remote>,
    pending_header: Option<Vec<u8>>,
    pending_manifest_header: Option<Vec<u8>>,
}

mod hex {
    pub(super) fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

fn err(message: impl std::fmt::Display) -> String {
    format!("[MULTIPART] {message}")
}
fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(crate) fn is_manifest(caption: &str) -> bool {
    caption
        .strip_prefix(MANIFEST_PREFIX)
        .is_some_and(valid_group)
}
pub(crate) fn is_part(caption: &str) -> bool {
    caption
        .strip_prefix(PART_PREFIX)
        .and_then(|s| s.split_once(' '))
        .is_some_and(|(group, index)| {
            valid_group(group) && index.parse::<u32>().is_ok_and(|i| i < MAX_PARTS as u32)
        })
}
pub(crate) fn reject_internal(caption: &str) -> Result<()> {
    if is_manifest(caption) || is_part(caption) {
        Err(UNSUPPORTED.into())
    } else {
        Ok(())
    }
}
pub(crate) fn internal_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix("tdrive_") else {
        return false;
    };
    let name = name.strip_suffix(".tdenc").unwrap_or(name);
    if let Some(group) = name.strip_suffix(".tdmp") {
        return valid_group(group);
    }
    name.strip_suffix(".tdpart")
        .and_then(|s| s.rsplit_once('_'))
        .is_some_and(|(group, index)| {
            valid_group(group) && index.parse::<u32>().is_ok_and(|n| n < MAX_PARTS as u32)
        })
}
pub(crate) fn reject_media(caption: &str, media: &grammers_client::types::Media) -> Result<()> {
    reject_internal(caption)?;
    if matches!(media, grammers_client::types::Media::Document(d) if internal_name(d.name())) {
        return Err(UNSUPPORTED.into());
    }
    Ok(())
}
pub(crate) fn reject_message(message: &grammers_client::types::Message) -> Result<()> {
    match message.media() {
        Some(media) => reject_media(message.text(), &media),
        None => reject_internal(message.text()),
    }
}
pub(crate) fn part_document(caption: &str, media: &grammers_client::types::Media) -> bool {
    let Some((group, index)) = caption
        .strip_prefix(PART_PREFIX)
        .and_then(|s| s.split_once(' '))
    else {
        return false;
    };
    is_part(caption)
        && matches!(media, grammers_client::types::Media::Document(d)
        if d.name() == format!("tdrive_{group}_{index}.tdpart") || d.name() == format!("tdrive_{group}_{index}.tdpart.tdenc"))
}
fn valid_group(group: &str) -> bool {
    uuid::Uuid::parse_str(group).is_ok_and(|id| id.to_string() == group)
}
fn part_caption(group: &str, index: usize) -> String {
    format!("{PART_PREFIX}{group} {index}")
}
fn manifest_caption(group: &str) -> String {
    format!("{MANIFEST_PREFIX}{group}")
}

fn envelope_mode(header: &[u8]) -> Result<&'static str> {
    let header = crate::crypto::envelope::header::EnvelopeHeader::parse(header).map_err(err)?;
    let kinds: Vec<_> = header.key_slots.iter().map(|slot| slot.kind).collect();
    match kinds.as_slice() {
        [1] => Ok("vault"),
        [2] => Ok("passphrase"),
        [1, 2] | [2, 1] => Ok("vault_and_passphrase"),
        _ => Err(err("Unexpected multipart envelope protection slots")),
    }
}

async fn checked<T: Transport, F: std::future::Future<Output = Result<R>>, R>(
    transport: &T,
    operation: F,
) -> Result<R> {
    tokio::pin!(operation);
    let mut ticks = tokio::time::interval(std::time::Duration::from_millis(200));
    loop {
        tokio::select! {
            result = &mut operation => { transport.check()?; return result; },
            _ = ticks.tick() => transport.check()?,
        }
    }
}

// Serialize multipart mutations within an account, including cleanup. Two
// readers of the same source must never race a pending envelope checkpoint.
async fn mutation_lock<T: Transport>(transport: &T) -> Result<tokio::sync::OwnedMutexGuard<()>> {
    type Locks = std::collections::HashMap<
        (std::path::PathBuf, i64),
        std::sync::Weak<tokio::sync::Mutex<()>>,
    >;
    static LOCKS: std::sync::OnceLock<Mutex<Locks>> = std::sync::OnceLock::new();
    let key = (transport.account().root.clone(), transport.account().owner);
    let lock = {
        let mut locks = LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        locks.retain(|_, value| value.strong_count() != 0);
        match locks.get(&key).and_then(std::sync::Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        }
    };
    checked(transport, async { Ok(lock.lock_owned().await) }).await
}

/// Confirm recovered publication bytes, not just a matching caption. A lost RPC
/// response must never turn somebody else's/corrupted document into our piece.
pub(crate) async fn verify_remote<T: Transport>(
    transport: &T,
    expected: &Remote,
    digest: &str,
) -> Result<()> {
    let (remote, mut reader) = checked(transport, transport.open(expected.id)).await?;
    if remote != *expected {
        return Err(err("Recovered document identity changed"));
    }
    let mut hold = BandwidthReservation::download(transport.bandwidth(), remote.size)?;
    let mut hash = Sha256::new();
    let mut count = 0_u64;
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let n = checked(transport, async {
            reader.read(&mut buffer).await.map_err(err)
        })
        .await?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > remote.size {
            return Err(err("Recovered document has trailing bytes"));
        }
        hash.update(&buffer[..n]);
    }
    buffer.zeroize();
    if count != remote.size || hex::encode(hash.finalize()) != digest {
        return Err(err("Recovered document bytes changed"));
    }
    hold.commit();
    Ok(())
}

/// Actual envelope layout, using the same policy constants as the frozen writer.
/// Pieces have no metadata; the independently encrypted manifest carries it.
pub(crate) fn capacity(mode: &str, limit: u64) -> Result<u64> {
    if limit == 0 || limit > policy::TELEGRAM_MAX_FILE_SIZE {
        return Err(err("Invalid object limit"));
    }
    let slots = match mode {
        "standard" => return Ok(limit),
        "vault" | "passphrase" => 1,
        "vault_and_passphrase" => 2,
        _ => return Err(err("Unsupported protection mode")),
    };
    let header = (policy::CORE_HEADER_SIZE + slots * policy::KEY_SLOT_SIZE) as u64;
    let size = |n: u64| {
        header
            + n
            + n.div_ceil(u64::from(policy::DEFAULT_CHUNK_SIZE)) * policy::AEAD_TAG_LENGTH as u64
            + policy::FINAL_RECORD_CIPHERTEXT_SIZE as u64
    };
    if size(1) > limit {
        return Err(err("Object limit cannot contain an encrypted piece"));
    }
    let (mut low, mut high) = (1, limit);
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        if size(mid) <= limit {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    Ok(low)
}

pub(crate) fn needs_split(length: u64, mode: &str, metadata_length: usize) -> Result<bool> {
    if mode == "standard" {
        return Ok(length > policy::TELEGRAM_MAX_FILE_SIZE);
    }
    let slots = match mode {
        "vault" | "passphrase" => 1,
        "vault_and_passphrase" => 2,
        _ => return Err(err("Unsupported protection mode")),
    };
    let header = policy::CORE_HEADER_SIZE
        + slots * policy::KEY_SLOT_SIZE
        + metadata_length
        + if metadata_length == 0 {
            0
        } else {
            policy::AEAD_TAG_LENGTH
        };
    if header > policy::MAX_HEADER_LENGTH {
        return Err(err("Protected metadata exceeds header limit"));
    }
    Ok(
        crate::crypto::envelope::length::calculate_ciphertext_length(
            length,
            policy::DEFAULT_CHUNK_SIZE,
            header as u32,
        )
        .is_err(),
    )
}

fn validate(
    manifest: &Manifest,
    account: &AccountGuard,
    folder: Option<i64>,
    group: &str,
) -> Result<()> {
    if manifest.version != 1
        || !valid_group(&manifest.group)
        || manifest.group != group
        || manifest.owner != account.owner
        || manifest.folder != folder
        || manifest.length == 0
        || !is_hash(&manifest.sha256)
        || manifest.name.is_empty()
        || manifest.name.len() > 4096
        || manifest.mime.len() > 256
        || manifest.parts.is_empty()
        || manifest.parts.len() > MAX_PARTS
    {
        return Err(err("Invalid manifest or account/destination scope"));
    }
    capacity(&manifest.mode, policy::TELEGRAM_MAX_FILE_SIZE)?;
    let mut ids = HashSet::new();
    let mut documents = HashSet::new();
    let mut sum = 0_u64;
    for (index, part) in manifest.parts.iter().enumerate() {
        if part.index as usize != index
            || part.remote.id <= 0
            || !ids.insert(part.remote.id)
            || !documents.insert(part.remote.document)
            || part.remote.caption != part_caption(group, index)
            || part.remote.size == 0
            || part.remote.size > policy::TELEGRAM_MAX_FILE_SIZE
            || part.length == 0
            || part.length > part.remote.size
            || !is_hash(&part.sha256)
            || (part.envelope.is_some() != (manifest.mode != "standard"))
            || part
                .envelope
                .as_ref()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(err("Invalid, duplicated, or unordered piece"));
        }
        let suffix = if manifest.mode == "standard" {
            "tdpart"
        } else {
            "tdpart.tdenc"
        };
        if part.remote.name != format!("tdrive_{group}_{index}.{suffix}")
            || (manifest.mode == "standard" && part.length != part.remote.size)
        {
            return Err(err(
                "Piece filename or plaintext length does not match its manifest",
            ));
        }
        sum = sum
            .checked_add(part.length)
            .ok_or_else(|| err("Length overflow"))?;
    }
    if sum != manifest.length {
        return Err(err("Logical length mismatch"));
    }
    Ok(())
}

struct DigestReader<R> {
    inner: R,
    digest: Arc<Mutex<Sha256>>,
    bytes: Arc<AtomicU64>,
}
impl<R: AsyncRead + Unpin> AsyncRead for DigestReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        if let Poll::Ready(Ok(())) = &result {
            self.digest
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .update(&buffer.filled()[before..]);
            self.bytes
                .fetch_add((buffer.filled().len() - before) as u64, Ordering::Relaxed);
        }
        result
    }
}

/// Keep one source identity pinned. On Windows this also denies concurrent
/// writes/deletion, including replacing the path while a pending nonce is reused.
fn open_source(path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READ only
    }
    options.open(path).map_err(err)
}

async fn source_hash<T: Transport>(transport: &T, source: &std::fs::File) -> Result<(u64, String)> {
    let mut file = tokio::fs::File::from_std(source.try_clone().map_err(err)?);
    file.seek(std::io::SeekFrom::Start(0)).await.map_err(err)?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0; 256 * 1024];
    loop {
        transport.check()?;
        let n = file.read(&mut buffer).await.map_err(err)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
        size = size
            .checked_add(n as u64)
            .ok_or_else(|| err("Source too large"))?;
    }
    buffer.zeroize();
    Ok((size, hex::encode(digest.finalize())))
}

async fn seal(bytes: Vec<u8>, credentials: &Credentials<'_>) -> Result<Vec<u8>> {
    if credentials.mode == "standard" {
        return Ok(bytes);
    }
    let mut stream = protected_upload_stream_off_worker(
        std::io::Cursor::new(bytes.clone()),
        bytes.len() as u64,
        credentials.mode,
        credentials.writing_vault(),
        credentials.writing_passphrase(),
        Vec::new(),
        None,
    )
    .await?;
    let mut original = bytes;
    original.zeroize();
    let mut encoded = Vec::new();
    stream.reader.read_to_end(&mut encoded).await.map_err(err)?;
    Ok(encoded)
}

async fn header(reader: &mut Reader) -> Result<Vec<u8>> {
    let mut bytes = vec![0; policy::CORE_HEADER_SIZE];
    reader.read_exact(&mut bytes).await.map_err(err)?;
    if &bytes[..6] != policy::MAGIC {
        return Err(err("Expected TDENC2 envelope"));
    }
    let length = u32::from_le_bytes(bytes[26..30].try_into().map_err(err)?) as usize;
    if !(policy::CORE_HEADER_SIZE..=policy::MAX_HEADER_LENGTH).contains(&length) {
        return Err(err("Invalid envelope header length"));
    }
    bytes.resize(length, 0);
    reader
        .read_exact(&mut bytes[policy::CORE_HEADER_SIZE..])
        .await
        .map_err(err)?;
    Ok(bytes)
}

async fn unseal(bytes: Vec<u8>, credentials: &Credentials<'_>) -> Result<Vec<u8>> {
    if !bytes.starts_with(policy::MAGIC) {
        if credentials.mode != "standard" && credentials.mode != "auto" {
            return Err(err("Protected metadata was downgraded"));
        }
        return Ok(bytes);
    }
    let mut reader: Reader = Box::new(std::io::Cursor::new(bytes));
    let header = header(&mut reader).await?;
    let (mut decoder, _) =
        initialize_tdenc2_decryptor_off_worker(&header, credentials.vault, credentials.passphrase)
            .await?;
    if decoder.plaintext_length() > MAX_MANIFEST as u64 {
        return Err(err("Metadata exceeds size bound"));
    }
    let mut plaintext = Vec::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let n = reader.read(&mut buffer).await.map_err(err)?;
        if n == 0 {
            break;
        }
        plaintext.extend(decoder.feed(&buffer[..n]).map_err(err)?);
    }
    decoder.finish().map_err(err)?;
    Ok(plaintext)
}

async fn save_journal<T: Transport>(
    transport: &T,
    key: &str,
    journal: &Journal,
    credentials: &Credentials<'_>,
) -> Result<()> {
    transport.check()?;
    let mut journal = journal.clone();
    journal.storage_key = key.to_string();
    let encoded = seal(serde_json::to_vec(&journal).map_err(err)?, credentials).await?;
    if encoded.len() > MAX_MANIFEST {
        return Err(err("Recovery journal too large"));
    }
    transport.check()?;
    Store::open(&transport.account().root, transport.account().owner)
        .map_err(err)?
        .put_record(JOURNAL, key, &encoded)
        .map_err(err)?;
    transport.check()
}

pub(crate) struct Uploaded {
    pub message: i32,
    pub parts: usize,
    pub resumed: usize,
}

pub(crate) async fn upload<T: Transport>(
    transport: &T,
    path: &Path,
    folder: Option<i64>,
    credentials: &Credentials<'_>,
    limit: u64,
) -> Result<Uploaded> {
    let _mutation = mutation_lock(transport).await?;
    transport.check()?;
    let source = open_source(path)?;
    let piece_capacity = capacity(credentials.mode, limit)?;
    let (length, sha256) = source_hash(transport, &source).await?;
    let count = length.div_ceil(piece_capacity);
    if length == 0 || count > MAX_PARTS as u64 {
        return Err(err("File exceeds the multipart part-count limit"));
    }
    let key = hash(
        format!(
            "{}\0{folder:?}\0{}",
            path.to_string_lossy(),
            credentials.mode
        )
        .as_bytes(),
    );
    let store = Store::open(&transport.account().root, transport.account().owner).map_err(err)?;
    let saved: Option<Vec<u8>> = store.record(JOURNAL, &key).map_err(err)?;
    let mut previous = match saved {
        Some(encoded) => Some(
            serde_json::from_slice::<Journal>(&unseal(encoded, credentials).await?).map_err(err)?,
        ),
        None => None,
    };
    // A successful logical delete/move retires the old upload checkpoint. Use
    // direct message lookup, not search indexing or an arbitrary network error,
    // to establish absence. Retain the old references for explicit orphan cleanup
    // if someone deleted only its manifest outside the application.
    let retired = if let Some(committed) = previous.as_ref().and_then(|j| j.committed.as_ref()) {
        match checked(transport, transport.lookup(committed.id)).await? {
            Some(actual) if actual != *committed => {
                return Err(err("Completed upload document identity changed"));
            }
            Some(_) => false,
            None => true,
        }
    } else {
        false
    };
    if retired {
        if let Some(journal) = &mut previous {
            journal.committed = None;
        }
    }
    let reusable = previous.as_ref().is_some_and(|j| {
        !retired
            && j.source == sha256
            && j.manifest.length == length
            && j.capacity == piece_capacity
            && j.manifest.owner == transport.account().owner
            && j.manifest.folder == folder
            && j.manifest.mode == credentials.mode
            && (cfg!(windows) || j.pending_header.is_none())
    });
    if !reusable {
        // Retain the old set's encrypted journal for explicit orphan cleanup.
        if let Some(old) = previous.take() {
            save_journal(
                transport,
                &format!("orphan-{}", old.manifest.group),
                &old,
                credentials,
            )
            .await?;
        }
    }
    let mut journal = previous.unwrap_or_else(|| Journal {
        storage_key: key.clone(),
        source: sha256.clone(),
        capacity: piece_capacity,
        committed: None,
        pending_header: None,
        pending_manifest_header: None,
        manifest: Manifest {
            version: 1,
            group: uuid::Uuid::new_v4().to_string(),
            owner: transport.account().owner,
            folder,
            mode: credentials.mode.into(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            mime: crate::commands::fs::inferred_mime_type(&path.to_string_lossy()).into(),
            length,
            sha256,
            parts: Vec::new(),
        },
    });
    if journal.manifest.parts.len() > count as usize {
        return Err(err("Invalid recovery journal"));
    }
    save_journal(transport, &key, &journal, credentials).await?;
    let resumed = journal.manifest.parts.len();
    let mut offset = 0_u64;
    for (index, recorded) in journal.manifest.parts.clone().iter().enumerate() {
        transport.check()?;
        if recorded.index as usize != index
            || recorded.remote.caption != part_caption(&journal.manifest.group, index)
        {
            return Err(err("Invalid recovery piece"));
        }
        verify_remote(transport, &recorded.remote, &recorded.sha256).await?;
        offset = offset
            .checked_add(recorded.length)
            .filter(|n| *n <= length)
            .ok_or_else(|| err("Recovery length overflow"))?;
    }
    transport.progress(offset.min(length - 1), length);
    // Hash the plaintext actually consumed by the upload as well as the source
    // before/after it. On platforms without a mandatory write-denying lease, a
    // concurrent edit followed by a revert must not commit an invalid collection.
    let plaintext_digest = Arc::new(Mutex::new(Sha256::new()));
    if offset != 0 {
        let mut prefix = tokio::fs::File::from_std(source.try_clone().map_err(err)?);
        prefix
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(err)?;
        let mut prefix = prefix.take(offset);
        let mut buffer = vec![0; 256 * 1024];
        loop {
            let n = checked(transport, async {
                prefix.read(&mut buffer).await.map_err(err)
            })
            .await?;
            if n == 0 {
                break;
            }
            plaintext_digest
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .update(&buffer[..n]);
        }
        buffer.zeroize();
    }
    for index in journal.manifest.parts.len()..count as usize {
        transport.check()?;
        let size = (length - offset).min(piece_capacity);
        let mut file = tokio::fs::File::from_std(source.try_clone().map_err(err)?);
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(err)?;
        let source = DigestReader {
            inner: file.take(size),
            digest: plaintext_digest.clone(),
            bytes: Arc::new(AtomicU64::new(0)),
        };
        let caption = part_caption(&journal.manifest.group, index);
        let (reader, bytes, envelope, envelope_header): (
            Reader,
            u64,
            Option<String>,
            Option<Vec<u8>>,
        ) = if credentials.mode == "standard" {
            (Box::new(source), size, None, None)
        } else {
            let stream = protected_upload_stream_off_worker(
                source,
                size,
                credentials.mode,
                credentials.writing_vault(),
                credentials.writing_passphrase(),
                Vec::new(),
                journal.pending_header.as_deref(),
            )
            .await?;
            if journal.pending_header.is_some() && !stream.continued {
                return Err(err("Pending envelope credentials changed; restore the original credentials before retrying"));
            }
            (
                Box::new(stream.reader),
                stream.ciphertext_size,
                Some(uuid::Uuid::from_bytes(stream.file_uuid).to_string()),
                Some(stream.header),
            )
        };
        if bytes > limit {
            return Err(err("Encrypted piece exceeds transport limit"));
        }
        journal.pending_header = envelope_header.clone();
        save_journal(transport, &key, &journal, credentials).await?;
        let digest = Arc::new(Mutex::new(Sha256::new()));
        let consumed = Arc::new(AtomicU64::new(0));
        let reader = Box::new(DigestReader {
            inner: reader,
            digest: digest.clone(),
            bytes: consumed.clone(),
        });
        let suffix = if credentials.mode == "standard" {
            "tdpart"
        } else {
            "tdpart.tdenc"
        };
        let name = format!("tdrive_{}_{index}.{suffix}", journal.manifest.group);
        let mut hold = BandwidthReservation::upload(transport.bandwidth(), bytes)?;
        let pending = transport.put(
            reader,
            bytes,
            &name,
            &caption,
            &caption,
            envelope_header.as_deref(),
        );
        tokio::pin!(pending);
        let mut ticks = tokio::time::interval(std::time::Duration::from_millis(200));
        let remote = loop {
            tokio::select! {
                result = &mut pending => break result?,
                _ = ticks.tick() => {
                    transport.check()?;
                    let done = consumed.load(Ordering::Relaxed).min(bytes);
                    transport.progress((offset + done.saturating_mul(size) / bytes).min(length - 1), length);
                }
            }
        };
        transport.check()?;
        if remote.size != bytes
            || remote.caption != caption
            || consumed.load(Ordering::Relaxed) != bytes
        {
            return Err(err("Remote publication mismatch"));
        }
        hold.commit();
        journal.manifest.parts.push(Part {
            index: index as u32,
            remote,
            length: size,
            sha256: hex::encode(
                digest
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .finalize(),
            ),
            envelope,
        });
        journal.pending_header = None;
        save_journal(transport, &key, &journal, credentials).await?;
        offset += size;
        transport.progress(offset.min(length - 1), length);
    }
    let uploaded_plaintext = hex::encode(
        plaintext_digest
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .finalize(),
    );
    if uploaded_plaintext != journal.source
        || source_hash(transport, &source).await? != (length, journal.source.clone())
    {
        return Err(err("Source changed; retry starts a fresh encrypted set"));
    }
    validate(
        &journal.manifest,
        transport.account(),
        folder,
        &journal.manifest.group,
    )?;
    let caption = manifest_caption(&journal.manifest.group);
    // A lost response after the commit is recovered from the remote boundary.
    let remote = if let Some(remote) = transport.find(&caption).await? {
        if read_manifest(transport, remote.id, folder, credentials).await? != journal.manifest {
            return Err(err("Recovered manifest differs from the upload journal"));
        }
        remote
    } else {
        let mut bytes = MAGIC.to_vec();
        bytes.extend(serde_json::to_vec(&journal.manifest).map_err(err)?);
        let bytes = if credentials.mode == "standard" {
            bytes
        } else {
            let mut stream = protected_upload_stream_off_worker(
                std::io::Cursor::new(bytes.clone()),
                bytes.len() as u64,
                credentials.mode,
                credentials.writing_vault(),
                credentials.writing_passphrase(),
                Vec::new(),
                journal.pending_manifest_header.as_deref(),
            )
            .await?;
            bytes.zeroize();
            if journal.pending_manifest_header.is_some() && !stream.continued {
                return Err(err("Pending manifest credentials changed"));
            }
            journal.pending_manifest_header = Some(stream.header);
            save_journal(transport, &key, &journal, credentials).await?;
            let mut output = Vec::new();
            stream.reader.read_to_end(&mut output).await.map_err(err)?;
            output
        };
        if bytes.len() > MAX_MANIFEST || bytes.len() as u64 > limit {
            return Err(err("Manifest exceeds transport limit"));
        }
        let mut hold = BandwidthReservation::upload(transport.bandwidth(), bytes.len() as u64)?;
        let name = format!(
            "tdrive_{}.tdmp{}",
            journal.manifest.group,
            if credentials.mode == "standard" {
                ""
            } else {
                ".tdenc"
            }
        );
        let remote = checked(
            transport,
            transport.put(
                Box::new(std::io::Cursor::new(bytes.clone())),
                bytes.len() as u64,
                &name,
                &caption,
                &caption,
                journal.pending_manifest_header.as_deref(),
            ),
        )
        .await?;
        hold.commit();
        remote
    };
    if read_manifest(transport, remote.id, folder, credentials).await? != journal.manifest {
        return Err(err("Published manifest verification failed"));
    }
    journal.committed = Some(remote.clone());
    save_journal(transport, &key, &journal, credentials).await?;
    transport.progress(length, length);
    Ok(Uploaded {
        message: remote.id,
        parts: count as usize,
        resumed,
    })
}

pub(crate) async fn read_manifest<T: Transport>(
    transport: &T,
    id: i32,
    folder: Option<i64>,
    credentials: &Credentials<'_>,
) -> Result<Manifest> {
    transport.check()?;
    let (remote, mut reader) = checked(transport, transport.open(id)).await?;
    let group = remote
        .caption
        .strip_prefix(MANIFEST_PREFIX)
        .filter(|s| valid_group(s))
        .ok_or_else(|| err("Not a multipart manifest"))?;
    if remote.size == 0 || remote.size > MAX_MANIFEST as u64 {
        return Err(err("Manifest exceeds size bound"));
    }
    let mut hold = BandwidthReservation::download(transport.bandwidth(), remote.size)?;
    let mut bytes = Vec::new();
    checked(transport, async {
        (&mut reader)
            .take(remote.size + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(err)
    })
    .await?;
    if bytes.len() as u64 != remote.size {
        return Err(err("Manifest truncated or has trailing bytes"));
    }
    let protected = bytes.starts_with(policy::MAGIC);
    let actual_mode = if protected {
        Some(envelope_mode(&bytes)?)
    } else {
        None
    };
    let mut bytes = unseal(bytes, credentials).await?;
    let payload = bytes
        .strip_prefix(MAGIC)
        .ok_or_else(|| err("Unsupported manifest version"))?;
    let parsed = serde_json::from_slice::<Manifest>(payload).map_err(err);
    bytes.zeroize();
    let manifest = parsed?;
    validate(&manifest, transport.account(), folder, group)?;
    if protected != (manifest.mode != "standard") {
        return Err(err("Manifest encryption was downgraded"));
    }
    if actual_mode.is_some_and(|mode| mode != manifest.mode) {
        return Err(err("Manifest key slots do not match its protection mode"));
    }
    if credentials.mode != "auto" && manifest.mode != credentials.mode {
        return Err(err("Manifest protection mismatch"));
    }
    transport.check()?;
    hold.commit();
    Ok(manifest)
}

/// Public envelope structure selects the existing credential prompt; it does
/// not unlock metadata or establish trust in the manifest's contents.
pub(crate) async fn protection<T: Transport>(transport: &T, id: i32) -> Result<String> {
    let (remote, mut reader) = checked(transport, transport.open(id)).await?;
    if !is_manifest(&remote.caption) || remote.size == 0 || remote.size > MAX_MANIFEST as u64 {
        return Err(err("Invalid multipart manifest"));
    }
    let mut hold = BandwidthReservation::download(transport.bandwidth(), remote.size)?;
    let mut bytes = Vec::new();
    checked(transport, async {
        (&mut reader)
            .take(remote.size + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(err)
    })
    .await?;
    if bytes.len() as u64 != remote.size {
        bytes.zeroize();
        return Err(err("Manifest size mismatch"));
    }
    let mode = if bytes.starts_with(policy::MAGIC) {
        envelope_mode(&bytes)?.to_string()
    } else if bytes.starts_with(MAGIC) {
        "standard".into()
    } else {
        return Err(err("Unsupported manifest"));
    };
    bytes.zeroize();
    hold.commit();
    Ok(mode)
}

pub(crate) async fn download<T: Transport>(
    transport: &T,
    id: i32,
    folder: Option<i64>,
    destination: &Path,
    credentials: &Credentials<'_>,
    collision: DownloadCollisionPolicy,
) -> Result<DownloadPublication> {
    let manifest = read_manifest(transport, id, folder, credentials).await?;
    let partial = crate::commands::fs::download_partial_path(destination)?;
    let file = crate::commands::fs::create_private_partial_file(&partial)?;
    let mut cleanup = crate::commands::fs::PartialFileGuard::new(partial.clone());
    let mut file = tokio::fs::File::from_std(file);
    let mut whole = Sha256::new();
    let mut total = 0_u64;
    for part in &manifest.parts {
        transport.check()?;
        let (remote, reader) = checked(transport, transport.open(part.remote.id)).await?;
        if remote != part.remote {
            return Err(err("Piece identity changed"));
        }
        let mut hold = BandwidthReservation::download(transport.bandwidth(), remote.size)?;
        let digest = Arc::new(Mutex::new(Sha256::new()));
        let mut reader: Reader = Box::new(DigestReader {
            inner: reader.take(remote.size + 1),
            digest: digest.clone(),
            bytes: Arc::new(AtomicU64::new(0)),
        });
        let mut consumed = 0_u64;
        let mut decoder = if let Some(id) = &part.envelope {
            let header = checked(transport, header(&mut reader)).await?;
            if envelope_mode(&header)? != manifest.mode {
                return Err(err("Piece protection mode differs from its manifest"));
            }
            consumed = header.len() as u64;
            let (decoder, _) = initialize_tdenc2_decryptor_off_worker(
                &header,
                credentials.vault,
                credentials.passphrase,
            )
            .await?;
            if uuid::Uuid::from_bytes(*decoder.file_uuid()).to_string() != *id
                || decoder.plaintext_length() != part.length
            {
                return Err(err("Piece envelope identity changed"));
            }
            Some(decoder)
        } else {
            None
        };
        let mut written = 0_u64;
        let mut buffer = vec![0; 256 * 1024];
        loop {
            transport.check()?;
            let n = checked(transport, async {
                reader.read(&mut buffer).await.map_err(err)
            })
            .await?;
            if n == 0 {
                break;
            }
            consumed += n as u64;
            if consumed > remote.size {
                return Err(err("Trailing piece bytes"));
            }
            let mut plaintext = if let Some(decoder) = &mut decoder {
                decoder.feed(&buffer[..n]).map_err(err)?
            } else {
                buffer[..n].to_vec()
            };
            written += plaintext.len() as u64;
            if written > part.length {
                plaintext.zeroize();
                return Err(err("Piece exceeds declared length"));
            }
            whole.update(&plaintext);
            file.write_all(&plaintext).await.map_err(err)?;
            plaintext.zeroize();
            transport.progress((total + written).min(manifest.length - 1), manifest.length);
        }
        buffer.zeroize();
        if let Some(decoder) = decoder {
            decoder.finish().map_err(err)?;
        }
        if consumed != remote.size
            || written != part.length
            || hex::encode(
                digest
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .finalize(),
            ) != part.sha256
        {
            return Err(err("Piece digest or length mismatch"));
        }
        hold.commit();
        total += written;
    }
    if total != manifest.length || hex::encode(whole.finalize()) != manifest.sha256 {
        return Err(err("Whole-file digest or length mismatch"));
    }
    file.flush().await.map_err(err)?;
    file.sync_all().await.map_err(err)?;
    drop(file);
    transport.check()?;
    let publication = publish_download_file(
        partial,
        destination.into(),
        collision,
        Some(transport.account().clone()),
    )
    .await?;
    cleanup.disarm();
    transport.progress(manifest.length, manifest.length);
    Ok(publication)
}
