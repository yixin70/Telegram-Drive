import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// Real browser decoding/canvas capture; only native credentials and Telegram HTTP
// are controlled. These synthetic clips contain no user data.
async function videoSource(page: Page, lateMoov = false, gate?: () => Promise<void>) {
  const bytes = readFileSync(new URL(`../../src-tauri/tests/fixtures/video-upload/synthetic-h264${lateMoov ? '-moov-late' : ''}.mp4`, import.meta.url));
  const requests: string[] = [];
  await page.route('http://localhost:14201/stream/**', async route => {
    requests.push(route.request().url());
    await gate?.();
    const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    await route.fulfill({ status: match ? 206 : 200, contentType: 'video/mp4',
      headers: { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) },
      body: bytes.subarray(start, end + 1) });
  });
  return requests;
}

for (const lateMoov of [false, true]) {
  test(`video list rows capture a real frame when no native thumbnail exists (${lateMoov ? 'late' : 'early'} moov)`, async ({ page }) => {
    await desktopFixture(page, { video: true, videoThumbnailUnavailable: true });
    const requests = await videoSource(page, lateMoov);
    await page.goto('/');
    const image = page.getByRole('img', { name: 'Holiday folder video.mp4', exact: true });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeLessThanOrEqual(320);
    expect(requests.length).toBeGreaterThan(0);
    expect((await nativeCalls(page, 'cmd_get_preview')).length).toBe(0);
  });
}

test('unlocked encrypted video cards work without an exposed vault session and discard thumbnails on lock', async ({ page }, testInfo) => {
  await desktopFixture(page, { video: true, protectedVideo: true, encryptionReady: true, vaultState: 'unlocked',
    videoThumbnailUnavailable: true, settings: { viewMode: 'grid' } });
  const requests = await videoSource(page);
  await page.goto('/');
  const image = page.getByRole('img', { name: 'Holiday folder video.mp4', exact: true });
  await expect(image).toBeVisible();
  await expect(image).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('video-thumbnails.png') });
  expect(requests.every(url => new URL(url).searchParams.get('credential') === '9007199254740993')).toBe(true);
  expect(await nativeCalls(page, 'cmd_get_thumbnail')).toHaveLength(0);
  const thumbnail = await image.getAttribute('src');
  const count = requests.length;
  await page.getByRole('button', { name: 'Switch to List', exact: true }).click();
  await expect(image).toHaveAttribute('src', thumbnail!);
  expect(requests).toHaveLength(count);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.vaultLocked = true;
    state.emit('vault-locked', {});
  });
  await expect(image).toHaveCount(0);
});

test('locking while a video thumbnail is loading cannot publish a late decrypted frame', async ({ page }) => {
  await desktopFixture(page, { video: true, protectedVideo: true, encryptionReady: true, vaultState: 'unlocked',
    videoThumbnailUnavailable: true, settings: { viewMode: 'grid' } });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requests = await videoSource(page, false, () => pending);
  await page.goto('/');
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.vaultLocked = true;
    state.emit('vault-locked', {});
  });
  release();
  await expect(page.getByRole('img', { name: 'Holiday folder video.mp4', exact: true })).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('img', { name: 'Holiday folder video.mp4', exact: true })).toHaveCount(0);
});

test('a failed video decoder leaves the file usable without retrying forever', async ({ page }) => {
  await desktopFixture(page, { video: true, videoThumbnailUnavailable: true, settings: { viewMode: 'grid' } });
  let requests = 0;
  await page.route('http://localhost:14201/stream/**', route => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'invalid video' });
  });
  await page.goto('/');
  // Aggregate Recents intentionally disables bulk selection. Open its real folder.
  await page.getByRole('group', { name: 'Photos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Photos', exact: true })).toBeVisible();
  const card = page.getByRole('group', { name: 'Holiday folder video.mp4', exact: true });
  await expect(card).toBeVisible();
  await expect.poll(() => requests).toBeGreaterThan(0);
  await expect(card.locator('[data-video-thumbnail-loading]')).toHaveCount(0);
  await expect(card.locator('img')).toHaveCount(0);
  await card.hover();
  await expect(page.getByRole('button', { name: 'Preview Holiday folder video.mp4', exact: true })).toBeVisible();
  const count = requests;
  await page.getByRole('button', { name: 'Select Holiday folder video.mp4', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Deselect Holiday folder video.mp4', exact: true })).toBeVisible();
  expect(requests).toBe(count);
});

test('locked videos never request plaintext or persistent thumbnails', async ({ page }) => {
  await desktopFixture(page, { video: true, protectedVideo: true, encryptionReady: true, vaultState: 'locked',
    videoThumbnailUnavailable: true, settings: { viewMode: 'grid' } });
  const requests = await videoSource(page);
  await page.goto('/');
  await expect(page.getByText('Holiday folder video.mp4', { exact: true })).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_get_vault_status')).length).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(requests).toHaveLength(0);
  expect(await nativeCalls(page, 'cmd_get_thumbnail')).toHaveLength(0);
  expect(await nativeCalls(page, 'cmd_get_stream_info')).toHaveLength(0);
});

test('an account switch cancels an in-flight decoded thumbnail before it can appear', async ({ page }) => {
  await desktopFixture(page, { video: true, videoThumbnailUnavailable: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let switched = false;
  const requests = await videoSource(page, false, () => switched ? Promise.resolve() : pending);
  await page.goto('/');
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  switched = true;
  await page.evaluate(() => { (window as any).__desktopTest.owner = '202'; document.dispatchEvent(new Event('visibilitychange')); });
  const image = page.getByRole('img', { name: 'Work folder video.mp4', exact: true });
  await expect(image).toBeVisible();
  release();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(image).toBeVisible();
  await expect(page.getByRole('img', { name: 'Holiday folder video.mp4', exact: true })).toHaveCount(0);
});
