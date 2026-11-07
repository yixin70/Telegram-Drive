import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

// Independent historical horizons: deleting production scheduling must not shorten these journeys.
const OLD_STARTUP_DELAY = 6_000;
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const OLD_RECHECK_INTERVAL = 6 * 60 * 60 * 1_000;
const reminderKeys = ['telegram-drive.pending-update', 'telegram-drive.last-seen-version'];

async function expectNoUpdater(page: Page) {
  expect(await page.evaluate(() => (window as any).__desktopTest.calls.filter(
    (call: { command: string; args: any }) => call.command.startsWith('plugin:updater|')
      || /^plugin:process\|(restart|relaunch)$/.test(call.command)
      || (/^plugin:(opener|shell)\|/.test(call.command) && /releases\/latest|updates\/latest\.json/.test(JSON.stringify(call.args))),
  ))).toEqual([]);
  await expect(page.getByText(/A new version .* is available|¡Hay una nueva versión|What's new in|Novedades de|Update complete|Actualización completada/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Update & Restart|Actualizar y reiniciar|Check Now|Comprobar ahora/i })).toHaveCount(0);
}

async function exerciseOldSchedule(page: Page) {
  await page.clock.fastForward(OLD_STARTUP_DELAY);
  await page.clock.fastForward(OLD_RECHECK_INTERVAL);
  // Simulate a stale hidden window returning to the foreground, in addition to interval expiry.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(2 * OLD_RECHECK_INTERVAL);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  // Let native promise continuations and React rendering settle after simulated resume.
  await expect(page.locator('main').first()).toBeVisible();
  await expectNoUpdater(page);
}

for (const language of ['en', 'es']) {
  for (const autoUpdate of [undefined, true, false]) {
    test(`${language}: default/legacy autoUpdate=${autoUpdate} cannot schedule updates`, async ({ page }) => {
      await page.clock.install();
      await desktopFixture(page, { update: true, settings: { language, ...(autoUpdate === undefined ? {} : { autoUpdate }) } });
      await page.goto('/');
      await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
      await exerciseOldSchedule(page);
      await page.getByRole('group', { name: 'Photos', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Holiday folder photo.jpg', exact: true })).toBeVisible();
      await expectNoUpdater(page);
    });
  }
}

test('Settings has no update surface; language changes, reset and restored legacy settings still persist', async ({ page }) => {
  await page.clock.install();
  await desktopFixture(page, { update: true, settings: { autoUpdate: true }, settingsSyncDownload: { autoUpdate: true, language: 'en', maxConcurrentDownloads: 4 } });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openSettings(page);
  let settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByText('Check for Updates', { exact: true })).toHaveCount(0);
  const search = settings.getByPlaceholder('Search settings', { exact: true });
  await search.fill('updates');
  await expect(settings.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'About', exact: true })).toHaveCount(0);
  await search.fill('');
  await settings.getByRole('button', { name: 'About', exact: true }).click();
  await expect(settings.getByText(`v${version}`, { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'General', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Application Language', exact: true }).selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-e2e-stores')!)['settings.json'].settings.language)).toBe('es');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preferencias', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Preferencias', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restablecer valores predeterminados', exact: true }).click();
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('combobox', { name: 'Application Language', exact: true })).toHaveValue('en');
  // Reset also restores crash-report consent to undecided; keep its unrelated prompt working.
  await page.getByRole('button', { name: 'No thanks', exact: true }).click();
  await page.getByRole('button', { name: 'Skip drive introduction', exact: true }).click();
  await exerciseOldSchedule(page);
  await settings.getByRole('button', { name: 'Privacy', exact: true }).click();
  await settings.getByRole('switch', { name: 'Enable encrypted settings sync', exact: true }).click();
  await settings.getByLabel('Sync passphrase', { exact: true }).fill('controlled-settings-passphrase');
  await settings.getByRole('button', { name: 'Download and apply', exact: true }).click();
  await page.getByRole('dialog', { name: 'Apply settings from Telegram?', exact: true }).getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect(page.getByText('Encrypted settings downloaded and applied.', { exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'cmd_download_settings_sync')).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.stores['settings.json'].settings.maxConcurrentDownloads)).toBe(4);
  await exerciseOldSchedule(page);
  await page.reload();
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await openSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.stores['settings.json'].settings)).toMatchObject({ autoUpdate: true, maxConcurrentDownloads: 4 });
  await exerciseOldSchedule(page);
});

for (const pending of [JSON.stringify({ toVersion: version, body: 'Old pending release notes' }), '{invalid-json']) {
  test(`old reminder metadata stays inert across reload (${pending.startsWith('{invalid') ? 'malformed' : 'valid'})`, async ({ page }) => {
    await desktopFixture(page, { update: true, settings: { autoUpdate: false } });
    await page.addInitScript(({ pending, keys }) => {
      localStorage.setItem(keys[0], pending);
      localStorage.setItem(keys[1], '0.0.1');
    }, { pending, keys: reminderKeys });
    await page.goto('/');
    for (let launch = 0; launch < 2; launch++) {
      await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expectNoUpdater(page);
      expect(await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), reminderKeys)).toEqual([pending, '0.0.1']);
      if (launch === 0) await page.reload();
    }
  });
}

test('unavailable reminder storage is never touched and does not block startup', async ({ page }) => {
  await desktopFixture(page);
  await page.addInitScript(keys => {
    (window as any).__reminderStorageAccess = [];
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (key: string, ...args: string[]) {
        if (keys.includes(key)) {
          (window as any).__reminderStorageAccess.push({ method, key });
          throw new DOMException('Optional storage unavailable', 'SecurityError');
        }
        return (original as Function).call(this, key, ...args);
      };
    }
  }, reminderKeys);
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).__reminderStorageAccess)).toEqual([]);
  await expectNoUpdater(page);
});

for (const language of ['en', 'es']) {
  test(`${language}: sign-in is usable without version announcements`, async ({ page }) => {
    await page.clock.install();
    await desktopFixture(page, { signedOut: true, update: true, settings: { language, autoUpdate: true } });
    await page.goto('/');
    await expect(page.getByRole('button', { name: language === 'en' ? 'Continue to QR sign in' : 'Continuar al inicio de sesión con QR', exact: true })).toBeVisible();
    await exerciseOldSchedule(page);
  });
}
