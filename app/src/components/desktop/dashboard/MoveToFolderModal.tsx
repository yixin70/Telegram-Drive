import { Plus, HardDrive, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TelegramFolder } from '../../../types';
import { useRef } from 'react';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { folderAncestors, folderPath } from '../../../services/folderHierarchy';

interface MoveToFolderModalProps {
    folders: TelegramFolder[];
    onClose: () => void;
    onSelect: (id: number | null) => void;
    activeFolderId: number | null;
    fileName?: string;
    movingFolderId?: number;
}

export function MoveToFolderModal({ folders, onClose, onSelect, activeFolderId, fileName, movingFolderId }: MoveToFolderModalProps) {
    const { t } = useTranslation();
    const panelRef = useRef<HTMLDivElement>(null);
    useModalFocus(panelRef, onClose);

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onClick={onClose}>
            <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="move-to-folder-title" tabIndex={-1} className="quiet-raised flex max-h-[80vh] w-80 flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-telegram-border flex justify-between items-center">
                    <h3 id="move-to-folder-title" className="text-telegram-text font-medium truncate max-w-[220px]">
                        {movingFolderId !== undefined ? t('hierarchy.move') : fileName ? t('files.move_file_to_folder', { name: fileName }) : t('files.move_to_folder')}
                    </h3>
                    <button type="button" onClick={onClose} aria-label={t('common.close')} className="text-telegram-subtext hover:text-telegram-text"><Plus className="w-5 h-5 rotate-45" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {activeFolderId !== null && (
                        <button
                            onClick={() => onSelect(null)}
                            className="quiet-control flex w-full items-center gap-3 px-3 py-3 text-start text-sm text-app-text"
                        >
                            <div className="w-8 h-8 rounded bg-telegram-primary/20 flex items-center justify-center text-telegram-primary">
                                <HardDrive className="w-4 h-4" />
                            </div>
                            <span className="font-medium">{t(movingFolderId !== undefined ? 'hierarchy.root' : 'common.saved_messages')}</span>
                        </button>
                    )}

                    {folders.map(f => {
                        if (movingFolderId === undefined && f.id === activeFolderId) return null;
                        const invalid = movingFolderId !== undefined && (f.id === activeFolderId || folderAncestors(folders, f.id).some(parent => parent.id === movingFolderId));
                        return (
                            <button
                                key={f.id}
                                disabled={invalid}
                                onClick={() => onSelect(f.id)}
                                className="quiet-control flex w-full items-center gap-3 px-3 py-3 text-start text-sm text-app-text disabled:opacity-40"
                            >
                                <div className="w-8 h-8 rounded bg-telegram-hover flex items-center justify-center text-telegram-text">
                                    <Folder className="w-4 h-4" />
                                </div>
                                <span className="break-words font-medium">{folderPath(folders, f.id)}</span>
                            </button>
                        )
                    })}

                    {folders.length === 0 && activeFolderId === null && (
                        <div className="p-4 text-center text-xs text-telegram-subtext">{t('files.no_other_folders')}</div>
                    )}
                </div>
            </div>
        </div>
    )
}
