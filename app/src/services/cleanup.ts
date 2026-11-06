import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceFile } from './workspace';

export interface Removal {
    id: string; key: string; file: WorkspaceFile; requestedAt: number; deleteAfter: number;
    status: 'pending' | 'deleting' | 'deleted' | 'restored' | 'failed'; error: string | null;
}
export function listRemovals(ownerId: string): Promise<Removal[]> { return invoke('cmd_cleanup_list', { ownerId }); }
export function restoreRemoval(ownerId: string, key: string): Promise<Removal> { return invoke('cmd_cleanup_restore', { ownerId, key }); }
