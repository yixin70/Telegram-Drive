import { expect, test, type Page } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

async function openText(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Grid', exact: true }).click();
  await page.getByRole('group', { name: 'Fixture notes.txt', exact: true }).hover();
  await page.getByRole('button', { name: 'Preview Fixture notes.txt', exact: true }).click();
  return page.getByRole('textbox', { name: 'Fixture notes.txt', exact: true });
}

// The text body comes from the read command as fixture content; the Telegram
// download and the replacing upload are outside this browser journey.
test('a text file opens in the built-in viewer, is edited and saved', async ({ page }) => {
  await desktopFixture(page, { textContent: 'hello from fixture' });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Grid', exact: true }).click();
  await page.getByRole('group', { name: 'Fixture notes.txt', exact: true }).hover();
  await page.getByRole('button', { name: 'Preview Fixture notes.txt', exact: true }).click();

  const editor = page.getByRole('textbox', { name: 'Fixture notes.txt', exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor).toHaveValue('hello from fixture');

  await editor.fill('edited from fixture');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(async () => (await nativeCalls(page, 'cmd_save_text_file')).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const calls = await nativeCalls(page, 'cmd_save_text_file');
  expect(calls[calls.length - 1].args.content).toBe('edited from fixture');
  await expect(save).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Fixture notes.txt', exact: true })).toBeVisible();
});

test('protected text can be edited and saved, then is erased when the vault locks', async ({ page }) => {
  await desktopFixture(page, { textContent: 'private text', protectedText: true, vaultState: 'unlocked' });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Grid', exact: true }).click();
  await page.getByRole('group', { name: 'Fixture notes.txt', exact: true }).hover();
  await page.getByRole('button', { name: 'Preview Fixture notes.txt', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Fixture notes.txt', exact: true });
  await expect(editor).toHaveValue('private text');
  await editor.fill('private edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_save_text_file')).length).toBe(1);
  const [save] = await nativeCalls(page, 'cmd_save_text_file');
  expect(save.args).toMatchObject({ content: 'private edit', ownerId: '101', accessGeneration: 1 });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(editor).toHaveValue('private edit');
  await editor.fill('second private edit');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await nativeCalls(page, 'cmd_save_text_file')).length).toBe(2);
  expect((await nativeCalls(page, 'cmd_save_text_file'))[1].args.messageId).toBe(89);
  await expect(editor).toHaveValue('second private edit');
  await page.evaluate(() => (window as any).__desktopTest.emit('vault-locked', {}));
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('private text', { exact: true })).toHaveCount(0);
});

for (const required of ['read', 'save'] as const) {
  test(`protected text requests a masked file passphrase on ${required}`, async ({ page }) => {
    await desktopFixture(page, { textContent: 'secret', protectedText: true, vaultState: 'unlocked', textRequirePassphrase: required });
    const editor = await openText(page);
    if (required === 'read') {
      const dialog = page.getByRole('dialog');
      await dialog.locator('input[type="password"]').fill('synthetic file password');
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    }
    await expect(editor).toHaveValue('secret');
    await editor.fill('protected edit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="password"]').fill('synthetic file password');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(editor).toHaveValue('protected edit');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    const calls = await nativeCalls(page, 'cmd_save_text_file');
    expect(calls).toHaveLength(2);
    expect(calls[1].args.promptToken).toBe(1234);
    expect(calls[1].args.passphrase).toBeUndefined();
  });
}

test('locking during an in-flight protected read never reveals the late plaintext', async ({ page }) => {
  await desktopFixture(page, { textContent: 'late private text', protectedText: true, vaultState: 'unlocked', holdTextRead: true });
  const editor = await openText(page);
  await expect.poll(async () => (await nativeCalls(page, 'cmd_read_text_file')).length).toBeGreaterThan(0);
  await page.evaluate(() => { const state = (window as any).__desktopTest; state.emit('vault-locked', {}); state.releaseText(); });
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('late private text', { exact: true })).toHaveCount(0);
});

test('a failed protected save keeps the edited text without an automatic retry', async ({ page }) => {
  await desktopFixture(page, { textContent: 'original', protectedText: true, vaultState: 'unlocked' });
  const editor = await openText(page);
  await expect(editor).toHaveValue('original');
  await page.evaluate(() => { (window as any).__desktopTest.textSaveFails = true; });
  await editor.fill('keep unsaved edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Could not save. Please try again.', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('keep unsaved edit');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(await nativeCalls(page, 'cmd_save_text_file')).toHaveLength(1);
});
