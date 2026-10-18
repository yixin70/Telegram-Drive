import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

// Exercise the desktop application entry point, with only native/Telegram IPC
// simulated. Platform flags do not turn this entry point into MobileDashboard
// and do not establish native Android/TV behavior.
// Never contact the former advertising providers during this test.
for (const platform of ['desktop', 'android', 'tv'] as const) {
  test(`desktop shell with ${platform} flags stays free without ads or purchase prompts`, async ({ page }) => {
    await page.clock.install();
    const adRequests: string[] = [];
    await desktopFixture(page, {
      platform: platform === 'desktop' ? 'windows' : 'android',
      isTelevision: platform === 'tv',
      gatewaySeen: false,
    });
    await page.route(/effectivecpmnetwork|highperformanceformat|\/ad-(banner|script)/, route => {
      adRequests.push(route.request().url());
      return route.abort();
    });
    if (platform !== 'desktop') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByText('Holiday folder photo.jpg', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('iframe[src*="/ad-banner"]')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: /Sponsored advertisement/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Sponsored.*View offer/ })).toHaveCount(0);
    await page.clock.fastForward(16 * 60 * 1000);
    await expect(page.locator('iframe[src*="/ad-banner"]')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: /Sponsored advertisement/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Sponsored.*View offer/ })).toHaveCount(0);
    expect(adRequests).toEqual([]);
    expect(await nativeCalls(page, 'plugin:shell|open')).toHaveLength(0);
    await openSettings(page);
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /supporter|lifetime license|buy|purchase|restore purchase|donate/i })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__desktopTest.calls.filter(
      (call: { command: string }) => /supporter|checkout|entitlement/i.test(call.command),
    ))).toEqual([]);
  });
}

test('sign-in has no donation or purchase surface', async ({ page }) => {
  await desktopFixture(page, { signedOut: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue to QR sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /supporter|lifetime license|buy|purchase|donate/i })).toHaveCount(0);
  await expect(page.locator('a[href^="bitcoin:"], a[href^="litecoin:"], a[href*="paypal.com"]')).toHaveCount(0);
  expect(await nativeCalls(page, 'plugin:shell|open')).toHaveLength(0);
});

test('dashboard startup does not wait on a sponsor gateway', async ({ page }) => {
  await desktopFixture(page, { gatewaySeen: false });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('iframe[src*="/ad-banner"]')).toHaveCount(0);
});
