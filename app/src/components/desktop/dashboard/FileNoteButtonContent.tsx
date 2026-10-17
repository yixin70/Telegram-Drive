import {lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {createPortal, flushSync} from 'react-dom';
import {StickyNote} from 'lucide-react';
import {useTranslation} from 'react-i18next';
import {useFileNotes} from '../../../hooks/useFileNotes';
import {useNotesAccount} from '../../../context/NotesAccountContext';
import type {NoteLocation} from '../../../types/notes';
import type {TelegramFile} from '../../../types';
import {isVideoFile} from '../../../utils';
import {sourceFolder} from '../../../services/fileIdentity';

export default function FileNoteForFile({file, activeFolderId, card}: {file: TelegramFile; activeFolderId?: number | null; card?: boolean}) {
    const owner = useNotesAccount();
    if (!owner || (!isVideoFile(file.name) && !file.encryption_state?.startsWith('encrypted'))) return null;
    const button = <FileNoteButtonContent owner={owner} name={file.name} location={{folderId: sourceFolder(file, activeFolderId ?? null), messageId: file.id}} />;
    return card ? <div className="absolute bottom-14 end-2 z-10 rounded bg-app-surface/90">{button}</div> : button;
}

type Target = {owner: string; name: string; location: NoteLocation};
let editor: Target | null = null;
const subscribers = new Set<() => void>();
const closeEditor = () => {editor = null; subscribers.forEach(listener => listener());};
window.addEventListener('file-notes-account-changed', closeEditor);
const Dialog = lazy(() => import('./FileNotesDialog'));
export function FileNotesHost() {
    const owner = useNotesAccount();
    useLayoutEffect(() => () => {window.dispatchEvent(new Event('file-notes-account-changed'));}, [owner]);
    const target = useSyncExternalStore(listener => {subscribers.add(listener); return () => {subscribers.delete(listener);};}, () => editor);
    return target && target.owner === owner ? <Suspense fallback={null}><Dialog key={`${owner}:${target.location.folderId}:${target.location.messageId}`} {...target} onClose={closeEditor} /></Suspense> : null;
}

function FileNoteButtonContent(props: Target) {
    const {t} = useTranslation();
    const {note} = useFileNotes(props.owner, props.location);
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
    const id = useId();
    const [position, setPosition] = useState({left: 0, top: 0, width: 300});
    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const bounds = button.current?.getBoundingClientRect();
            if (!bounds) return;
            const width = Math.min(340, window.innerWidth - 16), height = popup.current?.offsetHeight ?? 120;
            setPosition({width, left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)), top: bounds.bottom + height <= window.innerHeight - 8 ? bounds.bottom : Math.max(8, bounds.top - height)});
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);};
    }, [open, note]);
    useEffect(() => {if (note.state === 'locked') setOpen(false);}, [note.state]);
    useEffect(() => {
        const escape = (event: KeyboardEvent) => {if (event.key === 'Escape') setOpen(false);};
        if (open) window.addEventListener('keydown', escape);
        return () => window.removeEventListener('keydown', escape);
    }, [open]);
    const leave = (target: EventTarget | null) => {if (!(target instanceof Node) || (!button.current?.contains(target) && !popup.current?.contains(target))) setOpen(false);};
    return <>
        <button ref={button} type="button" aria-label={t('notes.for_file', {name: props.name})} aria-describedby={open ? id : undefined}
            className="quiet-control inline-flex h-7 w-7 shrink-0 items-center justify-center text-app-accent"
            onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
            onMouseEnter={() => flushSync(() => setOpen(true))} onMouseLeave={event => leave(event.relatedTarget)} onFocus={() => setOpen(true)} onBlur={event => leave(event.relatedTarget)}
            onClick={event => {event.stopPropagation(); setOpen(false); editor = props; subscribers.forEach(listener => listener());}}>
            <StickyNote className={`h-4 w-4 ${note.state === 'ready' && note.text ? 'fill-current/20' : ''}`} />
        </button>
        {open && createPortal(<div ref={popup} id={id} role="tooltip" tabIndex={0}
            onMouseLeave={event => leave(event.relatedTarget)} onBlur={event => leave(event.relatedTarget)}
            style={{position: 'fixed', ...position, zIndex: 240, maxHeight: Math.min(300, window.innerHeight - 16), overflowY: 'auto'}}
            className="quiet-raised whitespace-pre-wrap break-words p-4 text-sm text-app-text shadow-xl">
            {note.state === 'ready' ? note.text || t('notes.empty') : t(note.state === 'loading' ? 'common.loading' : note.state === 'locked' ? 'notes.locked' : 'notes.read_error')}
        </div>, document.body)}
    </>;
}
