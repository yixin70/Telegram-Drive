import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import type { TelegramFolder } from '../types';
import { folderPath } from '../services/folderHierarchy';

export function FolderHierarchyBackup({ ownerId, onChanged }: { ownerId: string | null; onChanged: () => void }) {
    const { t } = useTranslation();
    const { confirm } = useConfirm();
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const owner = useRef(ownerId); owner.current = ownerId;
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try { await action(); } catch (error) { toast.error(String(error)); } finally { setBusy(false); }
    };
    return <div className="flex flex-wrap gap-2 px-3 pb-2 text-xs text-app-text-secondary">
        <button className="quiet-control min-h-11 px-2 md:min-h-8" disabled={busy || !ownerId} onClick={() => void run(async () => {
            const captured = ownerId;
            const path = await save({ defaultPath: `folder-layout-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (!path || owner.current !== captured) return;
            await invoke('cmd_folder_hierarchy_backup', { ownerId: captured, path });
            toast.success(t('hierarchy.exported'));
        })}>{t('hierarchy.export')}</button>
        <button className="quiet-control min-h-11 px-2 md:min-h-8" disabled={busy || !ownerId} onClick={() => input.current?.click()}>{t('hierarchy.import')}</button>
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            void run(async () => {
                const captured = ownerId;
                if (file.size > 16 * 1024 * 1024) throw new Error(t('hierarchy.backup_large'));
                const body = await file.text();
                if (owner.current !== captured) return;
                const preview = await invoke<{ pending: number; folders: TelegramFolder[] }>('cmd_folder_hierarchy_backup', { ownerId: captured, body, apply: false });
                const paths = preview.folders.slice(0, 20).map(folder => folderPath(preview.folders, folder.id)).join('\n');
                if (owner.current !== captured || !await confirm({ title: t('hierarchy.import'), message: `${t('hierarchy.import_preview', { count: preview.pending })}\n\n${paths}${preview.folders.length > 20 ? '\n…' : ''}`, confirmText: t('hierarchy.import'), variant: 'danger' })) return;
                if (owner.current !== captured) return;
                await invoke('cmd_folder_hierarchy_backup', { ownerId: captured, body, apply: true });
                if (owner.current === captured) onChanged();
            });
        }} />
    </div>;
}
