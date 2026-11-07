import { expect, test, type Page } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// Real UI; read/save/Telegram are controlled IPC fixtures. Native envelope
// persistence is exercised separately by the native_e2e protected-text journeys.
async function openMarkdown(page: Page, name = 'Fixture notes.md') {
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Grid', exact: true }).click();
  await previewFile(page, name);
}

async function previewFile(page: Page, name: string) {
  await page.getByRole('group', { name, exact: true }).hover();
  await page.getByRole('button', { name: `Preview ${name}`, exact: true }).click();
}

for (const extension of ['md', 'MD']) {
  test(`.${extension} renders, previews unsaved edits, saves twice and reopens`, async ({ page }) => {
    const name = `Fixture notes.${extension}`;
    await desktopFixture(page, { textFilename: name, textContent: '# Original\n\n**bold**\n\n- [x] task\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst answer = 42;\n```' });
    await openMarkdown(page, name);
    await expect(page.getByRole('heading', { name: 'Original', exact: true })).toBeVisible();
    await expect(page.locator('.markdown-preview strong')).toHaveText('bold');
    await expect(page.locator('.markdown-preview table')).toBeVisible();
    await expect(page.locator('.markdown-preview pre code')).toHaveText('const answer = 42;\n');
    await expect(page.locator('.markdown-preview input[type=checkbox]')).toBeChecked();
    await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
    const editor = page.getByRole('textbox', { name, exact: true });
    await editor.fill('# Draft 日本語\n\n> quoted');
    await page.getByRole('button', { name: 'Preview Markdown', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Draft 日本語' })).toBeVisible();
    expect(await nativeCalls(page, 'cmd_save_text_file')).toHaveLength(0);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
    await expect(editor).toHaveValue('# Draft 日本語\n\n> quoted');
    await editor.fill('# Saved again');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    const calls = await nativeCalls(page, 'cmd_save_text_file');
    expect(calls.map(call => call.args.messageId)).toEqual([88, 89]);
    await page.keyboard.press('Escape');
    await previewFile(page, name);
    await expect(page.getByRole('heading', { name: 'Saved again' })).toBeVisible();
    expect((await nativeCalls(page, 'cmd_read_text_file')).at(-1)?.args.messageId).toBe(90);
  });
}

test('Markdown retains failed drafts, reverts and confirms discard', async ({ page }) => {
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: '# Original' });
  await openMarkdown(page);
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Fixture notes.md', exact: true });
  await editor.fill('# Unsaved');
  await page.evaluate(() => { (window as any).__desktopTest.textSaveFails = true; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Could not save. Please try again.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview Markdown', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved', exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'cmd_save_text_file')).toHaveLength(1);
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Unsaved', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Original', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  await editor.fill('# Discard me');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await previewFile(page, 'Fixture notes.md');
  await expect(page.getByRole('heading', { name: 'Original', exact: true })).toBeVisible();
});

test('long Markdown scrolls inside the viewer without stretching its controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: '# Readable preview\n\n- List item\n- **Bold** item\n\n> A quoted paragraph\n\n```js\n' + 'const wide = "' + 'long source '.repeat(60) + '";\n```\n\n' + 'A paragraph with *emphasis*.\n\n'.repeat(50) });
  await openMarkdown(page);
  const preview = page.getByRole('region', { name: 'Markdown preview', exact: true });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await preview.locator('pre').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  const box = await preview.boundingBox();
  expect(box!.y + box!.height).toBeLessThan(650);
  await expect(page.getByRole('button', { name: 'Edit Markdown', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('markdown-preview.png') });
  await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByRole('button', { name: 'Edit Markdown', exact: true })).toBeInViewport();
});

