import { ChevronRight, Folder, FolderInput, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TelegramFolder } from '../types';
import { folderAncestors, folderChildren } from '../services/folderHierarchy';

interface Props {
    folders: TelegramFolder[];
    folderId: number | null;
    overview: boolean;
    onNavigate: (id: number | null, overview: boolean) => void;
    onCreate: () => void;
    onMove: (folder: TelegramFolder) => void;
    status: string;
    error: string | null;
    conflicts: number;
}

export function FolderNavigation({ folders, folderId, overview, onNavigate, onCreate, onMove, status, error, conflicts }: Props) {
    const { t } = useTranslation();
    const children = overview || folderId !== null ? folderChildren(folders, overview ? null : folderId) : [];
    return <div className="shrink-0 space-y-2 px-3 py-2" data-testid="folder-navigation">
        <nav aria-label={t('hierarchy.breadcrumb')} className="flex flex-wrap items-center gap-1 text-sm">
            <button className="quiet-control min-h-11 px-2 text-app-accent md:min-h-8" aria-current={overview ? 'page' : undefined} onClick={() => onNavigate(null, true)}>{t('hierarchy.folders')}</button>
            {!overview && (folderId === null ? <><ChevronRight className="h-3 w-3" /><span>{t('common.saved_messages')}</span></> : folderAncestors(folders, folderId).map(folder => <span className="flex min-w-0 items-center gap-1" key={folder.id}>
                <ChevronRight className="h-3 w-3 shrink-0" /><button className="quiet-control min-h-11 max-w-56 truncate px-2 md:min-h-8" aria-current={folder.id === folderId ? 'page' : undefined} onClick={() => onNavigate(folder.id, false)}>{folder.name}</button>
            </span>))}
            <button className="quiet-control ms-auto flex min-h-11 items-center gap-1 px-2 text-app-accent md:min-h-8" onClick={onCreate}><Plus className="h-4 w-4" />{t('common.create_folder')}</button>
        </nav>
        <p role="status" className="text-xs text-app-text-secondary" title={error ?? undefined}>{t(`hierarchy.${status}`)}{conflicts > 0 && ` · ${t('hierarchy.conflicts')}`}</p>
        {error && <p role="alert" className="break-words text-xs text-app-danger">{error}</p>}
        {conflicts > 0 && <p className="text-xs text-app-text-secondary">{t('hierarchy.conflict_detail')}</p>}
        {children.length > 0 && <section aria-label={t('hierarchy.child_folders')} className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
            {children.map(folder => <div key={folder.id} className="quiet-surface flex min-w-0 items-center">
                <button className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 text-start text-sm" onClick={() => onNavigate(folder.id, false)}><Folder className="h-5 w-5 shrink-0 text-app-accent" /><span className="truncate">{folder.name}</span></button>
                <button aria-label={t('hierarchy.move_named', { name: folder.name })} title={t('hierarchy.move')} onClick={() => onMove(folder)} className="quiet-control me-1 flex h-11 w-11 shrink-0 items-center justify-center text-app-text-secondary"><FolderInput className="h-4 w-4" /></button>
            </div>)}
        </section>}
        {overview && children.length === 0 && <p className="py-8 text-center text-sm text-app-text-secondary">{t('hierarchy.empty')}</p>}
    </div>;
}
