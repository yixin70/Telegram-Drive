import type { TelegramFolder } from '../types';

/** Defensive traversal also makes old/corrupt caches navigable until reconciliation. */
export function folderAncestors(folders: TelegramFolder[], id: number | null): TelegramFolder[] {
    const map = new Map(folders.map(folder => [folder.id, folder]));
    const path: TelegramFolder[] = [];
    const seen = new Set<number>();
    while (id !== null && !seen.has(id)) {
        seen.add(id);
        const folder = map.get(id);
        if (!folder) break;
        path.unshift(folder);
        id = folder.parent_id ?? null;
    }
    return path;
}

export const folderPath = (folders: TelegramFolder[], id: number) => folderAncestors(folders, id).map(f => f.name).join(' / ');

export function folderChildren(folders: TelegramFolder[], parent: number | null) {
    const ids = new Set(folders.map(folder => folder.id));
    return folders.filter(folder => (folder.parent_id && ids.has(folder.parent_id) ? folder.parent_id : null) === parent)
        .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || a.id - b.id);
}
