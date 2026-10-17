import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, LockKeyhole, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../../../hooks/useEncryption';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { Button, Input } from '../../ui';

export default function VaultUnlockDialog({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const { unlockVault } = useEncryption();
    const queryClient = useQueryClient();
    const [passphrase, setPassphrase] = useState('');
    const [showPassphrase, setShowPassphrase] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const panel = useRef<HTMLFormElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const pending = useRef(false);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const close = () => { if (!pending.current) onClose(); };
    useModalFocus(panel, close);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!passphrase || pending.current) return;
        pending.current = true;
        setBusy(true);
        setError(false);
        const secret = passphrase;
        setPassphrase('');
        try {
            await unlockVault(secret);
            if (mounted.current) {
                void queryClient.invalidateQueries({ queryKey: ['files'] }).catch(() => {});
                toast.success(t('settings.vault_unlocked_toast'));
                onClose();
            }
        } catch {
            if (mounted.current) setError(true);
        } finally {
            pending.current = false;
            if (mounted.current) {
                setBusy(false);
                input.current?.focus();
            }
        }
    };

    return <div className="fixed inset-0 z-[210] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={close}>
        <form ref={panel} role="dialog" aria-modal="true" aria-labelledby="quick-vault-title" tabIndex={-1}
            onSubmit={submit} onKeyDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} className="quiet-raised w-[min(420px,calc(100vw-2rem))] overflow-hidden">
            <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
                <h2 id="quick-vault-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><LockKeyhole className="h-4 w-4 text-app-success" />{t('settings.unlock_vault')}</h2>
                <button type="button" onClick={close} disabled={busy} aria-label={t('common.close')} className="quiet-control p-2 text-app-text-secondary disabled:opacity-50"><X className="h-4 w-4" /></button>
            </header>
            <div className="space-y-3 p-5">
                <p id="quick-vault-description" className="text-sm text-app-text-secondary">{t('settings.vault_is_locked')}</p>
                <div className="relative">
                    <Input ref={input} data-modal-autofocus type={showPassphrase ? 'text' : 'password'}
                        aria-label={t('settings.vault_passphrase_placeholder')} placeholder={t('settings.vault_passphrase_placeholder')}
                        aria-describedby={error ? 'quick-vault-error' : 'quick-vault-description'} aria-invalid={error || undefined}
                        autoComplete="off" spellCheck={false} readOnly={busy} value={passphrase}
                        onChange={event => { setPassphrase(event.target.value); setError(false); }} className="h-10 pe-11" />
                    <button type="button" disabled={busy} onClick={() => setShowPassphrase(value => !value)}
                        aria-label={t(showPassphrase ? 'settings.hide_passphrase' : 'settings.show_passphrase')} aria-pressed={showPassphrase}
                        className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-app-text-secondary">
                        {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                </div>
                {error && <p id="quick-vault-error" role="alert" className="text-sm text-app-danger">{t('settings.wrong_passphrase')}</p>}
            </div>
            <footer className="flex justify-end gap-2 border-t border-app-border-subtle px-5 py-4">
                <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
                <button type="submit" disabled={busy || !passphrase} className="quiet-control h-8 border border-app-success/30 bg-app-success/10 px-3 text-ui font-semibold text-app-success hover:bg-app-success/20 disabled:opacity-50">
                    {t(busy ? 'settings.unlocking' : 'settings.unlock_vault')}
                </button>
            </footer>
        </form>
    </div>;
}
