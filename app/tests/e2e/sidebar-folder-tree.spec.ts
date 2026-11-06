import { expect, test, type Locator } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

async function labelStart(row: Locator, rtl: boolean) {
  const box = await row.locator('span').filter({ hasText: /^(MyFolder|Hola|Nested|Sibling|Other)$/ }).boundingBox();
  expect(box).not.toBeNull();
  return rtl ? -box!.x - box!.width : box!.x;
}

for (const rtl of [false, true]) {
  test(`sidebar makes parent, child and sibling folder levels clear (${rtl ? 'RTL' : 'LTR'})`, async ({ page }) => {
    await desktopFixture(page);
    await page.addInitScript(() => {
      (window as any).__desktopTest.hierarchyFolders = [
        { id: 9, name: 'MyFolder', parent_id: null, display_order: 0 },
        { id: 10, name: 'Hola', parent_id: 9, display_order: 0 },
        { id: 11, name: 'Nested', parent_id: 10, display_order: 0 },
        { id: 12, name: 'Sibling', parent_id: 9, display_order: 1 },
        { id: 13, name: 'Other', parent_id: null, display_order: 1 },
      ];
      localStorage.setItem('folder-tree:101', JSON.stringify([9, 10]));
    });
    await page.goto('/');
    const sidebar = page.locator('aside');
    const parent = sidebar.getByRole('group', { name: 'MyFolder', exact: true });
    const child = sidebar.getByRole('group', { name: 'Hola', exact: true });
    const nested = sidebar.getByRole('group', { name: 'Nested', exact: true });
    const sibling = sidebar.getByRole('group', { name: 'Sibling', exact: true });
    const other = sidebar.getByRole('group', { name: 'Other', exact: true });
    await expect(nested).toBeVisible();
    if (rtl) await page.locator('html').evaluate(element => { element.dir = 'rtl'; });

    // Compare rendered label positions, not just depth attributes or CSS classes.
    const parentStart = await labelStart(parent, rtl);
    const childStart = await labelStart(child, rtl);
    const nestedStart = await labelStart(nested, rtl);
    expect(childStart - parentStart).toBeGreaterThanOrEqual(20);
    expect(nestedStart - childStart).toBeCloseTo(childStart - parentStart, 0);
    expect(await labelStart(sibling, rtl)).toBeCloseTo(childStart, 0);
    expect(await labelStart(other, rtl)).toBeCloseTo(parentStart, 0);

    await child.click();
    await expect(child).toHaveClass(/bg-app-selected/);
    await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText('MyFolder');
    await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText('Hola');
    await parent.getByRole('button', { name: 'Collapse MyFolder' }).click();
    await expect(child).toHaveCount(0);
    await expect(nested).toHaveCount(0);
    await expect(sibling).toHaveCount(0);
    await expect(other).toBeVisible();
    await parent.getByRole('button', { name: 'Expand MyFolder' }).click();
    await expect(child).toBeVisible();
    await expect(nested).toBeVisible();
    expect(await labelStart(child, rtl)).toBeCloseTo(childStart, 0);

    await page.getByRole('button', { name: 'Collapse Sidebar', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: 'Collapse MyFolder' })).toHaveCount(0);
    const compactParent = sidebar.locator('[title="MyFolder"]');
    const compactOther = sidebar.locator('[title="Other"]');
    await expect(compactParent).toBeVisible();
    await expect(sidebar.locator('[title="Hola"]')).toHaveCount(0);
    // The sidebar animates its width; wait for both rows to settle into alignment.
    await expect.poll(async () => {
      const [parentIcon, otherIcon] = await Promise.all([
        compactParent.locator('svg').boundingBox(),
        compactOther.locator('svg').boundingBox(),
      ]);
      return Math.abs(parentIcon!.x - otherIcon!.x);
    }).toBeLessThan(0.5);
  });
}
