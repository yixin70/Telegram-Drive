//! Telegram adapter. Stable MTProto random_id values prevent duplicate logical
//! publication when an RPC succeeded but its response was lost.
use super::*;
use crate::{
    crypto::state::CryptoState,
    resumable_upload::{PacedSink, ResumableUpload, SourceFingerprint, TelegramSink},
    traffic::{Direction, Traffic},
    vpn_optimizer::NetworkConfig,
};
use grammers_client::{
    types::{Media, Message, Peer},
    Client,
};
use grammers_tl_types as tl;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;

pub(crate) struct Telegram<'a> {
    pub account: AccountGuard,
    pub client: Client,
    pub peer: Peer,
    pub folder: Option<i64>,
    pub bandwidth: Arc<BandwidthManager>,
    pub network: Arc<NetworkConfig>,
    pub crypto: Option<&'a CryptoState>,
    pub session: Option<u64>,
    pub cancelled: Option<Arc<tokio::sync::RwLock<HashSet<String>>>>,
    pub app: Option<tauri::AppHandle>,
    pub transfer: String,
    pub upload: bool,
    pub source: Option<SourceFingerprint>,
    pub total: AtomicU64,
}

pub(crate) fn remote(message: &Message) -> Result<Remote> {
    match message.media() {
        Some(Media::Document(document)) => Ok(Remote {
            id: message.id(),
            document: document.id(),
            size: crate::commands::utils::media_size(&Media::Document(document.clone())),
            name: document.name().into(),
            caption: message.text().into(),
        }),
        _ => Err(err("Multipart object is not a document")),
    }
}

impl Telegram<'_> {
    fn traffic(&self, direction: Direction) -> Traffic {
        Traffic {
            account: self.account.clone(),
            network: self.network.clone(),
            direction,
        }
    }
    async fn publish(
        &self,
        media: tl::enums::InputMedia,
        caption: &str,
        key: &str,
    ) -> Result<Remote> {
        self.check()?;
        let digest =
            Sha256::digest(format!("{}:{:?}:{key}", self.account.owner, self.folder).as_bytes());
        let random_id = i64::from_le_bytes(digest[..8].try_into().map_err(err)?);
        let updates = self
            .client
            .invoke(&tl::functions::messages::SendMedia {
                silent: true,
                background: false,
                clear_draft: false,
                peer: grammers_session::types::PeerRef::from(&self.peer).into(),
                reply_to: None,
                media,
                message: caption.into(),
                random_id,
                reply_markup: None,
                entities: None,
                schedule_date: None,
                schedule_repeat_period: None,
                send_as: None,
                noforwards: false,
                update_stickersets_order: false,
                invert_media: false,
                quick_reply_shortcut: None,
                effect: None,
                allow_paid_floodskip: false,
                allow_paid_stars: None,
                suggested_post: None,
            })
            .await
            .map_err(crate::commands::utils::map_error)?;
        self.check()?;
        let updates = match updates {
            tl::enums::Updates::Updates(u) => u.updates,
            tl::enums::Updates::Combined(u) => u.updates,
            _ => Vec::new(),
        };
        for update in updates {
            if let tl::enums::Update::MessageId(update) = update {
                if update.random_id == random_id {
                    return remote(&self.message(update.id).await?);
                }
            }
        }
        self.find(caption)
            .await?
            .ok_or_else(|| err("Publication response is ambiguous; retry safely to recover it"))
    }
    async fn message(&self, id: i32) -> Result<Message> {
        self.check()?;
        self.account.validate_client(&self.client).await?;
        let message = self
            .client
            .get_messages_by_id(&self.peer, &[id])
            .await
            .map_err(err)?
            .into_iter()
            .flatten()
            .next()
            .ok_or_else(|| err("A multipart document is missing"))?;
        self.check()?;
        Ok(message)
    }
}

impl<'a> Telegram<'a> {
    #[allow(clippy::too_many_arguments)] // Explicit account/destination/credential scope for a remote mutation.
    pub(crate) fn operation(
        app: &tauri::AppHandle,
        account: AccountGuard,
        client: Client,
        peer: Peer,
        folder: Option<i64>,
        crypto: &'a CryptoState,
        session: Option<u64>,
    ) -> Self {
        use tauri::Manager;
        Self {
            account,
            client,
            peer,
            folder,
            bandwidth: app.state::<Arc<BandwidthManager>>().inner().clone(),
            network: app.state::<Arc<NetworkConfig>>().inner().clone(),
            crypto: Some(crypto),
            session,
            cancelled: None,
            app: None,
            transfer: String::new(),
            upload: false,
            source: None,
            total: AtomicU64::new(0),
        }
    }
}

