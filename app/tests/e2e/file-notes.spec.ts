import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

test('video notes icon opens an immediate preview and a keyboard-accessible editor', async ({ page }) => {
  await desktopFixture(page, { video: true });
  await page.goto('/');
  const icon = page.getByRole('button', { name: 'Notes for Holiday folder video.mp4', exact: true });
  await expect(icon).toBeVisible();
  await icon.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await icon.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Video notes', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('textbox')).toBeFocused();
  await editor.getByRole('textbox').fill('First line\nSecond line — 日本語');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await icon.hover();
  await expect(page.getByRole('tooltip')).toContainText('Second line — 日本語');
});

test('saved notes survive reload, failed saves retain drafts, and unsaved changes require confirmation', async ({page}) => {
  await desktopFixture(page, {video: true}); await page.goto('/');
  const icon = page.getByRole('button', {name: 'Notes for Holiday folder video.mp4', exact: true});
  await icon.click(); const dialog = page.getByRole('dialog', {name: 'Video notes', exact: true});
  await dialog.getByRole('textbox').fill('persistent native-boundary fixture note');
  await dialog.getByRole('button', {name: 'Save', exact: true}).click(); await expect(dialog).toHaveCount(0);
  await page.reload(); await icon.click(); await expect(dialog.getByRole('textbox')).toHaveValue('persistent native-boundary fixture note');
  await dialog.getByRole('textbox').fill('unsaved draft');
  await page.evaluate(() => {(window as any).__desktopTest.notesSaveFails = true;});
  await dialog.getByRole('button', {name: 'Save', exact: true}).click(); await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue('unsaved draft');
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.getByRole('button', {name: 'Discard changes', exact: true}).click(); await expect(dialog).toHaveCount(0);
});

test('protected notes and unsaved drafts disappear on locking', async ({page}) => {
  await desktopFixture(page, {video: true, protectedVideo: true, encryptionReady: true, vaultState: 'unlocked'});
  await page.goto('/');
  const icon = page.getByRole('button', {name: 'Notes for Holiday folder video.mp4', exact: true});
  await icon.click(); const dialog = page.getByRole('dialog', {name: 'Video notes', exact: true});
  await dialog.getByRole('textbox').fill('private note'); await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await icon.hover(); await expect(page.getByRole('tooltip')).toContainText('private note');
  await icon.click(); await expect(dialog.getByRole('textbox')).toHaveValue('private note');
  await dialog.getByRole('textbox').fill('private draft');
  await page.evaluate(() => {const state = (window as any).__desktopTest; state.vaultLocked = true; state.emit('vault-locked', {}); state.releaseNotes();});
  await expect(dialog).toHaveCount(0); await expect(page.getByText('private note', {exact: true})).toHaveCount(0);
  expect((await nativeCalls(page, 'cmd_file_notes')).some(call => call.args.token === 'controlled-notes-token')).toBe(true);
});

test('cold hover has no timer or extra fetch, and a held protected response is discarded after lock', async ({page}) => {
  await desktopFixture(page, {video: true, protectedVideo: true, encryptionReady: true, vaultState: 'unlocked', holdNotes: true});
  await page.goto('/');
  const icon = page.getByRole('button', {name: 'Notes for Holiday folder video.mp4', exact: true});
  await expect(icon).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_file_notes')).length).toBe(1);
  // Dispatch pointer enter and inspect in the next animation frame: there is no hover timer.
  const loading = await icon.evaluate(async element => {
    element.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
    await new Promise(requestAnimationFrame);
    return document.querySelector('[role="tooltip"]')?.textContent;
  });
  expect(loading).toContain('Loading');
  expect((await nativeCalls(page, 'cmd_file_notes')).length).toBe(1);
  await page.evaluate(() => {const state = (window as any).__desktopTest; state.vaultLocked = true; state.emit('vault-locked', {}); state.releaseNotes();});
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog', {name: 'Video notes', exact: true})).toHaveCount(0);
});

