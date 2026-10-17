// Decode only a poster frame, without FFmpeg or a persistent plaintext file.
// Limit simultaneous decoders; cache invalidation also cancels queued work.
let active = 0;
const waiting: Array<() => void> = [];

function acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (active < 2) { active++; return Promise.resolve(true); }
    return new Promise(resolve => {
        const start = () => { signal.removeEventListener('abort', cancel); resolve(true); };
        const cancel = () => {
            const index = waiting.indexOf(start);
            if (index !== -1) waiting.splice(index, 1);
            resolve(false);
        };
        waiting.push(start);
        signal.addEventListener('abort', cancel, { once: true });
    });
}

export async function captureVideoThumbnail(url: string, signal: AbortSignal): Promise<string | null> {
    if (!await acquire(signal)) return null;
    try {
        if (signal.aborted) return null;
        return await new Promise<string | null>(resolve => {
            const video = document.createElement('video');
            let finished = false;
            let target: number | undefined;
            const finish = (image: string | null) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
                video.pause();
                video.removeAttribute('src');
                video.load();
                resolve(signal.aborted ? null : image);
            };
            const cancel = () => finish(null);
            const timer = setTimeout(cancel, 12_000);
            const capture = () => {
                if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return;
                const canvas = document.createElement('canvas');
                const scale = Math.min(1, 320 / video.videoWidth, 180 / video.videoHeight);
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                try {
                    const context = canvas.getContext('2d');
                    if (!context) { finish(null); return; }
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    finish(canvas.toDataURL('image/jpeg', 0.8));
                } catch {
                    // Unsupported codec or a source without canvas CORS permission.
                    finish(null);
                } finally {
                    canvas.width = canvas.height = 0;
                }
            };
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.crossOrigin = 'anonymous';
            video.onloadedmetadata = () => {
                target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(1, video.duration / 10) : 0;
                if (target > 0) video.currentTime = target;
                else capture();
            };
            video.onloadeddata = () => { if (target === 0) capture(); };
            video.onseeked = capture;
            video.onerror = cancel;
            signal.addEventListener('abort', cancel, { once: true });
            video.src = url;
            video.load();
        });
    } finally {
        const next = waiting.shift();
        if (next) next(); else active--;
    }
}
