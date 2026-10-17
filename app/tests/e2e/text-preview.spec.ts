import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

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
