import {Check} from 'lucide-react';

/** Identical quality markers in both virtualized file layouts. */
export function CachedQualityBadges({variants, className}: {variants?: {available: boolean; quality: string}[]; className: string}) {
    const qualities = (variants ?? []).filter(variant => variant.available).map(variant => variant.quality);
    return qualities.length ? <span className={className}>{qualities.map(quality => <span key={quality} className="inline-flex items-center gap-0.5 rounded bg-emerald-500/10 px-1 py-0.5 text-badge font-medium text-emerald-400"><Check className="h-2.5 w-2.5" />{quality}</span>)}</span> : null;
}
