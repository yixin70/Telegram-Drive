import { expect, test } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

for (const sidebarCollapsed of [false, true]) {
  test(`storage insight views are removed with sidebar ${sidebarCollapsed ? 'collapsed' : 'expanded'}`, async ({ page }) => {
    await desktopFixture(page, { settings: { sidebarCollapsed } });
    await page.goto('/');
    await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
    await expect(page.getByText('Storage insights', { exact: true })).toHaveCount(0);
    for (const name of ['Large files', 'Old files', 'Duplicates']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      await expect(page.getByTitle(name, { exact: true })).toHaveCount(0);
    }
    for (const [name, view] of [['Favorites', 'favorites'], ['Pinned', 'pinned'], ['Recents', 'recents']] as const) {
      const button = page.getByRole('button', { name, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => page.evaluate(view => (window as any).__desktopTest.calls.some((call: any) =>
        call.command === 'cmd_get_file_activity' && call.args.view === view && call.args.ownerId === '101'), view)).toBe(true);
    }
    await expect(page.getByRole('button', { name: 'Offline files', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
    await expect(page.getByText('Holiday saved photo.jpg', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__desktopTest.calls.filter((call: any) => call.command === 'cmd_get_storage_insight'))).toEqual([]);
  });
}