test('untrusted Markdown never executes HTML, embeds images or resolves unsafe paths', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('markdown-probe.invalid')) requests.push(request.url()); });
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: [
    '# Safe', '<script>window.markdownExecuted=true</script>',
    '<img src="https://markdown-probe.invalid/html.png" onerror="window.markdownExecuted=true">',
    '![Remote](https://markdown-probe.invalid/image.png)', '![Local](file:///private/secret.png)',
    '[Bad](javascript:alert(1))', '[Data](data:text/html,bad)', '[Local](file:///private/secret)',
    '[Relative](../private.txt)', '[Protocol relative](//markdown-probe.invalid/path)',
    '[Safe link](https://example.com/docs)',
  ].join('\n\n') });
  await openMarkdown(page);
  const preview = page.getByRole('region', { name: 'Markdown preview', exact: true });
  await expect(preview.getByRole('heading', { name: 'Safe', exact: true })).toBeVisible();
  await expect(preview.locator('script, img, iframe, object')).toHaveCount(0);
  await expect(preview.getByRole('link')).toHaveCount(1);
  await expect(preview.getByRole('link', { name: 'Safe link' })).toHaveAttribute('href', 'https://example.com/docs');
  await preview.getByRole('link', { name: 'Safe link' }).click();
  await expect.poll(async () => (await nativeCalls(page, 'plugin:shell|open')).length).toBe(1);
  expect(await page.evaluate(() => (window as any).markdownExecuted)).toBeUndefined();
  expect(requests).toEqual([]);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
});

test('protected Markdown saves with its access scope and disappears on lock', async ({ page }) => {
  await desktopFixture(page, { textFilename: 'Fixture notes.MD', textContent: '# Private', protectedText: true, vaultState: 'unlocked' });
  await openMarkdown(page, 'Fixture notes.MD');
  await expect(page.getByRole('heading', { name: 'Private', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open natively', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fixture notes.MD', exact: true }).fill('# Private edit');
  await page.getByRole('button', { name: 'Preview Markdown', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect((await nativeCalls(page, 'cmd_save_text_file'))[0].args).toMatchObject({ ownerId: '101', accessGeneration: 1, content: '# Private edit' });
  await page.evaluate(() => (window as any).__desktopTest.emit('vault-locked', {}));
  await expect(page.getByRole('region', { name: 'Markdown preview', exact: true })).toHaveCount(0);
  await expect(page.getByText('Private edit', { exact: true })).toHaveCount(0);
});

test('oversized Markdown stays out of the renderer and editor', async ({ page }) => {
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: '# Must not render', textTruncated: true });
  await openMarkdown(page);
  await expect(page.getByText('This text file is too large to edit.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Must not render' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Fixture notes.md' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('account changes withdraw rendered protected Markdown', async ({ page }) => {
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: '# Old account secret', protectedText: true, vaultState: 'unlocked' });
  await openMarkdown(page);
  await expect(page.getByRole('heading', { name: 'Old account secret', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.owner = '202'; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByText('Work saved photo.jpg', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Markdown preview', exact: true })).toHaveCount(0);
  await expect(page.getByText('Old account secret', { exact: true })).toHaveCount(0);
});

test('Markdown navigation confirms dirty drafts and can return to rendered preview', async ({ page }) => {
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: '# Navigate me' });
  await openMarkdown(page);
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fixture notes.md', exact: true }).fill('# Dirty navigation');
  await page.getByRole('button', { name: 'Preview Markdown', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Next file', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dirty navigation', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Next file', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Markdown preview', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous file', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Navigate me', exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'cmd_save_text_file')).toHaveLength(0);
});

test('locking during a protected Markdown read suppresses its late render', async ({ page }) => {
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: '# Late secret', protectedText: true, vaultState: 'unlocked', holdTextRead: true });
  await openMarkdown(page);
  await expect.poll(async () => (await nativeCalls(page, 'cmd_read_text_file')).length).toBeGreaterThan(0);
  await page.evaluate(() => { const state = (window as any).__desktopTest; state.emit('vault-locked', {}); state.releaseText(); });
  await expect(page.getByRole('button', { name: 'Close preview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Late secret', exact: true })).toHaveCount(0);
});

test('protected Markdown passphrases stay in the masked prompt and token flow', async ({ page }) => {
  await desktopFixture(page, { textFilename: 'Fixture notes.md', textContent: '# Passphrase secret', protectedText: true, vaultState: 'unlocked', textRequirePassphrase: 'read' });
  await openMarkdown(page);
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="password"]').fill('synthetic file password');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Passphrase secret', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fixture notes.md', exact: true }).fill('# Passphrase edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.locator('input[type="password"]').fill('synthetic file password');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const calls = await nativeCalls(page, 'cmd_save_text_file');
  expect(calls).toHaveLength(2);
  expect(calls[1].args).toMatchObject({ promptToken: 1234, content: '# Passphrase edit' });
  expect(calls[1].args.passphrase).toBeUndefined();
});
