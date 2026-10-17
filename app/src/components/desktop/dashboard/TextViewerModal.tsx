import { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { X, ChevronLeft, ChevronRight, Save, RotateCcw, FileText } from 'lucide-react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { TelegramFile } from '../../../types';
import i18n from '../../../i18n';
import { invalidateFolderFileQueries } from '../../../services/fileListRefresh';
import { useConfirm } from '../../../context/ConfirmContext';

const VaultUnlockDialog = lazy(() => import('./VaultUnlockDialog'));

interface TextFilePayload {
    content: string;
    size: number;
    truncated: boolean;
    encoding: string;
    encrypted?: boolean;
    ownerId?: string;
    accessGeneration?: number;
}

interface SavedTextFile {
    messageId: number;
    size: number;
}

interface TextViewerModalProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
    localPath?: string;
    ownerId?: string;
    onSaved?: (messageId: number) => void;
}

export function TextViewerModal({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId, localPath, ownerId, onSaved }: TextViewerModalProps) {
    useTranslation();
    const queryClient = useQueryClient();
    const { promptSecret } = useConfirm();
    const promptRef = useRef(promptSecret);
    promptRef.current = promptSecret;
    const [content, setContent] = useState('');
    const [original, setOriginal] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [openingExternal, setOpeningExternal] = useState(false);
    const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
    // The replacement message gets a new id after a save, so track it locally.
    const [messageId, setMessageId] = useState(file.id);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [access, setAccess] = useState<Pick<TextFilePayload, 'encrypted' | 'ownerId' | 'accessGeneration'>>({});
    const [unlockVault, setUnlockVault] = useState(false);
    const [reload, setReload] = useState(0);
    const pending = useRef(false);
    const prompting = useRef(false);
    const epoch = useRef(0);
    const savedIdentity = useRef<string | null>(null);
    const initialOwner = useRef(ownerId);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const protectedFile = Boolean(access.encrypted || (file.encryption_state && file.encryption_state !== 'plain'));

    useEffect(() => {
        if (initialOwner.current !== ownerId) {
            epoch.current++;
            setContent(''); setOriginal(''); setAccess({});
            closeRef.current();
            return;
        }
        let disposed = false;
        let stop: (() => void) | undefined;
        void listen('vault-locked', () => {
            if (disposed) return;
            epoch.current++;
            setContent(''); setOriginal(''); setAccess({});
            closeRef.current();
        }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
        return () => { disposed = true; epoch.current++; stop?.(); };
    }, [ownerId]);

    const textCommand = useCallback(async <T,>(command: string, args: Record<string, unknown>, current: number): Promise<T | null> => {
        try {
            return await invoke<T>(command, args);
        } catch (failure) {
            // This code is returned before any upload/publication. Other save
            // failures (including lost replies) must never be retried blindly.
            if (!String(failure).includes('[KEY_REQUIRED]') || current !== epoch.current) throw failure;
            prompting.current = true;
            let secret: string | null;
            try { secret = await promptRef.current({ title: i18n.t('settings.encryption_mode_passphrase'), minBytes: 8 }); }
            finally { prompting.current = false; }
            if (!secret || current !== epoch.current) return null;
            let promptToken: number;
            try { promptToken = await invoke<number>('cmd_stage_file_passphrase', { passphrase: secret }); }
            finally { secret = null; }
            if (current !== epoch.current) return null;
            return invoke<T>(command, { ...args, promptToken });
        }
    }, []);

    const dirty = content !== original;

    useEffect(() => {
        if (initialOwner.current !== ownerId) return;
        // A successful replacement changes its Telegram id, not the document
        // currently being edited. Keep the authenticated in-memory content and
        // do not ask for the file passphrase again just to reload our own save.
        if (savedIdentity.current === `${activeFolderId}:${file.id}`) {
            savedIdentity.current = null;
            return;
        }
        let cancelled = false;
        const current = ++epoch.current;
        const stale = () => cancelled || current !== epoch.current;
        setLoading(true);
        setError(null);
        setReadOnlyReason(null);
        setMessageId(file.id);
        setContent(''); setOriginal(''); setAccess({});

        const load = async () => {
            try {
                if (localPath && (!file.encryption_state || file.encryption_state === 'plain')) {
                    const response = await fetch(convertFileSrc(localPath));
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const text = await response.text();
                    if (stale()) return;
                    setContent(text);
                    setOriginal(text);
                    setLoading(false);
                    return;
                }
                const payload = await textCommand<TextFilePayload>('cmd_read_text_file', {
                    messageId: file.id,
                    folderId: activeFolderId,
                    ownerId,
                }, current);
                if (stale()) return;
                if (!payload) { setError(i18n.t('common.cancel')); setLoading(false); return; }
                setAccess({ encrypted: payload.encrypted, ownerId: payload.ownerId, accessGeneration: payload.accessGeneration });
                if (payload.truncated) {
                    setReadOnlyReason(i18n.t('viewer.text_too_large'));
                    setContent('');
                    setOriginal('');
                } else {
                    setContent(payload.content);
                    setOriginal(payload.content);
                }
                setLoading(false);
            } catch (err) {
                if (stale()) return;
                const message = String(err);
                if (message.includes('[TEXT_TOO_LARGE]')) {
                    setReadOnlyReason(i18n.t('viewer.text_too_large'));
                } else if (message.includes('[VAULT_LOCKED]')) {
                    setError(i18n.t('settings.vault_is_locked'));
                } else {
                    setError(message || i18n.t('common.operation_failed'));
                }
                setLoading(false);
            }
        };

        void load();
        return () => { cancelled = true; epoch.current++; };
    }, [file.id, activeFolderId, localPath, file.encryption_state, reload, textCommand, ownerId]);

    const handleSave = useCallback(async () => {
        if (!dirty || pending.current || loading || error || readOnlyReason) return;
        pending.current = true;
        const current = epoch.current;
        setSaving(true);
        try {
            const result = await textCommand<SavedTextFile>('cmd_save_text_file', {
                messageId,
                folderId: activeFolderId,
                content,
                ownerId: access.ownerId ?? ownerId,
                accessGeneration: access.accessGeneration,
            }, current);
            if (!result || current !== epoch.current) return;
            setOriginal(content);
            setMessageId(result.messageId);
            savedIdentity.current = `${activeFolderId}:${result.messageId}`;
            toast.success(i18n.t('viewer.text_saved'));
            void invalidateFolderFileQueries(queryClient, activeFolderId, access.ownerId);
            onSaved?.(result.messageId);
        } catch (err) {
            const message = String(err);
            if (current !== epoch.current) return;
            if (message.includes('[VAULT_LOCKED]') || message.includes('ACCOUNT_CHANGED')) {
                setContent(''); setOriginal(''); closeRef.current();
            } else if (/TEXT_TOO_LARGE/i.test(message)) {
                toast.error(i18n.t('viewer.text_too_large'));
            } else {
                toast.error(i18n.t('viewer.text_save_error'));
            }
            // A lost reply must never be retried blindly; re-list instead.
            void invalidateFolderFileQueries(queryClient, activeFolderId, access.ownerId);
        } finally {
            pending.current = false;
            if (current === epoch.current) setSaving(false);
        }
    }, [dirty, loading, error, readOnlyReason, messageId, activeFolderId, content, queryClient, onSaved, access, textCommand, ownerId]);

    const requestClose = useCallback(() => {
        if (pending.current || prompting.current) return;
        if (dirty && !window.confirm(i18n.t('viewer.text_discard_confirm'))) return;
        onClose();
    }, [dirty, onClose]);

    const requestNavigate = useCallback((navigate?: () => void) => {
        if (pending.current || prompting.current) return;
        if (!navigate) return;
        if (dirty && !window.confirm(i18n.t('viewer.text_discard_confirm'))) return;
        navigate();
    }, [dirty]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (prompting.current || unlockVault) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void handleSave();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                requestClose();
                return;
            }
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
                return;
            }
            const key = e.key.toLowerCase();
            if (e.key === 'ArrowRight' || key === 'l') {
                e.preventDefault();
                requestNavigate(onNext);
                return;
            }
            if (e.key === 'ArrowLeft' || key === 'j') {
                e.preventDefault();
                requestNavigate(onPrev);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleSave, requestClose, requestNavigate, onNext, onPrev, unlockVault]);

    const handleOpenExternally = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setOpeningExternal(true);
        try {
            const path = localPath ?? await invoke<string>('cmd_get_preview', {
                messageId,
                folderId: activeFolderId,
            });
            if (path) {
                await invoke('cmd_open_file_externally', { path });
            } else {
                toast.error(i18n.t('common.operation_failed'));
            }
        } catch (err) {
            console.error('Failed to open text file externally:', err);
            toast.error(i18n.t('common.operation_failed'));
        } finally {
            setOpeningExternal(false);
        }
    };

    const handleRevert = (e: React.MouseEvent) => {
        e.stopPropagation();
        setContent(original);
    };

    return (
        <div className="viewer-overlay fixed inset-0 z-[200] flex flex-col p-4 animate-in fade-in duration-150" onClick={requestClose}>
            {/* Header / Controls */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-between px-4 pt-[calc(1rem+env(safe-area-inset-top))] md:px-6">
                <div className="viewer-toolbar pointer-events-auto px-2">
                    <h3 className="max-w-[120px] truncate px-1 text-metadata font-medium text-white sm:max-w-xs" title={file.name}>{file.name}</h3>
                    {!protectedFile && <button
                        onClick={handleOpenExternally}
                        disabled={openingExternal}
                        className="quiet-control h-7 rounded-control bg-app-accent px-2 text-badge font-semibold text-app-accent-contrast disabled:opacity-50"
                        title={i18n.t('viewer.open_native')}
                    >
                        {openingExternal ? i18n.t('viewer.opening') : i18n.t('viewer.open_native')}
                    </button>}
                </div>

                <div className="pointer-events-auto flex items-center gap-2">
                    <div className="viewer-toolbar">
                        <button
                            onClick={handleRevert}
                            disabled={!dirty || saving}
                            className="viewer-control disabled:opacity-40"
                            title={i18n.t('viewer.text_revert')}
                            aria-label={i18n.t('viewer.text_revert')}
                        >
                            <RotateCcw className="w-4 h-4" />
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); void handleSave(); }}
                            disabled={!dirty || saving || loading || Boolean(error) || Boolean(readOnlyReason)}
                            className="viewer-control !w-auto gap-1.5 px-2.5 disabled:opacity-40"
                            title={i18n.t('common.save')}
                            aria-label={i18n.t('common.save')}
                        >
                            <Save className="w-4 h-4" />
                            <span className="text-badge font-semibold">{i18n.t('common.save')}</span>
                        </button>
                    </div>

                    <button
                        onClick={(e) => { e.stopPropagation(); requestClose(); }}
                        className="viewer-navigation"
                        title={i18n.t('viewer.close_preview')}
                        aria-label={i18n.t('viewer.close_preview')}
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
            </div>

            {/* Navigation Buttons */}
            {onPrev && (
                <button
                    onClick={(e) => { e.stopPropagation(); requestNavigate(onPrev); }}
                    className="viewer-navigation absolute start-4 top-1/2 z-10 -translate-y-1/2"
                    title={i18n.t('viewer.previous_shortcut')}
                    aria-label={i18n.t('viewer.previous_file')}
                >
                    <ChevronLeft className="h-5 w-5 rtl:rotate-180" />
                </button>
            )}

            {onNext && (
                <button
                    onClick={(e) => { e.stopPropagation(); requestNavigate(onNext); }}
                    className="viewer-navigation absolute end-4 top-1/2 z-10 -translate-y-1/2"
                    title={i18n.t('viewer.next_shortcut')}
                    aria-label={i18n.t('viewer.next_file')}
                >
                    <ChevronRight className="h-5 w-5 rtl:rotate-180" />
                </button>
            )}

            {/* Editor surface */}
            <div
                className="flex w-full flex-1 flex-col pb-20 pt-[calc(5rem+env(safe-area-inset-top))]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="viewer-panel mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden">
                    {loading ? (
                        <div className="flex flex-1 flex-col items-center justify-center text-white">
                            <div className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-app-accent"></div>
                            <p className="text-ui font-medium">{i18n.t('viewer.text_loading')}</p>
                        </div>
                    ) : error ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-white">
                            <p className="text-ui font-semibold text-app-danger">{i18n.t('viewer.preview_error')}</p>
                            <p className="text-metadata leading-relaxed text-white/60">{error}</p>
                            <button onClick={() => setUnlockVault(true)} className="quiet-control px-3 py-2">{i18n.t('settings.unlock_vault')}</button>
                            <button onClick={() => setReload(value => value + 1)} className="quiet-control px-3 py-2">{i18n.t('common.retry')}</button>
                        </div>
                    ) : readOnlyReason ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-white">
                            <FileText className="h-8 w-8 text-white/40" />
                            <p className="text-ui text-white/70">{readOnlyReason}</p>
                        </div>
                    ) : (
                        <textarea
                            ref={textareaRef}
                            value={content}
                            readOnly={saving}
                            onChange={(e) => setContent(e.target.value)}
                            spellCheck={false}
                            wrap="off"
                            autoFocus
                            aria-label={file.name}
                            className="custom-scrollbar h-full w-full flex-1 resize-none bg-transparent p-4 font-mono text-metadata leading-relaxed text-white outline-none"
                        />
                    )}
                </div>
            </div>

            {/* Footer */}
            <div className="viewer-toolbar pointer-events-none absolute bottom-4 start-1/2 -translate-x-1/2 px-3 py-1.5 text-metadata text-white/50 rtl:translate-x-1/2">
                {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                    <span className="me-3 border-e border-white/20 pe-3">{currentIndex + 1} / {totalItems}</span>
                )}
                <span>{dirty && <span className="me-1">•</span>}{content.length.toLocaleString()}</span>
            </div>
            {unlockVault && <Suspense fallback={null}><VaultUnlockDialog onClose={() => { setUnlockVault(false); setReload(value => value + 1); }} /></Suspense>}
        </div>
    );
}
