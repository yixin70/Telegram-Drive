import { expect, test } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

test('video notes icon opens an immediate preview and a keyboard-accessible editor', async ({ page }) => {
  await desktopFixture(page, { video: true });
  await page.goto('/');
  const icon = page.getByRole('button', { name: 'Notes for Holiday folder video.mp4', exact: true });
  await expect(icon).toBeVisible();
  await icon.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await icon.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Video notes', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('textbox')).toBeFocused();
  await editor.getByRole('textbox').fill('First line\nSecond line — 日本語');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await icon.hover();
  await expect(page.getByRole('tooltip')).toContainText('Second line — 日本語');
});

test('locked protected videos do not disclose note existence or plaintext', async ({ page }) => {
  await desktopFixture(page, { video: true, protectedVideo: true, encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  await expect(page.getByText('Holiday folder video.mp4', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Video notes', exact: true })).toHaveCount(0);
});
