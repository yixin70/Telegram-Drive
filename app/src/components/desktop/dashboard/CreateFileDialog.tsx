import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { MAX_INITIAL_TEXT_BYTES, validCreationFilename, type CreationProtection } from '../../../services/fileCreation';

interface Props {
    destination: string;
    onClose: () => void;
    prepareProtection: (count: number) => Promise<CreationProtection[] | null>;
    onCreate: (id: string, filename: string, content: string, protection: CreationProtection) => Promise<void>;
}

export function CreateFileDialog({ destination, onClose, prepareProtection, onCreate }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [content, setContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [choosing, setChoosing] = useState(false);
    const [error, setError] = useState('');
    const [uncertain, setUncertain] = useState(false);
    const submittedProtection = useRef<CreationProtection | null>(null);
    const id = useRef(crypto.randomUUID());
    const busy = useRef(false);
    const mounted = useRef(true);
    const panel = useRef<HTMLFormElement>(null);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const close = useCallback(() => { if (!busy.current) onClose(); }, [onClose]);
    useModalFocus(panel, close, true, choosing);
    const bytes = new TextEncoder().encode(content).length;
    const valid = validCreationFilename(name) && bytes > 0 && bytes <= MAX_INITIAL_TEXT_BYTES;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy.current || !valid) return;
        busy.current = true; setSaving(true); setError(''); setChoosing(!uncertain);
        let sent = false;
        try {
            const protection = uncertain && submittedProtection.current ? [submittedProtection.current] : await prepareProtection(1);
            if (!mounted.current) return;
            setChoosing(false);
            if (!protection) return;
            submittedProtection.current = protection[0];
            sent = true;
            await onCreate(id.current, name, content, protection[0]);
            if (mounted.current) onClose();
        } catch (failure) {
            if (mounted.current) {
                const reason = String(failure);
                const message = reason.includes('[FILE_EXISTS]') ? 'file_creation.file_exists'
                    : reason.includes('[FILE_NAME_INVALID]') ? 'file_creation.invalid_name'
                    : reason.includes('[TEXT_EMPTY]') ? 'file_creation.text_empty'
                    : reason.includes('[TEXT_TOO_LARGE]') ? 'viewer.text_too_large'
                    : /\[(CREATE_INVENTORY_INCOMPLETE|CREATE_NAMES_LOCKED|VAULT_LOCKED)\]/.test(reason) ? 'file_creation.destination_unavailable'
                    : 'file_creation.failed';
                setError(t(message));
                // A lost IPC response may contain no backend error code at all.
                // Only explicit pre-admission refusals allow editing this ID.
                const refused = /\[(FILE_EXISTS|FILE_NAME_INVALID|TEXT_EMPTY|TEXT_TOO_LARGE|CREATE_INVENTORY_INCOMPLETE|CREATE_NAMES_LOCKED)\]/.test(reason);
                if (sent && !refused) setUncertain(true);
            }
        } finally {
            busy.current = false;
            if (mounted.current) {
                setSaving(false); setChoosing(false);
                requestAnimationFrame(() => { if (mounted.current) panel.current?.querySelector('textarea')?.focus(); });
            }
        }
    };

    return <div className={`fixed inset-0 ${choosing ? 'z-[190]' : 'z-[210]'} flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm`} onMouseDown={close}>
        <form ref={panel} role="dialog" aria-modal="true" aria-labelledby="create-file-title" tabIndex={-1} onSubmit={submit} onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); }
        }} className="quiet-raised w-[min(560px,calc(100vw-2rem))] max-h-[90vh] overflow-auto p-5 space-y-4">
            <h2 id="create-file-title" className="text-base font-semibold text-app-text">{t('file_creation.title')}</h2>
            <p className="text-sm text-app-text-secondary">{t('hierarchy.destination', { path: destination })}</p>
            <label className="block text-sm text-app-text">{t('file_creation.filename')}
                <input data-modal-autofocus disabled={saving || uncertain} value={name} onChange={event => setName(event.target.value)} aria-describedby="create-file-name-help" className="quiet-control mt-2 w-full border border-app-border bg-app-surface-sunken px-3 py-2" />
            </label>
            <p id="create-file-name-help" className="text-xs text-app-text-secondary">{name && !validCreationFilename(name) ? t('file_creation.invalid_name') : t('file_creation.name_help')}</p>
            <label className="block text-sm text-app-text">{t('file_creation.content')}
                <textarea disabled={saving || uncertain} value={content} onChange={event => setContent(event.target.value)} aria-describedby="create-file-text-help" rows={7} className="quiet-control mt-2 w-full resize-y border border-app-border bg-app-surface-sunken p-3 font-mono" />
            </label>
            <p id="create-file-text-help" role="status" className="text-xs text-app-text-secondary">{bytes === 0 ? t('file_creation.text_empty') : bytes > MAX_INITIAL_TEXT_BYTES ? t('viewer.text_too_large') : t('file_creation.bytes', { count: bytes })}</p>
            <p className="text-xs text-app-text-secondary">{t('file_creation.format_help')}</p>
            {error && <p role="alert" className="text-sm text-app-danger break-words">{error}</p>}
            {uncertain && <p className="text-sm text-app-text-secondary">{t('file_creation.review_request')}</p>}
            <footer className="flex justify-end gap-3">
                <button type="button" disabled={saving} onClick={close} className="quiet-control px-4 py-2 disabled:opacity-50">{t('common.cancel')}</button>
                <button type="submit" disabled={saving || !valid} className="quiet-control bg-app-accent text-app-accent-contrast px-4 py-2 disabled:opacity-50">{saving ? t('ui_copy.creating') : uncertain ? t('file_creation.check_request') : t('file_creation.create')}</button>
            </footer>
        </form>
    </div>;
}
