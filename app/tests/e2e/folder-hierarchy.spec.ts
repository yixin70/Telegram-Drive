import { expect, test } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

test('nested folders keep Saved Messages distinct, create in context and move without files', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Folders', exact: true }).first().click();
  await expect(page.getByRole('navigation', { name: 'Folder path' })).toBeVisible();
  const children = page.getByRole('region', { name: 'Child folders' });
  await children.getByRole('button', { name: 'Photos', exact: true }).click();
  await page.getByRole('button', { name: 'Create Folder', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Photos');
  await dialog.getByRole('textbox').fill('Website');
  await dialog.getByRole('button', { name: 'Create private folder' }).click();
  await expect(children.getByRole('button', { name: 'Website', exact: true })).toBeVisible();
  await children.getByRole('button', { name: 'Website', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText('Photos');
  await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText('Website');
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Photos', exact: true }).click();
  await children.getByRole('button', { name: 'Move Website' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Folders (top level)', exact: true }).click();
  await expect(children.getByRole('button', { name: 'Website', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Folders', exact: true }).click();
  await expect(children.getByRole('button', { name: 'Website', exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__desktopTest.calls);
  expect(calls.find((call: any) => call.command === 'cmd_create_folder').args.parentId).toBe(9);
  expect(calls.filter((call: any) => /cmd_(move_files|delete_files|upload)/.test(call.command))).toHaveLength(0);
});

test('automatic hierarchy sync reports errors without discarding cached folders and recovers on resume', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Folders', exact: true }).first().click();
  await page.evaluate(() => { (window as any).__desktopTest.hierarchyFails = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('status').filter({ hasText: 'Folder sync failed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Child folders' }).getByRole('button', { name: 'Photos', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.hierarchyFails = false; });
  // Reconnection/resume retries automatically after the first backoff, not a
  // manual Sync button. The controlled Telegram boundary is restored above.
  await page.clock.install();
  await page.clock.fastForward(90_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('status').filter({ hasText: 'Folder layout synced with Telegram' })).toBeVisible();
});

// The shipping entry point is the desktop shell even with Android OS flags.
// Mount the real mobile dashboard and providers via the development route;
// this exercises touch UI, not an Android WebView or native back-button lifecycle.
test('mobile dashboard creates a child and returns through its ancestors', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await desktopFixture(page, { platform: 'android' });
  await page.goto('/?a11y-fixture=mobile-folders');
  const path = page.getByRole('navigation', { name: 'Folder path' });
  await expect(path).toContainText('Photos');
  await path.getByRole('button', { name: 'Create Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Touch child');
  await dialog.getByRole('button', { name: 'Create private folder' }).click();
  const children = page.getByRole('region', { name: 'Child folders' });
  await children.getByRole('button', { name: 'Touch child', exact: true }).click();
  await expect(path).toContainText('Touch child');
  await path.getByRole('button', { name: 'Photos', exact: true }).click();
  await children.getByRole('button', { name: 'Move Touch child', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Photos / Touch child', exact: true })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Folders (top level)', exact: true }).click();
  await path.getByRole('button', { name: 'Folders', exact: true }).click();
  await expect(children.getByRole('button', { name: 'Touch child', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toHaveCount(0);
});

test('a delayed automatic sync reply cannot undo a newly created child', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Folders', exact: true }).first().click();
  const children = page.getByRole('region', { name: 'Child folders' });
  await children.getByRole('button', { name: 'Photos', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Folder layout synced with Telegram' })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.holdHierarchy = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.hierarchyHeld)).toBe(true);
  await page.getByRole('button', { name: 'Create Folder', exact: true }).last().click();
  await page.getByRole('dialog').getByRole('textbox').fill('Keep this child');
  await page.getByRole('dialog').getByRole('button', { name: 'Create private folder' }).click();
  await expect(children.getByRole('button', { name: 'Keep this child', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__desktopTest.releaseHierarchy());
  await expect(page.getByRole('status').filter({ hasText: 'Folder layout synced with Telegram' })).toBeVisible();
  await expect(children.getByRole('button', { name: 'Keep this child', exact: true })).toBeVisible();
});

test('channel creation cannot be dismissed and blindly retried while Telegram is responding', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Folders', exact: true }).first().click();
  await page.getByRole('button', { name: 'Create Folder', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Only one channel');
  await page.evaluate(() => { (window as any).__desktopTest.holdCreateFolder = true; });
  await dialog.getByRole('button', { name: 'Create private folder' }).click();
  await expect(dialog.getByRole('button', { name: /Creating/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__desktopTest.releaseCreateFolder());
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Child folders' }).getByRole('button', { name: 'Only one channel', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.calls.filter((call: any) => call.command === 'cmd_create_folder').length)).toBe(1);
});
