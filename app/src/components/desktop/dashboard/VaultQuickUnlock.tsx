import { lazy, Suspense, useState } from 'react';
import { LockKeyhole, Unlock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../../../hooks/useEncryption';

const VaultUnlockDialog = lazy(() => import('./VaultUnlockDialog'));

export function VaultQuickUnlock() {
    const { t } = useTranslation();
    const { vaultStatus, capabilityState } = useEncryption();
    const [open, setOpen] = useState(false);
    if (capabilityState !== 'ready' || !vaultStatus?.exists) return null;
    const unlocked = vaultStatus.is_unlocked;
    const label = t(unlocked ? 'settings.vault_unlocked_toast' : 'settings.unlock_vault');

    return <>
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={unlocked}
            onClick={() => setOpen(true)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
            className="quiet-control flex h-[30px] w-[30px] shrink-0 items-center justify-center border border-app-success/30 bg-app-success/10 text-app-success hover:bg-app-success/20 disabled:cursor-default"
        >
            {unlocked ? <Unlock className="h-3.5 w-3.5" /> : <LockKeyhole className="h-3.5 w-3.5" />}
        </button>
        {open && <Suspense fallback={null}><VaultUnlockDialog onClose={() => setOpen(false)} /></Suspense>}
    </>;
}
