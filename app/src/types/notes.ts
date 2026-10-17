export interface NoteLocation {folderId: number | null; messageId: number}
export interface FileNote {
    key: string;
    state: 'loading' | 'ready' | 'locked' | 'error';
    protected?: boolean;
    token?: string;
    text?: string;
    revision?: number;
    expiresAt?: number;
}
export interface NotesImportPreview {token: string; records: number; conflicts: number}