impl Transport for Telegram<'_> {
    fn account(&self) -> &AccountGuard {
        &self.account
    }
    fn bandwidth(&self) -> Arc<BandwidthManager> {
        self.bandwidth.clone()
    }
    fn check(&self) -> Result<()> {
        self.account.validate()?;
        if let (Some(crypto), Some(session)) = (self.crypto, self.session) {
            crypto.with_current_session(session, || ()).map_err(err)?;
        }
        if self
            .cancelled
            .as_ref()
            .is_some_and(|set| set.try_read().is_ok_and(|set| set.contains(&self.transfer)))
        {
            return Err("Transfer cancelled".into());
        }
        Ok(())
    }
    fn progress(&self, bytes: u64, total: u64) {
        self.total.store(total, Ordering::Relaxed);
        if let Some(app) = &self.app {
            if !self.transfer.is_empty() {
                let event = if self.upload {
                    "upload-progress"
                } else {
                    "download-progress"
                };
                let _ = app.emit(event, serde_json::json!({"id":self.transfer,"percent":bytes.saturating_mul(100).checked_div(total).unwrap_or(0).min(100),"uploaded_bytes":bytes,"total_bytes":total,"speed_bytes_per_sec":0}));
            }
        }
    }
    async fn put(
        &self,
        mut reader: Reader,
        size: u64,
        name: &str,
        caption: &str,
        key: &str,
        header: Option<&[u8]>,
    ) -> Result<Remote> {
        self.check()?;
        if let Some(remote) = self.find(caption).await? {
            // Deterministically reproduce and hash the pending envelope even
            // when its already-published message is recovered after a crash.
            let mut digest = Sha256::new();
            let mut count = 0_u64;
            let mut buffer = vec![0; 256 * 1024];
            loop {
                self.check()?;
                let n = reader.read(&mut buffer).await.map_err(err)?;
                if n == 0 {
                    break;
                }
                count += n as u64;
                if count > size {
                    return Err(err("Recovered source exceeds piece length"));
                }
                digest.update(&buffer[..n]);
            }
            buffer.zeroize();
            if count != size {
                return Err(err("Recovered source is truncated"));
            }
            verify_remote(self, &remote, &hex::encode(digest.finalize())).await?;
            return Ok(remote);
        }
        let uploaded = if let Some(source) = &self.source {
            let resumable = ResumableUpload::new(
                &self.account,
                crate::resumable_upload::session_key(self.folder, Path::new(key), "multipart-v1"),
                source.clone(),
            );
            let sink = PacedSink {
                sink: TelegramSink(self.client.clone()),
                traffic: self.traffic(Direction::Upload),
            };
            let result = resumable
                .upload(&sink, &mut reader, size, name, header)
                .await;
            match result {
                Ok(parts) => parts.into_uploaded(),
                Err(crate::resumable_upload::UploadError::Stale(reason)) => {
                    resumable.discard().await?;
                    return Err(err(format!("Retry this piece: {reason}")));
                }
                Err(crate::resumable_upload::UploadError::Failed(reason)) => return Err(reason),
            }
        } else {
            let mut reader = crate::traffic::Reader::new(reader, self.traffic(Direction::Upload));
            self.client
                .upload_stream(&mut reader, size as usize, name.into())
                .await
                .map_err(err)?
        };
        self.check()?;
        self.publish(
            tl::types::InputMediaUploadedDocument {
                nosound_video: true,
                force_file: true,
                spoiler: false,
                file: uploaded.raw,
                thumb: None,
                mime_type: "application/octet-stream".into(),
                attributes: vec![tl::types::DocumentAttributeFilename {
                    file_name: name.into(),
                }
                .into()],
                stickers: None,
                ttl_seconds: None,
                video_cover: None,
                video_timestamp: None,
            }
            .into(),
            caption,
            key,
        )
        .await
    }
    async fn remove(&self, expected: &Remote) -> Result<()> {
        self.check()?;
        self.account.validate_client(&self.client).await?;
        let messages = self
            .client
            .get_messages_by_id(&self.peer, &[expected.id])
            .await
            .map_err(err)?;
        if let Some(message) = messages.into_iter().flatten().next() {
            if remote(&message)? != *expected {
                return Err(err(
                    "Deletion target changed; no unrelated document was removed",
                ));
            }
            self.check()?;
            self.client
                .delete_messages(&self.peer, &[expected.id])
                .await
                .map_err(err)?;
            if self
                .client
                .get_messages_by_id(&self.peer, &[expected.id])
                .await
                .map_err(err)?
                .into_iter()
                .flatten()
                .next()
                .is_some()
            {
                return Err(err(
                    "Telegram did not confirm document deletion; retry cleanup",
                ));
            }
        }
        self.check()
    }
    async fn copy_from(&self, source: &Self, expected: &Remote, key: &str) -> Result<Remote> {
        source.check()?;
        self.check()?;
        if source.account.owner != self.account.owner {
            return Err(err("Move account mismatch"));
        }
        if let Some(existing) = self.find(&expected.caption).await? {
            return Ok(existing);
        }
        let message = source.message(expected.id).await?;
        if remote(&message)? != *expected {
            return Err(err("Move source changed"));
        }
        let media = message
            .media()
            .and_then(|media| media.to_raw_input_media())
            .ok_or_else(|| err("Move media is unavailable"))?;
        self.publish(media, &expected.caption, key).await
    }
    async fn find(&self, caption: &str) -> Result<Option<Remote>> {
        self.check()?;
        let mut search = self
            .client
            .search_messages(&self.peer)
            .query(caption)
            .limit(20);
        let mut found = None;
        let mut scanned = 0;
        while let Some(message) = search.next().await.map_err(err)? {
            scanned += 1;
            self.check()?;
            if message.text() == caption {
                if found.is_some() {
                    return Err(err(
                        "Duplicate publication; inspect and recover this set before retrying",
                    ));
                }
                found = Some(remote(&message)?);
            }
        }
        if scanned == 20 {
            return Err(err(
                "Publication search exceeded its bound; inspect the set before retrying",
            ));
        }
        Ok(found)
    }
    async fn open(&self, id: i32) -> Result<(Remote, Reader)> {
        let message = self.message(id).await?;
        let object = remote(&message)?;
        let media = message.media().ok_or_else(|| err("Missing document"))?;
        let mut download = self.client.iter_download(&media);
        let traffic = self.traffic(Direction::Download);
        let (reader, mut writer) = tokio::io::duplex(256 * 1024);
        let failed = Arc::new(Mutex::new(None));
        let result = failed.clone();
        let task = tokio::spawn(async move {
            let outcome: Result<()> = async {
                while let Some(bytes) = download.next().await.map_err(err)? {
                    traffic.wait(bytes.len()).await?;
                    writer.write_all(&bytes).await.map_err(err)?;
                }
                Ok(())
            }
            .await;
            if let Err(error) = outcome {
                *result.lock().unwrap_or_else(|p| p.into_inner()) = Some(error);
            }
            let _ = writer.shutdown().await;
        });
        Ok((
            object,
            Box::new(RemoteReader {
                reader,
                failed,
                task,
            }),
        ))
    }
    async fn lookup(&self, id: i32) -> Result<Option<Remote>> {
        self.check()?;
        self.account.validate_client(&self.client).await?;
        let message = self
            .client
            .get_messages_by_id(&self.peer, &[id])
            .await
            .map_err(crate::commands::utils::map_error)?
            .into_iter()
            .flatten()
            .next();
        self.check()?;
        message.as_ref().map(remote).transpose()
    }
}

struct RemoteReader {
    reader: tokio::io::DuplexStream,
    failed: Arc<Mutex<Option<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl AsyncRead for RemoteReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.reader).poll_read(cx, buffer);
        if matches!(&result, Poll::Ready(Ok(()))) && before == buffer.filled().len() {
            if let Some(error) = self.failed.lock().unwrap_or_else(|p| p.into_inner()).take() {
                return Poll::Ready(Err(std::io::Error::other(error)));
            }
        }
        result
    }
}
impl Drop for RemoteReader {
    fn drop(&mut self) {
        self.task.abort();
    }
}
