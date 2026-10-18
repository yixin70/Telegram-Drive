import { expect, test } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

test('storage insights show when their retained inventory is partial', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Large files', exact: true }).click();
  await expect(page.getByText('1200 indexed results · partial inventory', { exact: true })).toBeVisible();
});
