import { expect, test } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

// Real application/transfer subscriptions; the native queue and progress events
// are controlled. This does not measure live Telegram throughput.
for (const direction of ['upload', 'download'] as const) {
  test(`each ${direction} displays its live network speed and hides stale rates when stopped`, async ({ page }, testInfo) => {
    await desktopFixture(page, { populatedTransfers: true });
    await page.goto('/');
    const center = page.getByRole('complementary', { name: 'Transfer activity', exact: true });
    const filename = `Fixture ${direction}.bin`;
    const row = center.locator('div.border-t').filter({ has: page.getByText(filename, { exact: true }) });
    await expect(row.getByText('128B/s', { exact: true })).toBeVisible();

    async function update(status: string, speed: number) {
      await page.evaluate(({ direction, status, speed }) => {
        const state = (window as any).__desktopTest;
        const job = state.jobs.find((job: any) => job.id === `${direction}-active`);
        Object.assign(job, { status, speedBytesPerSec: speed, revision: job.revision + 1 });
        state.emit('transfer-upserted', { ...job });
      }, { direction, status, speed });
    }

    const active = direction === 'upload' ? 'uploading' : 'downloading';
    await update(active, 1.5 * 1024 ** 2);
    await expect(row.getByText('1.5MB/s', { exact: true })).toBeVisible();
    const other = center.locator('div.border-t').filter({ has: page.getByText(`Fixture ${direction === 'upload' ? 'download' : 'upload'}.bin`, { exact: true }) });
    await expect(other.getByText('128B/s', { exact: true })).toBeVisible();
    if (direction === 'upload') {
      await center.screenshot({ path: testInfo.outputPath('transfer-speeds.png') });
      // A remote URL import downloads before uploading, with its own rate.
      await update('downloading', 256 * 1024);
      await expect(row.getByText('256kB/s', { exact: true })).toBeVisible();
    }
    await update(active, 0);
    await expect(row.getByText('0B/s', { exact: true })).toBeVisible();

    // Processing throughput is not network transfer speed. Even a stale native
    // rate must disappear in these states, and must not inflate the total.
    for (const status of ['pending', 'paused', 'waiting_for_network', 'cooldown', 'waiting_for_unlock',
      'encrypting', 'decrypting', 'verifying', 'completed', 'failed', 'cancelled']) {
      // Upload jobs do not have a decrypting phase.
      if (direction === 'upload' && status === 'decrypting') continue;
      // Native download jobs never use uploading/encrypting.
      if (direction === 'download' && status === 'encrypting') continue;
      await update(status, 5 * 1024 ** 2);
      await expect(row.getByText(/\/s$/)).toHaveCount(0);
      await expect(center.getByRole('button', { expanded: true })).toContainText('128B/s');
    }
    await update(active, 256 * 1024);
    await expect(row.getByText('256kB/s', { exact: true })).toBeVisible();
    await center.getByRole('button', { expanded: true }).click();
    await expect(row).not.toBeVisible();
    await update(active, 3 * 1024 ** 2);
    await expect(center.getByRole('button', { expanded: false })).toContainText('3MB/s');
    await center.getByRole('button', { expanded: false }).click();
    await expect(row.getByText('3MB/s', { exact: true })).toBeVisible();
  });
}

test('unknown or invalid transfer rates are not displayed as numbers', async ({ page }) => {
  await desktopFixture(page, { populatedTransfers: true });
  await page.goto('/');
  const center = page.getByRole('complementary', { name: 'Transfer activity', exact: true });
  const row = center.locator('div.border-t').filter({ has: page.getByText('Fixture download.bin', { exact: true }) });
  await expect(row.getByText('128B/s', { exact: true })).toBeVisible();
  for (const rate of ['missing', 'negative', 'nan', 'infinity']) {
    await page.evaluate(rate => {
      const state = (window as any).__desktopTest;
      const job = state.jobs.find((job: any) => job.id === 'download-active');
      job.speedBytesPerSec = rate === 'missing' ? undefined : rate === 'negative' ? -1024 : rate === 'nan' ? NaN : Infinity;
      job.revision++;
      state.emit('transfer-upserted', { ...job });
    }, rate);
    await expect(row.getByText(/\/s$/)).toHaveCount(0);
    await expect(center.getByRole('button', { expanded: true })).toContainText('128B/s');
    await expect(center).not.toContainText(/NaN|Infinity|undefined/);
  }
});

test('transfer rates from a previous account cannot appear after switching accounts', async ({ page }) => {
  await desktopFixture(page, { populatedTransfers: true });
  await page.goto('/');
  const center = page.getByRole('complementary', { name: 'Transfer activity', exact: true });
  await expect(center.getByText('Fixture download.bin', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.owner = '202';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(center).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    const old = state.jobs.find((job: any) => job.id === 'download-active');
    Object.assign(old, { speedBytesPerSec: 99 * 1024 ** 2, revision: old.revision + 1 });
    state.emit('transfer-upserted', { ...old });
    const current = { ...old, id: 'new-download', ownerId: '202', filename: 'New account download.bin', speedBytesPerSec: 512 * 1024 };
    state.jobs.push(current);
    state.emit('transfer-upserted', current);
  });
  await expect(center.getByText('New account download.bin', { exact: true })).toBeVisible();
  await expect(center.getByText('512kB/s', { exact: true })).toBeVisible();
  await expect(center).not.toContainText('Fixture download.bin');
  await expect(center).not.toContainText('99MB/s');
});

test('per-file transfer speeds follow the selected application language', async ({ page }) => {
  await desktopFixture(page, { populatedTransfers: true, settings: { language: 'es' } });
  await page.goto('/');
  const center = page.locator('aside').filter({ has: page.getByText('Fixture upload.bin', { exact: true }) });
  await expect(center.getByText('Fixture upload.bin', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    const job = state.jobs.find((job: any) => job.id === 'upload-active');
    Object.assign(job, { speedBytesPerSec: 1.5 * 1024 ** 2, revision: job.revision + 1 });
    state.emit('transfer-upserted', { ...job });
  });
  await expect(center.getByText('1,5MB/s', { exact: true })).toBeVisible();
});
