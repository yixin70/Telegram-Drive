import { expect, test } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

test('encrypt a folder name, withdraw it on lock and restore it on unlock', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'unlocked' });
  await page.goto('/');
  const folder = page.getByRole('group', { name: 'Photos', exact: true });
  await folder.getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Encrypt folder name' });
  await expect(dialog).toContainText('Existing file contents');
  await dialog.getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.calls.some((c: any) => c.command === 'cmd_encrypt_folder_name'))).toBe(true);
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.vaultLocked = true; s.emit('vault-locked', {}); });
  await expect(page.getByRole('group', { name: 'Encrypted', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Photos', exact: true })).toHaveCount(0);
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toHaveCount(0);
  await page.getByRole('group', { name: 'Encrypted', exact: true }).click();
  await expect(page.getByText('Unlock the vault to open this folder.', { exact: true })).toBeVisible();
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.vaultLocked = false; s.emit('vault-unlocked', {}); });
  await expect(page.getByRole('group', { name: 'Photos', exact: true })).toBeVisible();
});

test('refused encryption leaves the folder name unchanged', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  await page.getByRole('group', { name: 'Photos', exact: true }).getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await page.getByRole('dialog', { name: 'Encrypt folder name' }).getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await expect(page.getByText('Unlock the vault to encrypt this folder name.', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Photos', exact: true })).toBeVisible();
});

test('an unlocked hierarchy reply arriving after lock cannot restore a protected name', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'unlocked' });
  await page.goto('/');
  await page.getByRole('group', { name: 'Photos', exact: true }).getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await page.getByRole('dialog', { name: 'Encrypt folder name' }).getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await expect(page.getByText('Folder name encrypted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Folder layout synced with Telegram' })).toBeVisible();
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.holdHierarchy = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.hierarchyHeld)).toBe(true);
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.vaultLocked = true; s.emit('vault-locked', {}); s.releaseHierarchy(); });
  await expect(page.getByRole('group', { name: 'Encrypted', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Photos', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Folder layout synced with Telegram' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Photos', exact: true })).toHaveCount(0);
});

test('rename keeps protection and a locked menu is withdrawn', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'unlocked' });
  await page.goto('/');
  await page.getByRole('group', { name: 'Photos', exact: true }).getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await page.getByRole('dialog', { name: 'Encrypt folder name' }).getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await expect(page.getByText('Folder name encrypted.', { exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Photos', exact: true }).getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Renamed private folder');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Renamed private folder', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Renamed private folder', exact: true }).getByRole('button', { name: 'Folder settings' }).click();
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.vaultLocked = true; s.emit('vault-locked', {}); });
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Renamed private folder', exact: true })).toHaveCount(0);
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.vaultLocked = false; s.emit('vault-unlocked', {}); });
  await expect(page.getByRole('group', { name: 'Renamed private folder', exact: true })).toBeVisible();
});

test('locking dismisses a confirmation containing a decrypted folder name', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'unlocked' });
  await page.goto('/');
  const folder = page.getByRole('group', { name: 'Photos', exact: true });
  await folder.getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await page.getByRole('dialog', { name: 'Encrypt folder name' }).getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await expect(page.getByText('Folder name encrypted.', { exact: true })).toBeVisible();
  await folder.getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Photos');
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.vaultLocked = true; s.emit('vault-locked', {}); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Encrypted', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.calls.filter((c: any) => c.command === 'cmd_delete_folder').length)).toBe(0);
});

test('a deletion finishing after lock cannot reveal the old folder name in a toast', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'unlocked' });
  await page.goto('/');
  const folder = page.getByRole('group', { name: 'Photos', exact: true });
  await folder.getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await page.getByRole('dialog', { name: 'Encrypt folder name' }).getByRole('button', { name: 'Encrypt folder name', exact: true }).click();
  await expect(page.getByText('Folder name encrypted.', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.holdDeleteFolder = true; });
  await folder.getByRole('button', { name: 'Folder settings' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.calls.some((c: any) => c.command === 'cmd_delete_folder'))).toBe(true);
  await page.evaluate(() => { const s = (window as any).__desktopTest; s.vaultLocked = true; s.emit('vault-locked', {}); s.releaseDeleteFolder(); });
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.hierarchyFolders.some((f: any) => f.name === 'Photos'))).toBe(false);
  await expect(page.getByRole('group', { name: 'Encrypted', exact: true })).toHaveCount(0);
  await expect(page.getByText('Folder "Photos" deleted.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Photos', exact: true })).toHaveCount(0);
});
