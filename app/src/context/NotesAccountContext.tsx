import {createContext, useContext} from 'react';

export const NotesAccountContext = createContext<string | null>(null);
export const useNotesAccount = () => useContext(NotesAccountContext);
