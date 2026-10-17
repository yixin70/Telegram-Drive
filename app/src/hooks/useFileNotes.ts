import {useCallback, useSyncExternalStore} from 'react';
import {noteKey, notesSession} from '../services/fileNotes';
import type {NoteLocation} from '../types/notes';

export function useFileNotes(owner: string, location: NoteLocation) {
    const session = notesSession(owner), key = noteKey(location);
    const subscribe = useCallback((listener: () => void) => session.subscribe(location, listener), [session, key]);
    const snapshot = useCallback(() => session.snapshot(key), [session, key]);
    return {note: useSyncExternalStore(subscribe, snapshot, snapshot), session};
}
