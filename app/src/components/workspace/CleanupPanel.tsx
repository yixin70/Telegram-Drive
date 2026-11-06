import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore } from 'lucide-react';
import { listRemovals, restoreRemoval } from '../../services/cleanup';

const control = 'min-h-11 rounded-xl border border-telegram-border bg-telegram-surface px-3 text-sm';

export function CleanupPanel({ ownerId }: { ownerId: string }) {
    const { t, i18n } = useTranslation();
    const queryClient = useQueryClient();
    const currentOwner = useRef(ownerId);
    currentOwner.current = ownerId;
    const operation = useRef(0);
    const errorNotice = useRef<HTMLParagraphElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const removals = useQuery({ queryKey: ['removals', ownerId], queryFn: () => listRemovals(ownerId), refetchInterval: 15_000 });

    useEffect(() => {
        operation.current++;
        setBusy(false);
        setError(null);
        return () => { operation.current++; };
    }, [ownerId]);
    useEffect(() => {
        if (error || removals.isError) {
            errorNotice.current?.scrollIntoView?.({ block: 'nearest' });
            errorNotice.current?.focus({ preventScroll: true });
        }
    }, [error, removals.isError]);

    const restore = async (key: string) => {
        const token = ++operation.current;
        const isCurrent = () => token === operation.current && currentOwner.current === ownerId;
        setBusy(true);
        setError(null);
        try {
            await restoreRemoval(ownerId, key);
            if (!isCurrent()) return;
            await queryClient.invalidateQueries({ queryKey: ['removals', ownerId] });
            await queryClient.invalidateQueries({ queryKey: ['workspace', ownerId] });
        } catch {
            if (isCurrent()) setError(t('cleanup.error'));
        } finally {
            if (isCurrent()) setBusy(false);
        }
    };
    const date = (value: number) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(value);

    return <section className="space-y-5">
        <h2 className="text-xl font-semibold">{t('cleanup.recovery_title')}</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-telegram-subtext">{t('cleanup.retention_explanation')}</p>
        {(error || removals.isError) && <p ref={errorNotice} tabIndex={-1} role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-400 outline-none">{error || t('cleanup.error')}</p>}
        {!removals.data?.length && <p className="text-sm text-telegram-subtext">{t('cleanup.recovery_empty')}</p>}
        {removals.data?.map(removal => <article key={removal.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-telegram-border p-3">
            <div className="min-w-0 flex-1 basis-60">
                <p className="break-words text-sm font-medium">{removal.file.name}</p>
                <p className="mt-1 break-words text-xs text-telegram-subtext">{removal.file.folderName} · {t(`cleanup.status.${removal.status}`)}</p>
                {removal.status === 'pending' && <p className="mt-1 text-xs">{t('cleanup.removal_date', { date: date(removal.deleteAfter) })}</p>}
                {removal.error && <p className="text-xs text-amber-400">{t(removal.error === 'FILE_CHANGED' ? 'cleanup.file_changed' : 'cleanup.waiting_network')}</p>}
            </div>
            {['pending', 'failed'].includes(removal.status) && <button type="button" disabled={busy} onClick={() => void restore(removal.key)} className={`${control} flex items-center gap-2 text-telegram-primary`}><ArchiveRestore className="h-4 w-4" />{t('cleanup.restore')}</button>}
        </article>)}
    </section>;
}
