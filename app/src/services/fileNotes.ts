import {invoke} from '@tauri-apps/api/core';
import {flushSync} from 'react-dom';
import type {FileNote, NoteLocation} from '../types/notes';

export const noteKey = (location: NoteLocation) => `${location.folderId ?? 'saved'}:${location.messageId}`;
const sessions = new Map<string, NotesSession>();
const LOADING: FileNote = Object.freeze({key: '', state: 'loading'});
const UNAVAILABLE: FileNote = Object.freeze({key: '', state: 'error'});
type Entry = {location: NoteLocation; value: FileNote; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>};

export class NotesSession {
    private entries = new Map<string, Entry>();
    private pending = new Set<string>();
    private queued = false;
    private generation = 0;
    constructor(readonly owner: string) {}
    snapshot = (key: string) => this.entries.get(key)?.value ?? (this.entries.size >= 512 ? UNAVAILABLE : LOADING);
    subscribe(location: NoteLocation, listener: () => void) {
        const key = noteKey(location);
        let entry = this.entries.get(key);
        if (!entry) {
            // Mounted rows and the editor are pinned; inactive previews are evicted.
            if (this.entries.size >= 512) for (const [oldKey, old] of this.entries) {
                if (!old.listeners.size) {clearTimeout(old.timer); this.entries.delete(oldKey); break;}
            }
            if (this.entries.size >= 512) return () => {};
            entry = {location, value: LOADING, listeners: new Set()};
            this.entries.set(key, entry);
            this.pending.add(key);
        }
        entry.listeners.add(listener);
        this.schedule();
        return () => {entry.listeners.delete(listener);};
    }
    private publish(key: string, value: FileNote) {
        const entry = this.entries.get(key);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.value = value;
        if (value.protected && value.state === 'ready') {
            entry.timer = setTimeout(() => this.publish(key, {key, state: 'locked', protected: true}), Math.max(0, (value.expiresAt ?? Date.now() + 14 * 60_000) - Date.now()));
        }
        entry.listeners.forEach(listener => listener());
    }
    private schedule() {
        if (this.queued || !this.pending.size) return;
        this.queued = true;
        queueMicrotask(() => {this.queued = false; void this.load();});
    }
    private async load() {
        const keys = [...this.pending].slice(0, 64);
        keys.forEach(key => this.pending.delete(key));
        const generation = this.generation;
        try {
            const rows = await invoke<FileNote[]>('cmd_file_notes', {ownerId: this.owner, action: 'read', locations: keys.map(key => this.entries.get(key)!.location)});
            if (generation !== this.generation) return;
            for (const key of keys) this.publish(key, rows.find(row => row.key === key) ?? {key, state: 'error'});
        } catch {
            if (generation === this.generation) keys.forEach(key => this.publish(key, {key, state: 'error'}));
        } finally {this.schedule();}
    }
    invalidate(protectedOnly = false, reload = false) {
        this.generation++;
        this.pending.clear();
        for (const [key, entry] of this.entries) {
            if (protectedOnly && entry.value.protected === false) continue;
            this.publish(key, {key, state: protectedOnly ? 'locked' : 'loading', protected: entry.value.protected});
            if (reload && entry.listeners.size) this.pending.add(key);
        }
        this.schedule();
    }
    retryLocked() {
        for (const [key, entry] of this.entries) if (entry.listeners.size && ['locked', 'error'].includes(entry.value.state)) this.pending.add(key);
        this.schedule();
    }
    async mutate(location: NoteLocation, action: 'save' | 'delete' | 'unlock', expected: number, text?: string, promptToken?: number) {
        const key = noteKey(location), current = this.snapshot(key), generation = this.generation;
        const result = await invoke<FileNote[] | {text: string; revision: number}>('cmd_file_notes', {
            ownerId: this.owner, action, expected, text, promptToken,
            ...(current.token && action !== 'unlock' ? {token: current.token} : {locations: [location]}),
        });
        if (generation !== this.generation) throw new Error('NOTES_LOCKED');
        const value = Array.isArray(result) ? result[0] : {...current, ...result};
        this.publish(key, value);
    }
}
export function notesSession(owner: string) {
    let session = sessions.get(owner);
    if (!session) {session = new NotesSession(owner); sessions.set(owner, session);}
    return session;
}
export function invalidateNotes() {sessions.forEach(session => session.invalidate(false, true));}
window.addEventListener('file-notes-revoke', () => flushSync(() => sessions.forEach(session => session.invalidate(true, true))));
window.addEventListener('file-notes-account-changed', () => {sessions.forEach(session => session.invalidate(false, true));});
window.addEventListener('file-notes-unlocked', () => sessions.forEach(session => session.retryLocked()));
