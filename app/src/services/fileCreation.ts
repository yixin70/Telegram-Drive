import { invoke } from '@tauri-apps/api/core';
import type { DesktopTransferJob } from './desktopTransferEngine';

export const MAX_INITIAL_TEXT_BYTES = 1_048_576;
export function validCreationFilename(name: string): boolean {
    const stem = name.split('.')[0].trimEnd();
    return name.trim().length > 0 && name.length <= 120 && name !== '.' && name !== '..'
        && !/[. ]$/.test(name) && !/[\x00-\x1f\x7f-\x9f<>:"/\\|?*]/.test(name)
        && !/^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(stem);
}

export interface CreationProtection { mode: string; protectMetadata?: boolean; promptToken?: number }
export function createCloudFile(id: string, ownerId: string, folderId: number | null, filename: string, content: string, protection: CreationProtection) {
    return invoke<DesktopTransferJob>('cmd_create_file', { request: {
        id, ownerId, folderId, filename, content, protectionMode: protection.mode,
        protectMetadata: Boolean(protection.protectMetadata), promptToken: protection.promptToken,
    } });
}