test('notes backup Settings require a preview and explicit conflict confirmation', async ({page}) => {
  await desktopFixture(page); await page.goto('/'); await openSettings(page);
  await page.getByRole('button', {name: 'Advanced', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Local notes'})).toBeVisible();
  await page.getByRole('button', {name: 'Export notes', exact: true}).click(); await expect(page.getByText('Notes exported.', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Import notes', exact: true}).click(); await expect(page.getByText('1 notes; 1 potential conflicts.', {exact: true})).toBeVisible();
  await page.getByRole('combobox', {name: 'Conflict handling'}).selectOption('replace');
  await page.getByRole('button', {name: 'Confirm import', exact: true}).click();
  await page.getByRole('dialog').filter({hasText: 'Import this backup using'}).getByRole('button', {name: 'Import notes', exact: true}).click();
  await expect(page.getByText('Notes imported.', {exact: true})).toBeVisible();
  expect((await nativeCalls(page, 'cmd_notes_backup')).find(call => call.args.action === 'import')?.args.policy).toBe('replace');
});

test('account changes discard the open editor without autosaving old-account drafts', async ({page}) => {
  await desktopFixture(page, {video: true}); await page.goto('/');
  const icon = page.getByRole('button', {name: 'Notes for Holiday folder video.mp4', exact: true});
  await icon.click();
  const dialog = page.getByRole('dialog', {name: 'Video notes', exact: true});
  await dialog.getByRole('textbox').fill('old account unsaved note');
  await page.evaluate(() => {const state = (window as any).__desktopTest; state.holdNotes = true; state.owner = '202'; document.dispatchEvent(new Event('visibilitychange'));});
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await nativeCalls(page, 'cmd_file_notes')).some(call => call.args.ownerId === '202')).toBe(true);
  await page.evaluate(() => {(window as any).__desktopTest.releaseNotes();});
  await expect(page.getByText('old account unsaved note', {exact: true})).toHaveCount(0);
  expect((await nativeCalls(page, 'cmd_file_notes')).filter(call => call.args.action === 'save')).toHaveLength(0);
});

test('locked protected videos do not disclose note existence or plaintext', async ({ page }) => {
  await desktopFixture(page, { video: true, protectedVideo: true, encryptionReady: true, vaultState: 'locked' });
  await page.goto('/');
  await expect(page.getByText('Holiday folder video.mp4', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Video notes', exact: true })).toHaveCount(0);
});

test('grid and list share multiline plain text, viewport-safe previews, conflicts and explicit deletion', async ({page}, testInfo) => {
  await desktopFixture(page, {video: true}); await page.goto('/');
  await page.getByRole('button', {name: 'Switch to Grid', exact: true}).click();
  const icon = page.getByRole('button', {name: 'Notes for Holiday folder video.mp4', exact: true});
  const dialog = page.getByRole('dialog', {name: 'Video notes', exact: true});
  const text = '<img src=x onerror="window.notesExecuted=true">\n' + 'Long Japanese note 日本語\n'.repeat(40);
  await icon.click(); await dialog.getByRole('textbox').fill(text);
  await page.evaluate(() => {(window as any).__desktopTest.notesConflict = true;});
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog.getByRole('alert')).toContainText('changed');
  await expect(dialog.getByRole('textbox')).toHaveValue(text);
  await page.evaluate(() => {(window as any).__desktopTest.notesConflict = false;});
  await dialog.getByRole('button', {name: 'Save', exact: true}).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', {name: 'Switch to List', exact: true}).click();
  await icon.hover(); const tooltip = page.getByRole('tooltip'); await expect(tooltip).toContainText('<img src=x');
  expect(await page.evaluate(() => (window as any).notesExecuted)).toBeUndefined();
  const bounds = await tooltip.boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({path: testInfo.outputPath('list-notes-preview.png')});
  await icon.click(); await expect(dialog.getByRole('textbox')).toHaveValue(text);
  await dialog.getByRole('button', {name: 'Delete note', exact: true}).click();
  await page.getByRole('dialog').filter({hasText: 'The video will not be changed.'}).getByRole('button', {name: 'Delete note', exact: true}).click();
  await expect(dialog).toHaveCount(0); await icon.hover(); await expect(tooltip).toContainText('No notes yet');
});
