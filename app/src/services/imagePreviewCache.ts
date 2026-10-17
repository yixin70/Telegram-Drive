import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { isImageCacheEntryExpired, PREVIEW_CACHE_MAX_ITEMS, THUMBNAIL_CACHE_MAX_ITEMS } from './imageCachePolicy';
import { captureVideoThumbnail } from './videoThumbnail';

type Variant = 'preview' | 'thumbnail';
type CacheEntry = { src: string; cachedAt: number; bytes: number; variant: Variant };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<string | null>>();
const requests = new Set<AbortController>();
const MAX_BYTES = 128 * 1024 * 1024;
let cacheGeneration = 0;
const subscribers = new Set<() => void>();
let owner: string | null = null;
let measuring = 0;
const measurementQueue: Array<() => void> = [];

export const getImageCacheKey = (fileId: number, folderId?: number | null): string =>
    JSON.stringify([owner, folderId ?? 'home', fileId]);
const keyFor = (variant: Variant, fileId: number, folderId?: number | null, vaultSession?: number) =>
    `${variant}:${getImageCacheKey(fileId, folderId)}${vaultSession === undefined ? '' : `:vault:${vaultSession}`}`;
const normalizeAssetSource = (value: string): string => /^(?:data:|blob:|asset:|https?:)/i.test(value) ? value : convertFileSrc(value);

// The URL length cannot measure an image's decoded footprint. Unknown or failed
// probes are returned to the caller without being retained in the memory cache.
async function imageBytes(src: string): Promise<number> {
    if (measuring >= 3) await new Promise<void>(resolve => measurementQueue.push(resolve));
    else measuring++;
    try {
        return await new Promise<number>(resolve => {
            const image = new Image();
            const finish = (bytes: number) => {
                clearTimeout(timer);
                image.onload = null; image.onerror = null;
                resolve(bytes);
            };
            const timer = setTimeout(() => finish(MAX_BYTES + 1), 2000);
            image.onload = () => finish(image.naturalWidth * image.naturalHeight * 4 + (src.startsWith('data:') ? src.length * 2 : 0));
            image.onerror = () => finish(MAX_BYTES + 1);
            image.src = src;
        });
    } finally {
        const next = measurementQueue.shift();
        if (next) next(); else measuring--;
    }
}
function remember(key: string, entry: CacheEntry): void {
    cache.delete(key);
    if (entry.bytes > MAX_BYTES) return;
    cache.set(key, entry);
    const max = entry.variant === 'preview' ? PREVIEW_CACHE_MAX_ITEMS : THUMBNAIL_CACHE_MAX_ITEMS;
    for (;;) {
        const values = [...cache.values()];
        if (values.reduce((total, value) => total + value.bytes, 0) <= MAX_BYTES && values.filter(value => value.variant === entry.variant).length <= max) break;
        const oldest = [...cache].find(([, value]) => values.reduce((total, item) => total + item.bytes, 0) > MAX_BYTES || value.variant === entry.variant);
        if (!oldest) break;
        cache.delete(oldest[0]);
    }
}
function read(key: string): string | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (isImageCacheEntryExpired(entry.cachedAt)) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, entry);
    return entry.src;
}
function load(variant: Variant, fileId: number, folderId?: number | null,
    producer?: (signal: AbortSignal) => Promise<string | null>, vaultSession?: number): Promise<string | null> {
    const key = keyFor(variant, fileId, folderId, vaultSession);
    const cached = read(key);
    if (cached) return Promise.resolve(cached);
    const existing = pending.get(key);
    if (existing) return existing;
    const generation = cacheGeneration;
    const controller = new AbortController();
    requests.add(controller);
    const source = producer ? producer(controller.signal) : invoke<string>(variant === 'preview' ? 'cmd_get_display_preview' : 'cmd_get_thumbnail', {
        messageId: fileId, folderId: folderId ?? null,
    });
    const request = source.then(async path => {
        if (!path || generation !== cacheGeneration) return null;
        const src = normalizeAssetSource(path);
        const bytes = await imageBytes(src);
        if (generation !== cacheGeneration) return null;
        remember(key, { src, bytes, cachedAt: Date.now(), variant });
        return src;
    }).finally(() => { requests.delete(controller); if (pending.get(key) === request) pending.delete(key); });
    pending.set(key, request);
    return request;
}
export const getCachedPreview = (fileId: number, folderId?: number | null): string | null => read(keyFor('preview', fileId, folderId));
export const getCachedThumbnail = (fileId: number, folderId?: number | null, vaultSession?: number): string | null => read(keyFor('thumbnail', fileId, folderId, vaultSession));
export const loadPreview = (fileId: number, folderId?: number | null): Promise<string | null> => load('preview', fileId, folderId);
export const loadThumbnail = (fileId: number, folderId?: number | null): Promise<string | null> => load('thumbnail', fileId, folderId);
export const forgetPreview = (fileId: number, folderId?: number | null): void => { cache.delete(keyFor('preview', fileId, folderId)); };
export const forgetThumbnail = (fileId: number, folderId?: number | null, vaultSession?: number): void => { cache.delete(keyFor('thumbnail', fileId, folderId, vaultSession)); };
export const subscribeImageCache = (listener: () => void): (() => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
export const imageCacheVersion = (): number => cacheGeneration;
export const clearImageMemoryCaches = (notify = true): void => {
    for (const request of requests) request.abort();
    requests.clear();
    cacheGeneration++; cache.clear(); pending.clear();
    if (notify) for (const listener of subscribers) listener();
};

// A vault session selects a separate memory-only cache namespace. Never request
// a persistent/native thumbnail for protected originals, including TDMP1 media.
export function loadVideoThumbnail(fileId: number, folderId: number | null, vaultSession?: number): Promise<string | null> {
    return load('thumbnail', fileId, folderId, async signal => {
        if (vaultSession === undefined) {
            const existing = await invoke<string>('cmd_get_thumbnail', { messageId: fileId, folderId }).catch(() => null);
            if (signal.aborted) return null;
            if (existing) return existing;
        }
        if (signal.aborted) return null;
        const info = await invoke<{ base_url: string; token: string; operation_token?: string | null }>('cmd_get_stream_info');
        if (signal.aborted || (vaultSession !== undefined && !info.operation_token)) return null;
        const query = new URLSearchParams({ token: info.token });
        if (info.operation_token) query.set('credential', info.operation_token);
        return captureVideoThumbnail(`${info.base_url}/stream/${folderId ?? 'home'}/${fileId}?${query}`, signal);
    }, vaultSession);
}
export const setImageCacheAccount = (id: string | null): void => {
    if (owner !== id) { owner = id; clearImageMemoryCaches(false); }
};

export async function loadLocalPreview(fileId: number, folderId: number | null, localPath: string): Promise<string | null> {
    const generation = cacheGeneration;
    const path = await invoke<string>('cmd_get_display_preview', {messageId: fileId, folderId, localPath});
    return path && generation === cacheGeneration ? normalizeAssetSource(path) : null;
}
