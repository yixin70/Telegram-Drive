import {expect, test} from '@playwright/test';
import {desktopFixture, nativeCalls} from './desktop-fixture';

test('Settings offers only English and Spanish', async ({page}) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', {name: 'Preferences', exact: true}).click();
  await page.getByRole('menu').getByRole('button', {name: 'Preferences', exact: true}).click();
  const languages = page.getByRole('combobox', {name: 'Application Language', exact: true});
  await expect(languages.locator('option')).toHaveCount(2);
  expect(await languages.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['en', 'es']);
  await languages.selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect.poll(async () => (await nativeCalls(page, 'cmd_set_native_language')).at(-1)?.args.language).toBe('es');
});

for (const language of ['ar', 'fr', 'zh-TW']) {
  test(`retired saved preference ${language} safely falls back to English`, async ({page}) => {
    await desktopFixture(page, {settings: {language}});
    await page.goto('/');
    await expect(page.getByRole('button', {name: 'Preferences', exact: true})).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect.poll(async () => (await nativeCalls(page, 'cmd_set_native_language')).at(-1)?.args.language).toBe('en');
    await expect(page.locator('[data-language-bootstrap="error"]')).toHaveCount(0);
  });
}

for (const [systemLanguage, expectedLanguage] of [['es-MX', 'es'], ['en-GB', 'en'], ['fr-FR', 'en']]) {
  test(`system locale ${systemLanguage} resolves to ${expectedLanguage}`, async ({page}) => {
    await desktopFixture(page, {settings: {language: 'system'}});
    await page.addInitScript(language => {
      Object.defineProperty(navigator, 'language', {get: () => language});
      Object.defineProperty(navigator, 'languages', {get: () => [language]});
    }, systemLanguage);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', expectedLanguage);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect.poll(async () => (await nativeCalls(page, 'cmd_set_native_language')).at(-1)?.args.language).toBe(expectedLanguage);
    await expect(page.locator('[data-language-bootstrap="error"]')).toHaveCount(0);
  });
}
