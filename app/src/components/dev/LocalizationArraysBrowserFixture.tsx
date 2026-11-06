import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../context/SettingsContext';
import { getLanguageInfo, type SupportedLanguage } from '../../i18n/languages';
import { resolveLanguagePreference } from '../../i18n/resolveLanguage';
import { ensureLanguageResource } from '../../i18n';
import type { EncryptionState } from '../../types';
import { EncryptionBadge } from '../shared/EncryptionBadge';
import { PrivacySettingsTab, AdvancedSettingsTab } from '../desktop/dashboard/settings/SettingsTabs';
import { ThemesTab } from '../desktop/dashboard/ThemesTab';
import { Toaster } from 'sonner';

/** Real presentation/state/providers; native storage, Telegram and payments remain controlled. */
export function LocalizationArraysBrowserFixture() {
  const { i18n } = useTranslation();
  const { settings, updateSetting, updateSettings, isLoaded } = useSettings();
  const [view, setView] = useState('privacy');
  const [state, setState] = useState<EncryptionState>('encrypted_key_missing');
  const [lastAction, setLastAction] = useState('');
  const languageQueue = useRef(Promise.resolve());
  const [languageError, setLanguageError] = useState<string | null>(null);
  useEffect(() => {
    if (!isLoaded) return;
    let live = true;
    const language = resolveLanguagePreference(settings.language);
    languageQueue.current = languageQueue.current.then(async () => {
      await ensureLanguageResource(language);
      if (!live) return;
      await i18n.changeLanguage(language);
      document.documentElement.lang = language;
      document.documentElement.dir = getLanguageInfo(language).dir;
    }).catch(error => { if (live) setLanguageError(String(error)); });
    return () => { live = false; };
  }, [settings.language, isLoaded, i18n]);

  if (languageError) return <p role="alert">{languageError}</p>;
  if (!isLoaded) return null;
  return (
    <main data-locale-arrays={i18n.language} className="min-h-screen bg-app-canvas p-4 text-app-text">
      <Toaster />
      <label>Fixture language<select aria-label="Fixture language" value={settings.language} onChange={event => updateSetting('language', event.target.value as SupportedLanguage)}>{['es', 'en'].map(language => <option key={language}>{language}</option>)}</select></label>
      <label>Fixture view<select aria-label="Fixture view" value={view} onChange={event => setView(event.target.value)}>{['privacy', 'themes', 'advanced'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Fixture protection<select aria-label="Fixture protection" value={state} onChange={event => setState(event.target.value as EncryptionState)}>{['encrypted_unlocked', 'encrypted_locked', 'encrypted_key_missing', 'encrypted_unsupported_version', 'encrypted_corrupt', 'encrypted_verifying'].map(value => <option key={value}>{value}</option>)}</select></label>
      <div data-badge><EncryptionBadge state={state} showLabel /></div>
      <section data-copy-view>{view === 'privacy' ? <PrivacySettingsTab crashReportingEnabled={settings.crashReportingEnabled} onCrashReportingChange={() => updateSetting('crashReportingEnabled', !settings.crashReportingEnabled)} settings={settings} onSettingsChange={updateSettings} onSettingsSyncEnabledChange={enabled => updateSetting('telegramSettingsSyncEnabled', enabled)} />
          : view === 'themes' ? <ThemesTab /> : <AdvancedSettingsTab onOpenWebDav={() => setLastAction('webdav')} onOpenProxy={() => setLastAction('proxy')} onOpenVpn={() => setLastAction('vpn')} />}</section>
      <output data-last-action>{lastAction}</output>
    </main>
  );
}
