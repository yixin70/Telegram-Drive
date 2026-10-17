import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {useTranslation} from 'react-i18next';
import {useNotesAccount} from '../../../../context/NotesAccountContext';
import {useConfirm} from '../../../../context/ConfirmContext';
import {invalidateNotes} from '../../../../services/fileNotes';
import type {NotesImportPreview} from '../../../../types/notes';

export default function NotesSettingsSection() {
    const owner = useNotesAccount(), {t} = useTranslation(), {confirm} = useConfirm();
    const [path, setPath] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const [preview, setPreview] = useState<NotesImportPreview | null>(null), [policy, setPolicy] = useState('keep');
    const generation = useRef(0);
    useLayoutEffect(() => {
        generation.current++;
        setPath(''); setPreview(null); setMessage(''); setBusy(false);
        return () => {generation.current++;};
    }, [owner]);
    useEffect(() => {
        let disposed = false;
        if (owner) void invoke<{path: string}>('cmd_notes_backup', {ownerId: owner, action: 'info'}).then(info => {if (!disposed) setPath(info.path);}).catch(() => {if (!disposed) setMessage(t('notes.backup_error'));});
        return () => {disposed = true;};
    }, [owner, t]);
    const act = async (action: string) => {
        if (!owner || busy) return;
        const epoch = generation.current;
        setBusy(true); setMessage('');
        try {
            if (action === 'import' && !await confirm({title: t('notes.import'), message: t('notes.import_confirm'), confirmText: t('notes.import'), variant: policy === 'replace' ? 'danger' : 'info'})) return;
            if (epoch !== generation.current) return;
            const result = await invoke<NotesImportPreview | null>('cmd_notes_backup', {ownerId: owner, action, previewToken: preview?.token, policy});
            if (epoch !== generation.current) return;
            if (action === 'preview') {setPreview(result); setPolicy('keep');}
            else if (action === 'cancel') setPreview(null);
            else if (action === 'import') {invalidateNotes(); setPreview(null); setMessage(t('notes.imported'));}
            else if (action === 'export' && result) setMessage(t('notes.exported'));
        } catch {if (epoch === generation.current) setMessage(t('notes.backup_error'));}
        finally {if (epoch === generation.current) setBusy(false);}
    };
    return <section className="quiet-surface space-y-3 p-4" aria-labelledby="local-notes-heading">
        <h3 id="local-notes-heading" className="font-semibold text-app-text">{t('notes.local')}</h3>
        <p className="text-sm text-app-text-secondary">{t('notes.backup_warning')}</p>
        <p className="break-all font-mono text-xs text-app-text-secondary">{path}</p>
        <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => {void act('open');}}>{t('notes.open_folder')}</button>
            <button type="button" disabled={busy} onClick={() => {void act('export');}}>{t('notes.export')}</button>
            <button type="button" disabled={busy} onClick={() => {void act('preview');}}>{t('notes.import')}</button>
        </div>
        {preview && <div className="space-y-3 border-t border-app-border pt-3">
            <p>{t('notes.import_preview', {records: preview.records, conflicts: preview.conflicts})}</p>
            <label className="block text-sm">{t('notes.conflicts')}<select className="ms-2 rounded bg-app-surface p-2" value={policy} onChange={event => setPolicy(event.target.value)} disabled={busy}>
                <option value="keep">{t('notes.keep')}</option><option value="replace">{t('notes.replace')}</option><option value="both">{t('notes.both')}</option>
            </select></label>
            <button type="button" disabled={busy} onClick={() => {void act('import');}}>{t('notes.confirm_import')}</button>
            <button type="button" className="ms-3" disabled={busy} onClick={() => {void act('cancel');}}>{t('common.cancel')}</button>
        </div>}
        {message && <p role="status" className="text-sm text-app-text-secondary">{message}</p>}
    </section>;
}
