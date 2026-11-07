import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

const storeChoice = 'Store Upload normally for maximum compatibility and easy sharing.';

for (const mode of ['vault', 'passphrase', 'vault_and_passphrase'] as const) test(`New File uses the shared ${mode} protection flow`, async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'unlocked', settings: { encryptionDefaultMode: mode, encryptionProtectMetadata: true } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'New File', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Full filename', exact: true }).fill('protected.txt');
  await page.getByRole('textbox', { name: 'Initial text', exact: true }).fill('exact protected content');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: /^Store & protect/ }).click();
  if (mode !== 'vault') {
    await page.getByRole('dialog', { name: 'Keep your encryption credentials safe', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 5000 });
    const secret = page.getByRole('dialog', { name: 'Encrypted with File Passphrase', exact: true });
    await secret.getByLabel('Encrypted with File Passphrase', { exact: true }).fill('synthetic browser passphrase');
    await secret.getByLabel('Confirm passphrase', { exact: true }).fill('synthetic browser passphrase');
    await secret.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
  await expect(page.getByRole('dialog', { name: 'New File', exact: true })).toHaveCount(0);
  const [call] = await nativeCalls(page, 'cmd_create_file');
  expect(call.args.request).toMatchObject({ protectionMode: mode, protectMetadata: true, content: 'exact protected content' });
  expect(call.args.request.promptToken).toBe(mode === 'vault' ? undefined : 1234);
});

