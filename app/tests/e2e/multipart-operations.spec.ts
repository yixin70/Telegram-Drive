import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

test('protected MP4 preview uses authorized original media instead of unsupported remux or transcoding', async ({ page }) => {
  await desktopFixture(page, { video: true, protectedVideo: true, encryptionReady: true, vaultState: 'unlocked' });
  await page.goto('/');
  await page.getByText('Holiday folder video.mp4', { exact: true }).dblclick();
  await expect(page.locator('video')).toHaveAttribute('src', /\/stream\/9\/\d+\?token=browser-fixture-token&credential=9007199254740993$/);
  const calls = await page.evaluate(() => (window as any).__desktopTest.calls as { command: string }[]);
  expect(calls.filter(call => /remux|transcod|moov/.test(call.command))).toEqual([]);
  await page.keyboard.press('m');
  await expect(page.locator('video')).toHaveJSProperty('muted', true);
  await page.keyboard.press('Escape');
  await expect(page.locator('video')).toHaveCount(0);
  // The controlled browser response is not a codec or live Telegram test.
});

test('ordinary MP4 preview retains the adaptive player', async ({ page }) => {
  await desktopFixture(page, { video: true });
  await page.goto('/');
  await page.getByText('Holiday folder video.mp4', { exact: true }).dblclick();
  await expect(page.locator('video')).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_get_transcode_capabilities')).length).toBeGreaterThan(0);
});

test('multipart deletion asks for a masked secret and retries with only a single-use token', async ({ page }) => {
  await desktopFixture(page, { settings: { viewMode: 'grid' } });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (command: string, args: any) => {
      if (command === 'cmd_delete_file' && !args.promptToken) {
        await original(command, args);
        throw new Error('[MULTIPART_PASSPHRASE_REQUIRED]');
      }
      if (command === 'cmd_stage_file_passphrase') {
        if (args.passphrase !== 'fixture multipart password') throw new Error('Wrong fixture secret');
        return 9981;
      }
      return original(command, args);
    };
  });
  await page.getByRole('button', { name: 'Delete Holiday folder photo.jpg', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete File', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  const secret = page.locator('input[type="password"]');
  await expect(secret).toBeVisible();
  await secret.fill('fixture multipart password');
  await secret.press('Enter');
  await expect.poll(async () => (await nativeCalls(page, 'cmd_delete_file')).length).toBe(2);
  expect((await nativeCalls(page, 'cmd_delete_file'))[1].args).toMatchObject({ ownerId: '101', promptToken: 9981 });
  expect((await nativeCalls(page, 'cmd_delete_file'))[1].args).not.toHaveProperty('passphrase');
  await expect(secret).toHaveCount(0);
});
