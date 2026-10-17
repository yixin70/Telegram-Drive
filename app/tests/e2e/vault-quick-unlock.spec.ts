import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// Real application/modal/keyboard journeys with a controlled native vault boundary.
// These do not validate the passphrase cryptography or OS credential storage.
test('the green shortcut beside Sync unlocks the vault without opening Settings', async ({ page }, testInfo) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  const shortcut = page.getByRole('button', { name: 'Unlock Vault', exact: true });
  await expect(shortcut).toBeVisible();
  const sync = page.locator('.sidebar-sync-action');
  expect(await shortcut.evaluate((button, syncButton) => button.previousElementSibling === syncButton, await sync.elementHandle())).toBe(true);
  await expect(shortcut).toHaveCSS('color', await page.locator('aside .bg-app-success').first().evaluate(dot => getComputedStyle(dot).backgroundColor));
  await page.screenshot({ path: testInfo.outputPath('quick-vault-unlock.png') });
  await shortcut.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Unlock Vault', exact: true });
  const password = dialog.getByPlaceholder('Vault passphrase (min 8 characters)', { exact: true });
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute('type', 'password');
  await expect(dialog.getByRole('button', { name: 'Unlock Vault', exact: true })).toBeDisabled();
  await password.fill('synthetic quick unlock password');
  await password.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Vault unlocked', exact: true })).toBeDisabled();
  expect(await nativeCalls(page, 'cmd_unlock_vault')).toEqual([{ command: 'cmd_unlock_vault', args: { passphrase: 'synthetic quick unlock password' } }]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic quick unlock password');
  expect(await nativeCalls(page, 'cmd_create_vault')).toHaveLength(0);
  await page.evaluate(() => { const state = (window as any).__desktopTest; state.vaultLocked = true; state.emit('vault-locked', {}); });
  await expect(shortcut).toBeEnabled();
});

test('cancel and Escape discard the password and return focus to the shortcut', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  const shortcut = page.getByRole('button', { name: 'Unlock Vault', exact: true });
  await shortcut.click();
  const dialog = page.getByRole('dialog', { name: 'Unlock Vault', exact: true });
  const password = dialog.getByPlaceholder('Vault passphrase (min 8 characters)', { exact: true });
  await password.fill('discard this synthetic password');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(shortcut).toBeFocused();
  await shortcut.click();
  await expect(password).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await nativeCalls(page, 'cmd_unlock_vault')).toHaveLength(0);
});

test('unlocking refreshes the open folder without requiring a separate Sync', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  await page.getByRole('group', { name: 'Photos', exact: true }).dblclick();
  await expect(page.getByRole('group', { name: 'Holiday folder photo.jpg', exact: true })).toBeVisible();
  const before = (await nativeCalls(page, 'cmd_get_files')).length;
  await page.getByRole('button', { name: 'Unlock Vault', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Unlock Vault', exact: true });
  await dialog.getByPlaceholder('Vault passphrase (min 8 characters)', { exact: true }).fill('synthetic folder unlock');
  await dialog.getByRole('button', { name: 'Unlock Vault', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await nativeCalls(page, 'cmd_get_files')).length).toBeGreaterThan(before);
});

test('wrong passwords can be retried and a pending unlock cannot be submitted twice', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  await page.evaluate(() => { (window as any).__desktopTest.vaultUnlockFails = true; });
  await page.getByRole('button', { name: 'Unlock Vault', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Unlock Vault', exact: true });
  const password = dialog.getByPlaceholder('Vault passphrase (min 8 characters)', { exact: true });
  await password.fill('wrong synthetic password');
  await password.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('Wrong passphrase');
  await expect(password).toHaveValue('');
  await page.evaluate(() => { const state = (window as any).__desktopTest; state.vaultUnlockFails = false; state.holdVaultUnlock = true; });
  await password.fill('correct synthetic password');
  await password.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Unlocking...', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  expect(await nativeCalls(page, 'cmd_unlock_vault')).toHaveLength(2);
  await page.evaluate(() => { (window as any).__desktopTest.releaseVaultUnlock(); });
  await expect(dialog).toHaveCount(0);
});

test('the collapsed sidebar keeps the unlock shortcut accessible', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'locked', settings: { sidebarCollapsed: true } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Unlock Vault', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Unlock Vault', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('an account change discards an unsubmitted vault password', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  const shortcut = page.getByRole('button', { name: 'Unlock Vault', exact: true });
  await shortcut.click();
  const dialog = page.getByRole('dialog', { name: 'Unlock Vault', exact: true });
  await dialog.getByPlaceholder('Vault passphrase (min 8 characters)', { exact: true }).fill('old account synthetic secret');
  await page.evaluate(() => { (window as any).__desktopTest.owner = '202'; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(dialog).toHaveCount(0);
  await shortcut.click();
  await expect(dialog.getByPlaceholder('Vault passphrase (min 8 characters)', { exact: true })).toHaveValue('');
  expect(await nativeCalls(page, 'cmd_unlock_vault')).toHaveLength(0);
});

test('without an existing vault there is no misleading unlock shortcut', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'none' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock Vault', exact: true })).toHaveCount(0);
});
