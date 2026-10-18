import i18n from '../i18n';
import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { load, type Store } from '@tauri-apps/plugin-store';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFolder, FolderInviteInfo, FolderGroup } from '../types';
import { useNetworkStatus } from './useNetworkStatus';
import { clearImageMemoryCaches, setImageCacheAccount } from '../services/imagePreviewCache';
import { userFacingError } from '../services/userFacingError';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { getCurrentAccountId } from '../services/currentAccount';

export function useTelegramConnection(onLogoutParent: () => void) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();
    const { t } = useTranslation();

    const [folders, setFolders] = useState<TelegramFolder[]>([]);
    const [groups, setGroups] = useState<FolderGroup[]>([]);
    const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
    const [store, setStore] = useState<Store | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isConnected, setIsConnected] = useState(true);
    const [accountId, setAccountId] = useState<string | null>(null);
    const ownerRef = useRef(accountId);
    ownerRef.current = accountId;
    const [hierarchyStatus, setHierarchyStatus] = useState<'cached' | 'syncing' | 'synced' | 'pending' | 'offline' | 'error'>('cached');
    const [hierarchyError, setHierarchyError] = useState<string | null>(null);
    const [hierarchyConflicts, setHierarchyConflicts] = useState(0);
    const accountGeneration = useRef(0);
    const logoutInProgress = useRef(false);
    const accountRetryTimer = useRef<number | undefined>(undefined);
    const refreshAccountId = useCallback(async () => {
        if (logoutInProgress.current) return null;
        window.clearTimeout(accountRetryTimer.current);
        const generation = ++accountGeneration.current;
        const read = async (attempt: number): Promise<string | null> => {
            if (generation !== accountGeneration.current) return null;
            try {
                const id = await getCurrentAccountId();
                if (generation !== accountGeneration.current) return null;
                setImageCacheAccount(id);
                ownerRef.current = id;
                setAccountId(id);
                return id;
            } catch (error) {
                if (generation !== accountGeneration.current) return null;
                setImageCacheAccount(null);
                ownerRef.current = null;
                setAccountId(null);
                // A busy session database must not disable every file query
                // until a window visibility change. Never infer an owner or
                // retry an explicit signed-out/account-change response.
                if (attempt < 2 && !/ACCOUNT_(?:REQUIRED|CHANGED)/.test(String(error))) {
                    accountRetryTimer.current = window.setTimeout(() => { void read(attempt + 1); }, 1000 * (attempt + 1));
                }
                return null;
            }
        };
        return read(0);
    }, []);
    useEffect(() => {
        const refresh = () => { void refreshAccountId(); };
        refresh();
        document.addEventListener('visibilitychange', refresh);
        return () => {
            accountGeneration.current++;
            window.clearTimeout(accountRetryTimer.current);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [refreshAccountId]);

    const networkIsOnline = useNetworkStatus();
    const handleSyncFoldersRef = useRef<((silentParam?: boolean | unknown) => Promise<void>) | null>(null);
    const syncInFlightRef = useRef<Promise<void> | null>(null);
    const syncAgain = useRef(false);
    const editRevision = useRef(0);
    const editsInProgress = useRef(0);
    const beginEdit = () => {
        editRevision.current++;
        editsInProgress.current++;
        return () => { editRevision.current++; editsInProgress.current--; };
    };
    const syncFailures = useRef(0);
    const retryAfter = useRef(0);

    // Fetch groups list from DB
    const fetchGroups = useCallback(async () => {
        const owner = ownerRef.current;
        try {
            if (!owner) return;
            const list = await invoke<FolderGroup[]>('cmd_get_groups', { ownerId: owner });
            if (owner && ownerRef.current === owner) setGroups(list);
        } catch (e) {
            console.error("Failed to fetch folder groups:", e);
        }
    }, []);

    // Load persisted store and restore saved folders.
    useEffect(() => {
        let cancelled = false;
        setFolders([]);
        setGroups([]);
        setStore(null);
        setActiveFolderId(null);
        setHierarchyStatus('cached');
        setHierarchyError(null);
        setHierarchyConflicts(0);
        setIsSyncing(false);
        retryAfter.current = 0;
        syncFailures.current = 0;
        if (!accountId) return;
        const initStore = async () => {
            try {
                let _store = await load('config.json');
                const checkId = await _store.get<string>('api_id');
                if (!checkId) {
                    _store = await load('settings.json');
                }
                // Fetch local-first SQLite enriched folders
                try {
                    const dbFolders = await invoke<TelegramFolder[]>('cmd_get_enriched_folders', { ownerId: accountId });
                    if (!cancelled && dbFolders) {
                        setFolders(dbFolders);
                    }
                } catch {
                    // Never recover inventory from the old, unscoped settings cache.
                }

                // Fetch local-first SQLite groups
                try {
                    const list = await invoke<FolderGroup[]>('cmd_get_groups', { ownerId: accountId });
                    if (!cancelled) setGroups(list);
                } catch (e) {
                    console.error("Failed to load groups:", e);
                }

                const savedActiveFolderId = await _store.get<number | null>(`activeFolderId:${accountId}`);
                if (!cancelled && savedActiveFolderId !== undefined) setActiveFolderId(savedActiveFolderId);

                // Enable file queries only after the persisted folder has been restored.
                // Otherwise the dashboard briefly loads Saved Messages first, then starts
                // a second overlapping request for the actual startup folder.
                if (!cancelled) setStore(_store);
            } catch {
                // store not available
            }
        };
        initStore();
        return () => { cancelled = true; };
    }, [accountId]);

    // Consolidated mount-sync + visibility-change listener
    useEffect(() => {
        if (!store || !accountId) return;
        if (!isConnected) { setHierarchyStatus('offline'); return; }
        const syncAndRefresh = () => {
            if (document.visibilityState === 'visible' && Date.now() >= retryAfter.current) void handleSyncFoldersRef.current?.(true);
        };
        syncAndRefresh();
        const timer = window.setInterval(syncAndRefresh, 30_000);
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                void syncAndRefresh();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.clearInterval(timer);
        };
    }, [store, isConnected, accountId]);

    useEffect(() => {
        setIsConnected(networkIsOnline);
    }, [networkIsOnline]);

    const handleLogout = async () => {
        if (logoutInProgress.current) return;
        logoutInProgress.current = true;
        let progress: string | number | undefined;
        let signedOut = false;
        try {
            if (!await confirm({ title: i18n.t('common.sign_out'), message: "Are you sure you want to sign out? This will disconnect your active session.", confirmText: i18n.t('common.sign_out'), variant: 'danger' })) return;
            progress = toast.loading(t('common.logout'), { description: t('common.loading') });
            // Ignore an account lookup that was already running when sign-out
            // began, but retain the current identity unless native logout succeeds.
            accountGeneration.current++;
            window.clearTimeout(accountRetryTimer.current);
            const outcome = await invoke<boolean | { signed_out?: boolean; remote_session_revoked?: boolean }>('cmd_logout');
            const completed = outcome === true || (typeof outcome === 'object' && outcome?.signed_out === true);
            if (!completed) throw new Error('Logout did not complete');
            signedOut = true;
            if (typeof outcome === 'object' && outcome?.remote_session_revoked === false) {
                // Local data is cleared either way; the user has to end the
                // session from another Telegram client when Telegram did not confirm.
                toast.warning(t('common.signout_remote_unconfirmed'), { duration: 12_000 });
            }
            accountGeneration.current++;
            setImageCacheAccount(null);
            setAccountId(null);
            queryClient.clear();
            clearImageMemoryCaches();
            // Legacy installs can read either store. Remove only the Telegram
            // sign-in fields, never unrelated settings or credentials.
            const cleanup = await Promise.allSettled([
                invoke('cmd_clean_cache'),
                invoke('cmd_clear_api_hash'),
                ...['config.json', 'settings.json'].map(async path => {
                    const target = await load(path);
                    const removals = await Promise.allSettled(['api_id', 'api_hash', 'folders'].map(key => target.delete(key)));
                    await target.save();
                    if (removals.some(result => result.status === 'rejected')) throw new Error('Sign-in field cleanup failed');
                }),
            ]);
            if (cleanup.some(result => result.status === 'rejected')) {
                toast.warning('Signed out, but some local cleanup could not finish.');
            }
        } catch (error) {
            if (signedOut) toast.warning('Signed out, but some local cleanup could not finish.');
            else toast.error(userFacingError(error, t));
        } finally {
            if (progress !== undefined) toast.dismiss(progress);
            logoutInProgress.current = false;
            if (signedOut) onLogoutParent();
        }
    };

    const handleSyncFolders = async (silentParam?: boolean | unknown) => {
        const silent = silentParam === true;
        if (!store || !accountId || logoutInProgress.current) return;
        if (syncInFlightRef.current) {
            syncAgain.current = true;
            return syncInFlightRef.current;
        }
        const owner = accountId;
        const revision = editRevision.current;
        const current = () => ownerRef.current === owner && !logoutInProgress.current;
        const request = (async () => {
            setIsSyncing(true);
            setHierarchyStatus('syncing');
            try {
                const lastScan = await store.get<number>(`foldersLastSyncedAt:${owner}`);
                if (!silent || !lastScan || Date.now() - lastScan > 6 * 60 * 60_000) {
                    await invoke('cmd_scan_folders', { ownerId: owner });
                    if (!current()) return;
                    await store.set(`foldersLastSyncedAt:${owner}`, Date.now());
                    await store.save();
                }
                let snapshot = await invoke<HierarchySnapshot>('cmd_sync_folder_hierarchy', { ownerId: owner });
                if (!current()) return;
                if (snapshot.needs_scan) {
                    await invoke('cmd_scan_folders', { ownerId: owner });
                    snapshot = await invoke<HierarchySnapshot>('cmd_sync_folder_hierarchy', { ownerId: owner });
                }
                if (!current()) return;
                // An IPC reply from an earlier projection must not undo an edit
                // accepted while this pull was running. Reconcile again instead.
                if (revision !== editRevision.current || editsInProgress.current) {
                    syncAgain.current = true;
                    return;
                }
                setFolders(snapshot.folders);
                setHierarchyConflicts(snapshot.conflicts);
                if (snapshot.needs_scan) throw new Error(t('hierarchy.incomplete'));
                setHierarchyError(null);
                syncFailures.current = 0;
                retryAfter.current = 0;
                setHierarchyStatus(snapshot.pending ? 'pending' : 'synced');
                await fetchGroups();
                if (!silent && !snapshot.pending) toast.success(t('hierarchy.synced'));
            } catch (e) {
                if (!current()) return;
                setHierarchyStatus(navigator.onLine ? 'error' : 'offline');
                setHierarchyError(userFacingError(e, t));
                retryAfter.current = Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(++syncFailures.current, 4));
                if (!silent) toast.error(userFacingError(e, t));
            } finally {
                if (current()) setIsSyncing(false);
            }
        })().finally(() => {
            syncInFlightRef.current = null;
            if (syncAgain.current) {
                syncAgain.current = false;
                window.setTimeout(() => { void handleSyncFoldersRef.current?.(true); }, 0);
            }
        });
        syncInFlightRef.current = request;
        return request;
    };

    // Keep the ref in sync
    handleSyncFoldersRef.current = handleSyncFolders;

    const handleCreateFolder = async (name: string, parentId: number | null = null) => {
        if (!store || !accountId) throw new Error(t('hierarchy.account_required'));
        const owner = accountId;
        const finish = beginEdit();
        try {
            const newFolder = await invoke<TelegramFolder>('cmd_create_folder', { name, parentId, ownerId: owner });
            if (ownerRef.current !== owner) return;
            setFolders(previous => [...previous.filter(f => f.id !== newFolder.id), newFolder]);
            setHierarchyStatus('pending');
            void handleSyncFolders(true);
            toast.success(`Folder "${name}" created.`);
        } catch (e) {
            toast.error(userFacingError(e, t));
            if (String(e).includes('HIERARCHY_CREATED')) void handleSyncFolders(true);
            throw e;
        } finally { finish(); }
    };

    const handleFolderDelete = async (folderId: number, folderName: string) => {
        if (folders.some(f => f.parent_id === folderId)) { toast.error(t('hierarchy.has_children')); return; }
        const owner = accountId;
        if (!owner) return;
        if (!await confirm({
            title: "Delete Folder",
            message: `Are you sure you want to delete "${folderName}"?\nThis will delete the channel on Telegram.`,
            confirmText: i18n.t("files.delete"),
            variant: 'danger'
        })) return;

        const finish = beginEdit();
        try {
            await invoke('cmd_delete_folder', { folderId, ownerId: owner });
            if (ownerRef.current !== owner) return;
            setFolders(previous => previous.filter(f => f.id !== folderId));
            if (store) {
                void handleSyncFolders(true);
            }
            if (activeFolderId === folderId) setActiveFolderId(null);
            toast.success(`Folder "${folderName}" deleted.`);
        } catch (e: unknown) {
            const errStr = String(e);
            if (errStr.includes("not found")) {
                if (await confirm({
                    title: "Folder Not Found",
                    message: `Folder "${folderName}" not found on Telegram (it may have been deleted externally).\nRemove from this app?`,
                    confirmText: "Remove",
                    variant: 'info'
                })) {
                    if (ownerRef.current !== owner) return;
                    const updated = folders.filter(f => f.id !== folderId);
                    setFolders(updated);
                    if (store) {
                        await store.set('folders', updated);
                        await store.save();
                    }
                    if (activeFolderId === folderId) setActiveFolderId(null);
                }
            } else {
                toast.error(`Failed to delete folder: ${e}`);
            }
        } finally { finish(); }
    };

    const handleFolderRename = async (folderId: number, oldName: string, newNameOverride?: string) => {
        const newName = newNameOverride?.trim();
        if (!newName || newName === oldName) return;
        const owner = accountId;
        if (!owner) return;

        const finish = beginEdit();
        try {
            await invoke('cmd_rename_folder', { folderId, newName, ownerId: owner });
            if (ownerRef.current !== owner) return;
            setFolders(previous => previous.map(f => f.id === folderId ? { ...f, name: newName } : f));
            toast.success(`Folder renamed to "${newName}".`);
        } catch (e) {
            toast.error(userFacingError(e, t));
        } finally { finish(); }
    };

    const handleFolderToggleVisibility = async (folderId: number, makePublic: boolean, desiredUsername?: string) => {
        const owner = accountId;
        if (!owner) throw new Error(t('hierarchy.account_required'));
        if (!makePublic) {
            const confirmed = await confirm({
                title: i18n.t("files.make_private"),
                message: "Making this channel private will remove its public username. Any shared t.me links will stop working immediately.",
                confirmText: i18n.t("files.make_private"),
                variant: 'danger'
            });
            if (!confirmed) return;
        }
        const finish = beginEdit();
        try {
            const updated = await invoke<TelegramFolder>('cmd_toggle_folder_visibility', {
                folderId,
                ownerId: owner,
                makePublic,
                desiredUsername: desiredUsername || null,
            });
            if (ownerRef.current !== owner) return;
            setFolders(previous => previous.map(f =>
                f.id === folderId ? { ...f, username: updated.username, is_public: updated.is_public } : f
            ));
            toast.success(makePublic ? 'Channel is now public' : 'Channel is now private');
            return updated;
        } catch (e) {
            toast.error(`Failed to toggle visibility: ${e}`);
            throw e;
        } finally { finish(); }
    };

    const handleExportFolderInvite = async (folderId: number): Promise<FolderInviteInfo> => {
        try {
            const info = await invoke<FolderInviteInfo>('cmd_export_folder_invite', {
                folderId,
            });
            return info;
        } catch (e) {
            toast.error(`Failed to get invite link: ${e}`);
            throw e;
        }
    };

    const handleSetActiveFolderId = async (id: number | null) => {
        setActiveFolderId(id);
        if (store) {
            await store.set(`activeFolderId:${accountId}`, id);
            await store.save();
        }
    };

    // Group Management Actions
    const handleCreateGroup = async (name: string, colorHex: string = '#3B82F6') => {
        const owner = accountId;
        if (!owner) return;
        try {
            const id = await invoke<number>('cmd_create_group', { name, colorHex, ownerId: owner });
            if (ownerRef.current !== owner) return;
            const newGroup: FolderGroup = { id, name, color_hex: colorHex, display_order: groups.length };
            setGroups(prev => [...prev, newGroup]);
            toast.success(`Group "${name}" created.`);
        } catch (e) {
            toast.error(userFacingError(e, t));
        }
    };

    const handleDeleteGroup = async (groupId: number) => {
        const owner = accountId;
        if (!owner) return;
        const finish = beginEdit();
        try {
            await invoke('cmd_delete_group', { groupId, ownerId: owner });
            if (ownerRef.current !== owner) return;
            setGroups(prev => prev.filter(g => g.id !== groupId));
            setFolders(prev => prev.map(f => f.group_id === groupId ? { ...f, group_id: null } : f));
            toast.success("Group deleted.");
        } catch (e) {
            toast.error(userFacingError(e, t));
        } finally { finish(); }
    };

    const handleUpdateGroup = async (groupId: number, name: string, colorHex: string) => {
        const owner = accountId;
        if (!owner) return;
        try {
            await invoke('cmd_update_group', { groupId, name, colorHex, ownerId: owner });
            if (ownerRef.current !== owner) return;
            setGroups(prev => prev.map(g => g.id === groupId ? { ...g, name, color_hex: colorHex } : g));
            toast.success("Group updated.");
        } catch (e) {
            toast.error(userFacingError(e, t));
        }
    };

    const handleAssignFolderToGroup = async (folderId: number, groupId: number | null) => {
        const owner = accountId;
        if (!owner) return;
        const finish = beginEdit();
        try {
            await invoke('cmd_assign_folder_to_group', { channelId: folderId, groupId, ownerId: owner });
            if (ownerRef.current !== owner) return;
            setFolders(prev => prev.map(f => f.id === folderId ? { ...f, group_id: groupId } : f));
        } catch (e) {
            toast.error(userFacingError(e, t));
        } finally { finish(); }
    };

    const handleMoveFolder = async (folderId: number, parentId: number | null, displayOrder = 0) => {
        if (!accountId) throw new Error(t('hierarchy.account_required'));
        const owner = accountId;
        const finish = beginEdit();
        try {
            const snapshot = await invoke<HierarchySnapshot>('cmd_move_folder', { ownerId: owner, folderId, parentId, displayOrder });
            if (ownerRef.current !== owner) return;
            setFolders(snapshot.folders);
            setHierarchyStatus(isConnected ? 'pending' : 'offline');
        } finally { finish(); }
        if (isConnected) void handleSyncFolders(true);
    };

    const handleReorderFolders = async (reordered: TelegramFolder[]) => {
        try {
            // Preserve parents: dragging only changes sibling order, never nesting.
            for (const [index, folder] of reordered.entries()) {
                if (folder.display_order !== index) await handleMoveFolder(folder.id, folder.parent_id ?? null, index);
            }
        } catch (e) {
            toast.error(userFacingError(e, t));
        }
    };

    const handleUpdateGroupOrder = async (reorderedGroups: FolderGroup[]) => {
        const owner = accountId;
        if (!owner) return;
        setGroups(reorderedGroups);
        try {
            await Promise.all(
                reorderedGroups.map((g, index) =>
                    invoke('cmd_update_group_order', { groupId: g.id, newOrder: index, ownerId: owner })
                )
            );
        } catch (e) {
            console.error("Failed to persist group order:", e);
        }
    };

    return {
        store,
        accountId,
        folders,
        groups,
        activeFolderId,
        setActiveFolderId: handleSetActiveFolderId,
        isSyncing,
        isConnected,
        hierarchyStatus,
        hierarchyError,
        hierarchyConflicts,
        handleMoveFolder,
        handleLogout,
        handleSyncFolders,
        handleCreateFolder,
        handleFolderDelete,
        handleFolderRename,
        handleFolderToggleVisibility,
        handleExportFolderInvite,
        // Group Actions
        handleCreateGroup,
        handleDeleteGroup,
        handleUpdateGroup,
        handleAssignFolderToGroup,
        handleReorderFolders,
        handleUpdateGroupOrder,
        fetchGroups
    };
}

interface HierarchySnapshot {
    folders: TelegramFolder[];
    pending: number;
    conflicts: number;
    needs_scan: boolean;
}
