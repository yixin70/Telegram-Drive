import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// Exercise the real application entry point, with only native/Telegram IPC
// simulated. Never contact the former advertising providers during this test.
for (const platform of ['desktop', 'android', 'tv'] as const) {
  for (const supporterState of ['inactive', 'expired', 'active', 'needs_refresh'] as const) {
    test(`${platform} stays ad-free for ${supporterState} accounts without a saved gateway flag`, async ({ page }) => {
      await page.clock.install();
      const adRequests: string[] = [];
      await page.route(/effectivecpmnetwork|highperformanceformat|\/ad-(banner|script)/, route => {
        adRequests.push(route.request().url());
        return route.abort();
      });
      await desktopFixture(page, {
        platform: platform === 'desktop' ? 'windows' : 'android',
        isTelevision: platform === 'tv',
        supporterState,
        gatewaySeen: false,
        settings: { supporterPromptLastShownAt: Date.now() },
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
      expect(await nativeCalls(page, 'cmd_begin_supporter_checkout')).toHaveLength(0);
    });
  }
}

test('dashboard startup does not wait for supporter verification or show a sponsor gateway', async ({ page }) => {
  await desktopFixture(page, { holdSupporter: true, gatewaySeen: false });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('iframe[src*="/ad-banner"]')).toHaveCount(0);
});
