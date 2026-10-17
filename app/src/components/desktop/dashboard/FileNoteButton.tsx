import {lazy, Suspense} from 'react';
import type {TelegramFile} from '../../../types';

const Content = lazy(() => import('./FileNoteButtonContent'));
export function FileNoteButton(props: {file: TelegramFile; activeFolderId?: number | null; card?: boolean}) {
    return <Suspense><Content {...props} /></Suspense>;
}
