import { expect, test, type Page } from '@playwright/test';

async function openGallery(page: Page) {
  await page.goto('/?design-gallery');
  await expect(page.getByRole('heading', { name: 'Quiet Utility gallery' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('light comfortable LTR gallery', async ({ page }) => {
  await openGallery(page);
  await page.getByRole('group', { name: 'Theme preference' }).getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('main[data-density="comfortable"]')).toHaveScreenshot('gallery-light-comfortable-ltr.png', { fullPage: true });
});

test('dark compact RTL gallery', async ({ page }) => {
  await openGallery(page);
  await page.getByRole('group', { name: 'Theme preference' }).getByRole('button', { name: 'Dark' }).click();
  await page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
  await page.getByRole('group', { name: 'Layout direction' }).getByRole('button', { name: 'RTL' }).click();
  await expect(page.locator('main[data-density="compact"]')).toHaveScreenshot('gallery-dark-compact-rtl.png', { fullPage: true });
});

test('focus treatment remains visible', async ({ page }) => {
  await openGallery(page);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus-visible')).toBeVisible();
  await expect(page.locator('main')).toHaveScreenshot('gallery-keyboard-focus.png', { fullPage: true });
});

test('Spanish strings fit the narrow locale fixture', async ({ page }, testInfo) => {
  await page.goto('/?design-gallery&locale-stress');
  await expect(page.getByRole('heading', { name: 'Quiet Utility gallery' })).toBeVisible();
  await page.getByLabel('Audit language').selectOption('es');
  const card = page.getByTestId('localized-offline-card');
  await expect(card).toHaveAttribute('data-language-ready', 'es');
  await expect(card).toContainText('Archivos sin conexión');
  await expect(card).toContainText('Los archivos sin cifrar abiertos recientemente');
  const overflows = await card.evaluate(
    element => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
  );
  expect(overflows, 'Spanish locale fixture should not overflow').toBe(false);
  await expect(card).toHaveScreenshot('gallery-spanish.png', {maxDiffPixelRatio: 0.04});
  await card.screenshot({path: testInfo.outputPath('gallery-spanish.png')});
});

test('both supported languages fit the narrow locale fixture', async ({ page }) => {
  await page.goto('/?design-gallery&locale-stress');
  await expect(page.getByRole('heading', { name: 'Quiet Utility gallery' })).toBeVisible();
  const card = page.getByTestId('localized-offline-card');

  for (const locale of ['en', 'es']) {
    await page.getByLabel('Audit language').selectOption(locale);
    await expect(card).toHaveAttribute('data-language-ready', locale);
    await expect(card).toBeVisible();
    const overflows = await card.evaluate(element => element.scrollWidth > element.clientWidth);
    expect(overflows, `${locale} locale fixture should not overflow`).toBe(false);
  }
});

test('axe accessibility audit has no violation groups', async ({ page }) => {
  await page.goto('/?design-gallery&a11y-audit');
  await expect(page.getByRole('heading', { name: 'Quiet Utility gallery' })).toBeVisible();
  await page.locator('html[data-axe-audit-status="complete"]').waitFor({ timeout: 15_000 });
  const result = await page.evaluate(() => window.__TELEGRAM_DRIVE_AXE_RESULTS__ as {
    violations?: Array<{ id: string; description: string }>;
  });
  expect(result.violations ?? []).toEqual([]);
});

for (const fixture of ['auth', 'dashboard', 'settings', 'dialog', 'mobile']) {
  test(`real ${fixture} screen passes axe`, async ({ page }) => {
    await page.goto(`/?a11y-fixture=${fixture}&a11y-audit`);
    await page.locator(`html[data-a11y-fixture-ready="${fixture}"]`).waitFor({ timeout: 15_000 });
    await page.locator('html[data-axe-audit-status="complete"]').waitFor({ timeout: 15_000 });
    const result = await page.evaluate(() => window.__TELEGRAM_DRIVE_AXE_RESULTS__ as {
      violations?: Array<{ id: string; description: string; nodes: unknown[] }>;
    });
    expect(result.violations ?? []).toEqual([]);
  });
}

test('settings dialog traps focus and closes with Escape', async ({ page }) => {
  await page.goto('/?a11y-fixture=settings');
  const dialog = page.getByRole('dialog', { name: /Settings/i });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('share dialog retains a keyboard-operable close path', async ({ page }) => {
  await page.goto('/?a11y-fixture=dialog');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('mobile primary navigation is keyboard operable', async ({ page }) => {
  await page.goto('/?a11y-fixture=mobile');
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(navigation).toBeVisible();
  const transfers = navigation.getByRole('button', { name: /Transfers/i });
  await transfers.focus();
  await page.keyboard.press('Enter');
  await expect(transfers).toHaveAttribute('aria-current', 'page');
});