// Actual desktop components/providers, controlled IPC only (not live Telegram).
test('New File requires content and preserves the full filename and exact text', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'New File', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Full filename', exact: true });
  const content = dialog.getByRole('textbox', { name: 'Initial text', exact: true });
  const create = dialog.getByRole('button', { name: 'Create', exact: true });
  await expect(name).toBeFocused();
  await name.fill('README.MD');
  await expect(create).toBeDisabled();
  expect(await nativeCalls(page, 'cmd_create_file')).toHaveLength(0);
  await content.fill('  日本語');
  await content.press('Enter');
  await content.press('End');
  await content.press('ControlOrMeta+Enter');
  await page.getByRole('button', { name: 'Store Upload normally for maximum compatibility and easy sharing.', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const [call] = await nativeCalls(page, 'cmd_create_file');
  expect(call.args.request).toMatchObject({ filename: 'README.MD', content: '  日本語\n', folderId: null, ownerId: '101', protectionMode: 'standard' });
  expect(call.args.request.id).toMatch(/^[0-9a-f-]{36}$/);
  // Admission is not publication; no permanent fake row.
  await expect(page.getByRole('group', { name: 'README.MD', exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Transfer activity' }).getByText('README.MD', { exact: true })).toBeVisible();
});

test('filename validation, protection cancellation and Escape leave no creation', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  const opener = page.getByRole('button', { name: 'New File', exact: true }).first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Full filename', exact: true });
  await dialog.getByRole('textbox', { name: 'Initial text', exact: true }).fill(' ');
  for (const invalid of ['../escape.txt', 'CON.txt', 'bad.', 'bad ', '　', 'a'.repeat(121)]) {
    await name.fill(invalid);
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  }
  await name.fill('.gitignore');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await nativeCalls(page, 'cmd_create_file')).toHaveLength(0);
});

test('a pending protection choice cannot publish an old account draft', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New File', exact: true }).first()).toBeDisabled();
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'New File', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await dialog.getByRole('textbox', { name: 'Full filename', exact: true }).fill('private.txt');
  await dialog.getByRole('textbox', { name: 'Initial text', exact: true }).fill('old account draft');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Initial text', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).__desktopTest.owner = '202'; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('textbox', { name: 'Initial text', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Store Upload normally for maximum compatibility and easy sharing.', exact: true }).click();
  expect(await nativeCalls(page, 'cmd_create_file')).toHaveLength(0);
  await page.getByRole('button', { name: 'New File', exact: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Initial text', exact: true })).toHaveValue('');
});

for (const lostReply of [true, 'transport'] as const) test(`uncertain admission (${lostReply}) checks the unchanged request without a second job or protection prompt`, async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.evaluate(lost => { (window as any).__desktopTest.creationReplyLost = lost; }, lostReply);
  await page.getByRole('button', { name: 'New File', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New File', exact: true });
  await dialog.getByRole('textbox', { name: 'Full filename', exact: true }).fill('notes.txt');
  await dialog.getByRole('textbox', { name: 'Initial text', exact: true }).fill('keep exact draft');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: storeChoice, exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Initial text', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Check original request', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const calls = await nativeCalls(page, 'cmd_create_file');
  expect(calls).toHaveLength(2);
  expect(calls[1].args).toEqual(calls[0].args);
  expect(await page.evaluate(() => (window as any).__desktopTest.jobs.length)).toBe(1);
});

test('an empty real folder accepts custom names; publication refreshes and opens the actual text', async ({ page }) => {
  await desktopFixture(page, { emptyFolder: true });
  await page.goto('/');
  await page.getByRole('group', { name: 'Photos', exact: true }).click();
  await expect(page.getByText('This folder is empty', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New File', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Full filename', exact: true }).fill('notes.txt');
  await page.getByRole('textbox', { name: 'Initial text', exact: true }).fill('published text 日本語');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: storeChoice, exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_create_file')).length).toBe(1);
  const [call] = await nativeCalls(page, 'cmd_create_file');
  expect(call.args.request.folderId).toBe(9);
  await expect(page.getByRole('group', { name: 'notes.txt', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    const job = state.jobs[0];
    state.textContent = 'published text 日本語';
    // The new item is beyond the initial virtual list viewport.
    for (let index = 0; index < 100; index++) state.publishedCreations.push({ id: 1000 + index, name: `old-${index}.txt`, folderId: 9, ownerId: '101' });
    state.publishedCreations.push({ id: 881, name: 'notes.txt', folderId: 9, ownerId: '101' });
    Object.assign(job, { status: 'completed', messageId: 881, revision: 2, progress: 100 });
    state.emit('transfer-upserted', { ...job });
  });
  await expect(page.getByRole('group', { name: 'notes.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Grid', exact: true }).click();
  await page.getByRole('group', { name: 'notes.txt', exact: true }).hover();
  await page.getByRole('button', { name: 'Preview notes.txt', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'notes.txt', exact: true })).toHaveValue('published text 日本語');
});

test('UTF-8 byte bounds, custom extensions and delayed admission keep the draft locked', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  for (const filename of ['draft.word', 'report.docx', '日本語.txt', '.gitignore', 'LICENSE']) {
    await page.getByRole('button', { name: 'New File', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Full filename', exact: true }).fill(filename);
    const content = page.getByRole('textbox', { name: 'Initial text', exact: true });
    if (filename === 'draft.word') {
      await content.fill('é'.repeat(524288) + 'x');
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
      await content.fill('é'.repeat(524288));
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    }
    await content.fill(' ');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: storeChoice, exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New File', exact: true })).toHaveCount(0);
  }
  const calls = await nativeCalls(page, 'cmd_create_file');
  expect(calls.map(call => call.args.request.filename)).toEqual(['draft.word', 'report.docx', '日本語.txt', '.gitignore', 'LICENSE']);
  expect(calls.every(call => call.args.request.content === ' ')).toBe(true);
  await page.evaluate(() => { (window as any).__desktopTest.holdCreation = true; });
  await page.getByRole('button', { name: 'New File', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Full filename', exact: true }).fill('delayed.txt');
  await page.getByRole('textbox', { name: 'Initial text', exact: true }).fill('delayed');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: storeChoice, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Initial text', exact: true })).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'New File', exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'cmd_create_file')).toHaveLength(6);
  await page.evaluate(() => { (window as any).__desktopTest.releaseCreation(); });
  await expect(page.getByRole('dialog', { name: 'New File', exact: true })).toHaveCount(0);
});
