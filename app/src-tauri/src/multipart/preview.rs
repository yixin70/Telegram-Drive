//! Bounded original-quality protected media. Partial reads authenticate the
//! manifest, envelope identity and requested records, not unrequested bytes.
use super::*;
use crate::crypto::envelope::{header::EnvelopeHeader, range::chunk_ciphertext_offset};
use crate::server::ProtectedStreamAccess;

pub(crate) async fn authorized<F, R>(access: &ProtectedStreamAccess, operation: F) -> Result<R>
where
    F: std::future::Future<Output = Result<R>>,
{
    tokio::pin!(operation);
    let mut ticks = tokio::time::interval(std::time::Duration::from_millis(200));
    loop {
        access.validate()?;
        tokio::select! {
            result = &mut operation => { access.validate()?; return result; },
            _ = ticks.tick() => {},
        }
    }
}

pub(crate) fn chunks<T: Transport + 'static>(
    transport: T,
    manifest: Manifest,
    key: SecretKey,
    start: u64,
    end: u64,
    access: ProtectedStreamAccess,
) -> impl futures::Stream<Item = Result<bytes::Bytes>> {
    async_stream::try_stream! {
        let whole_file = start == 0 && end == manifest.length - 1;
        let mut whole = Sha256::new();
        let mut base = 0_u64;
        for part in &manifest.parts {
            let part_end = base + part.length;
            if start >= part_end { base = part_end; continue; }
            if end < base { break; }
            access.validate()?;
            let from = start.saturating_sub(base);
            let to = (end - base).min(part.length - 1);
            let complete = from == 0 && to == part.length - 1;
            let (remote, mut reader) = authorized(&access, transport.open_range(part.remote.id, 0)).await?;
            if remote != part.remote { Err(err("Piece identity changed"))?; }
            let header_bytes = authorized(&access, header(&mut reader)).await?;
            if envelope_mode(&header_bytes)? != manifest.mode {
                Err(err("Piece protection mode differs from its manifest"))?;
            }
            let header = EnvelopeHeader::parse(&header_bytes).map_err(err)?;
            let (mut decoder, _) = authorized(&access,
                initialize_tdenc2_decryptor_off_worker(&header_bytes, Some(&key), None)).await?;
            if part.envelope.as_deref() != Some(uuid::Uuid::from_bytes(*decoder.file_uuid()).to_string().as_str())
                || decoder.plaintext_length() != part.length {
                Err(err("Piece envelope identity changed"))?;
            }
            let chunk_size = u64::from(header.core.chunk_size);
            let expected_size = header_bytes.len() as u64 + part.length
                + part.length.div_ceil(chunk_size) * policy::AEAD_TAG_LENGTH as u64
                + policy::FINAL_RECORD_CIPHERTEXT_SIZE as u64;
            if remote.size != expected_size { Err(err("Piece envelope size changed"))?; }
            let first = (from / chunk_size) as u32;
            let last = (to / chunk_size) as u32;
            let mut digest = Sha256::new();
            if complete {
                digest.update(&header_bytes);
            } else {
                drop(reader);
                let offset = header_bytes.len() as u64
                    + chunk_ciphertext_offset(first, header.core.chunk_size, part.length).map_err(err)?;
                let (remote, ranged) = authorized(&access, transport.open_range(part.remote.id, offset)).await?;
                if remote != part.remote { Err(err("Piece identity changed during seek"))?; }
                reader = ranged;
            }
            for index in first..=last {
                let offset = u64::from(index) * chunk_size;
                let length = (part.length - offset).min(chunk_size) as usize;
                let mut ciphertext = vec![0; length + policy::AEAD_TAG_LENGTH];
                authorized(&access, async { reader.read_exact(&mut ciphertext).await.map_err(err) }).await?;
                let plaintext = if complete {
                    digest.update(&ciphertext);
                    decoder.feed(&ciphertext).map_err(err)?
                } else {
                    decoder.decrypt_chunk_at(index, &ciphertext).map_err(err)?
                };
                let mut plaintext = zeroize::Zeroizing::new(plaintext);
                if whole_file { whole.update(&*plaintext); }
                // Withhold the final record of each complete piece until all of
                // its integrity checks pass; withhold the logical final bytes
                // until the whole-file digest matches as well.
                if complete && index == last {
                    let mut footer = vec![0; policy::FINAL_RECORD_CIPHERTEXT_SIZE];
                    authorized(&access, async { reader.read_exact(&mut footer).await.map_err(err) }).await?;
                    digest.update(&footer);
                    decoder.feed(&footer).map_err(err)?;
                    decoder.finish().map_err(err)?;
                    let mut extra = [0];
                    let trailing = authorized(&access, async { reader.read(&mut extra).await.map_err(err) }).await?;
                    if trailing != 0 || hex::encode(digest.clone().finalize()) != part.sha256 {
                        Err(err("Piece digest or length mismatch"))?;
                    }
                    if whole_file && part_end == manifest.length
                        && hex::encode(whole.clone().finalize()) != manifest.sha256 {
                        Err(err("Whole-file digest mismatch"))?;
                    }
                }
                access.validate()?;
                let begin = from.saturating_sub(offset) as usize;
                let finish = (to - offset + 1).min(length as u64) as usize;
                let output = bytes::Bytes::copy_from_slice(&plaintext[begin..finish]);
                plaintext.zeroize();
                yield output;
            }
            base = part_end;
        }
    }
}
