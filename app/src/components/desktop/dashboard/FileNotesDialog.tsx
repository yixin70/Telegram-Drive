import {lazy, Suspense, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {invoke} from '@tauri-apps/api/core';
import {useTranslation} from 'react-i18next';
import {useFileNotes} from '../../../hooks/useFileNotes';
import {useModalFocus} from '../../../hooks/useModalFocus';
import {useConfirm} from '../../../context/ConfirmContext';
import type {NoteLocation} from '../../../types/notes';

const UnlockVault = lazy(() => import('./VaultUnlockDialog'));
export default function FileNotesDialog({owner, name, location, onClose}: {owner: string; name: string; location: NoteLocation; onClose: () => void}) {
    const {t} = useTranslation(), {confirm, promptSecret} = useConfirm();
    const {note, session} = useFileNotes(owner, location);
    const [draft, setDraft] = useState(note.text ?? '');
    const [base, setBase] = useState({text: note.text ?? '', revision: note.revision ?? 0, ready: note.state === 'ready', protected: note.protected});
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [unlockVault, setUnlockVault] = useState(false), [confirming, setConfirming] = useState(false);
    const panel = useRef<HTMLDivElement>(null), alive = useRef(true), pending = useRef(false);
    useLayoutEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
    useLayoutEffect(() => {
        if (note.state === 'ready') panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }, [note.state]);
    useLayoutEffect(() => {
        if (!base.ready && note.state === 'ready') {setDraft(note.text ?? ''); setBase({text: note.text ?? '', revision: note.revision ?? 0, ready: true, protected: note.protected});}
        if (base.ready && (note.state !== 'ready' || note.protected !== base.protected)) {setDraft(''); onClose();}
    }, [note, base, onClose]);
    const close = async () => {
        if (pending.current) return;
        if (draft !== base.text) {
            setConfirming(true);
            const discard = await confirm({title: t('notes.title'), message: t('notes.discard'), confirmText: t('notes.discard_action'), variant: 'danger'});
            setConfirming(false);
            if (!discard || !alive.current) return;
        }
        setDraft(''); onClose();
    };
    useModalFocus(panel, () => {void close();}, true, unlockVault || confirming);
    const operation = async (action: 'save' | 'delete' | 'unlock', promptToken?: number) => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        try {
            await session.mutate(location, action, base.revision, action === 'save' ? draft : undefined, promptToken);
            if (alive.current && action !== 'unlock') {setDraft(''); onClose();}
        } catch (failure) {if (alive.current) setError(t(String(failure).includes('NOTES_CONFLICT') ? 'notes.conflict' : 'notes.write_error'));}
        finally {pending.current = false; if (alive.current) setBusy(false);}
    };
    const unlockFile = async () => {
        setConfirming(true);
        let secret = await promptSecret({title: t('notes.unlock_file'), message: t('notes.locked'), minBytes: 8});
        setConfirming(false);
        if (!secret || !alive.current) return;
        try {
            const promptToken = await invoke<number>('cmd_stage_file_passphrase', {passphrase: secret}); secret = null;
            if (alive.current) await operation('unlock', promptToken);
        } catch {if (alive.current) setError(t('notes.write_error'));}
    };
    const remove = async () => {
        setConfirming(true);
        const accepted = await confirm({title: t('notes.delete'), message: t('notes.delete_confirm'), confirmText: t('notes.delete'), variant: 'danger'});
        setConfirming(false);
        if (accepted && alive.current) await operation('delete');
    };
    if (base.ready && note.state !== 'ready') return null;
    return createPortal(<>
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-app-overlay p-4" onMouseDown={() => {void close();}}>
            <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="video-notes-title" tabIndex={-1} className="quiet-raised w-full max-w-lg space-y-4 p-5 text-app-text" onMouseDown={event => event.stopPropagation()}>
                <h2 id="video-notes-title" className="text-lg font-semibold">{t('notes.title')}</h2>
                <p className="truncate text-sm text-app-text-secondary">{name}</p>
                {note.state === 'ready' ? <label className="block text-sm">{t('notes.text')}<textarea data-modal-autofocus aria-label={t('notes.text')} value={draft} onChange={event => setDraft(event.target.value)} rows={8} className="mt-2 w-full rounded border border-app-border bg-app-surface p-3" disabled={busy} /></label> : <p>{t(note.state === 'locked' ? 'notes.locked' : note.state === 'loading' ? 'common.loading' : 'notes.read_error')}</p>}
                {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
                {note.state === 'locked' && <div className="flex flex-wrap gap-3"><button type="button" onClick={() => setUnlockVault(true)}>{t('notes.unlock_vault')}</button><button type="button" onClick={() => {void unlockFile();}} disabled={busy}>{t('notes.unlock_file')}</button></div>}
                <div className="flex flex-wrap justify-end gap-3">
                    {!!base.revision && <button type="button" onClick={() => {void remove();}} disabled={busy} className="me-auto text-red-500">{t('notes.delete')}</button>}
                    <button type="button" onClick={() => {void close();}} disabled={busy}>{t('common.cancel')}</button>
                    <button type="button" className="rounded bg-app-accent px-4 py-2 text-app-accent-contrast disabled:opacity-50" disabled={busy || note.state !== 'ready' || new TextEncoder().encode(draft).length > 65536} onClick={() => {void operation('save');}}>{t('common.save')}</button>
                </div>
            </div>
        </div>
        {unlockVault && <Suspense fallback={null}><UnlockVault onClose={() => setUnlockVault(false)} /></Suspense>}
    </>, document.body);
}
