import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { X, ChevronLeft, ChevronRight, Save, RotateCcw, FileText } from 'lucide-react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TelegramFile } from '../../../types';
import i18n from '../../../i18n';
import { invalidateFolderFileQueries } from '../../../services/fileListRefresh';

interface TextFilePayload {
    content: string;
    size: number;
    truncated: boolean;
    encoding: string;
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
    onSaved?: (messageId: number) => void;
}

export function TextViewerModal({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId, localPath, onSaved }: TextViewerModalProps) {
    useTranslation();
    const queryClient = useQueryClient();
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

    const dirty = content !== original;

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setReadOnlyReason(null);
        setMessageId(file.id);

        const load = async () => {
            try {
                if (localPath) {
                    const response = await fetch(convertFileSrc(localPath));
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const text = await response.text();
                    if (cancelled) return;
                    setContent(text);
                    setOriginal(text);
                    setLoading(false);
                    return;
                }
                const payload = await invoke<TextFilePayload>('cmd_read_text_file', {
                    messageId: file.id,
                    folderId: activeFolderId,
                });
                if (cancelled) return;
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
                if (cancelled) return;
                const message = String(err);
                if (/encrypt/i.test(message)) {
                    setReadOnlyReason(i18n.t('viewer.text_read_only'));
                } else {
                    setError(message || i18n.t('common.operation_failed'));
                }
                setLoading(false);
            }
        };

        void load();
        return () => { cancelled = true; };
    }, [file.id, activeFolderId, localPath]);

    const handleSave = useCallback(async () => {
        if (!dirty || saving || readOnlyReason) return;
        setSaving(true);
        try {
            const result = await invoke<SavedTextFile>('cmd_save_text_file', {
                messageId,
                folderId: activeFolderId,
                content,
            });
            setOriginal(content);
            setMessageId(result.messageId);
            toast.success(i18n.t('viewer.text_saved'));
            if (activeFolderId !== null) void invalidateFolderFileQueries(queryClient, activeFolderId);
            onSaved?.(result.messageId);
        } catch (err) {
            const message = String(err);
            if (/ENCRYPTED/i.test(message)) {
                setReadOnlyReason(i18n.t('viewer.text_read_only'));
                toast.error(i18n.t('viewer.text_read_only'));
            } else if (/TEXT_TOO_LARGE/i.test(message)) {
                toast.error(i18n.t('viewer.text_too_large'));
            } else {
                toast.error(i18n.t('viewer.text_save_error'));
            }
            // A lost reply must never be retried blindly; re-list instead.
            if (activeFolderId !== null) void invalidateFolderFileQueries(queryClient, activeFolderId);
        } finally {
            setSaving(false);
        }
    }, [dirty, saving, readOnlyReason, messageId, activeFolderId, content, queryClient, onSaved]);

    const requestClose = useCallback(() => {
        if (dirty && !window.confirm(i18n.t('viewer.text_discard_confirm'))) return;
        onClose();
    }, [dirty, onClose]);

    const requestNavigate = useCallback((navigate?: () => void) => {
        if (!navigate) return;
        if (dirty && !window.confirm(i18n.t('viewer.text_discard_confirm'))) return;
        navigate();
    }, [dirty]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
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
    }, [handleSave, requestClose, requestNavigate, onNext, onPrev]);

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
                    <button
                        onClick={handleOpenExternally}
                        disabled={openingExternal}
                        className="quiet-control h-7 rounded-control bg-app-accent px-2 text-badge font-semibold text-app-accent-contrast disabled:opacity-50"
                        title={i18n.t('viewer.open_native')}
                    >
                        {openingExternal ? i18n.t('viewer.opening') : i18n.t('viewer.open_native')}
                    </button>
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
                            disabled={!dirty || saving || Boolean(readOnlyReason)}
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
        </div>
    );
}
