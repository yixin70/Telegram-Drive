import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TelegramFile } from '../types';
import { isVideoFile } from '../utils';
import { useEncryption } from './useEncryption';
import { sourceFolder } from '../services/fileIdentity';
import { forgetThumbnail, getCachedThumbnail, getImageCacheKey, imageCacheVersion,
    loadThumbnail, loadVideoThumbnail, subscribeImageCache } from '../services/imagePreviewCache';

export function useFileThumbnail(file: TelegramFile, activeFolderId?: number | null, enabled = true) {
    const generation = useSyncExternalStore(subscribeImageCache, imageCacheVersion, imageCacheVersion);
    const { vaultStatus } = useEncryption();
    const folder = sourceFolder(file, activeFolderId ?? null);
    const video = isVideoFile(file.name);
    const image = /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.name);
    const state = file.encryption?.state ?? file.encryption_state ?? 'plain';
    const protectedMedia = state !== 'plain';
    const mode = file.encryption?.protection_mode;
    const session = protectedMedia ? vaultStatus?.session_id ?? undefined : undefined;
    const readable = !protectedMedia || (video && state === 'encrypted_unlocked' && vaultStatus?.is_unlocked === true &&
        session !== undefined && mode !== 'passphrase');
    const allowed = enabled && file.type !== 'folder' && (video || image) && readable;
    const key = JSON.stringify([getImageCacheKey(file.id, folder), generation, file.name, state, session, allowed]);
    const [result, setResult] = useState<{ key: string; src: string | null; loading: boolean } | null>(null);

    useEffect(() => {
        if (!allowed) { setResult(null); return; }
        let cancelled = false;
        const cached = getCachedThumbnail(file.id, folder, session);
        setResult({ key, src: cached, loading: !cached });
        const request = video ? loadVideoThumbnail(file.id, folder, session) : loadThumbnail(file.id, folder);
        void request.catch(() => null).then(src => {
            if (!cancelled) setResult({ key, src, loading: false });
        });
        return () => { cancelled = true; };
    }, [key, allowed, file.id, folder, session, video]);

    return {
        thumbnail: allowed && result?.key === key ? result.src : null,
        loading: allowed && (result?.key !== key || result.loading),
        forget: () => {
            forgetThumbnail(file.id, folder, session);
            setResult({ key, src: null, loading: false });
        },
    };
}
