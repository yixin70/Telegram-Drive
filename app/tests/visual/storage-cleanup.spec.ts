import { expect, test, type Page } from '@playwright/test';

const MIB = 1024 * 1024;
const duplicateName = 'Coastal expedition field notes and maps — final reviewed copy.pdf';

async function mount(page: Page, mode: 'storage' | 'cleanup') {
    await page.addInitScript(({ duplicateName, MIB }) => {
        const file = (key: string, name: string, folderName: string, size = 156 * MIB) => ({
            id: Number(key.split(':')[1]), key, name, folder_id: key.startsWith('saved:') ? null : Number(key.split(':')[0]),
            folderName, size, mime_type: 'application/pdf', created_at: '2024-01-03T12:00:00Z', tags: [], collectionIds: [],
        });
        const files = [file('saved:42', duplicateName, 'Saved Messages'), file('9:42', duplicateName, 'Travel and field research'),
            file('9:43', 'Harbour time-lapse.mp4', 'Travel and field research', 2048 * MIB), file('saved:44', 'Previous annual backup.zip', 'Saved Messages', 64 * MIB)];
        const removal = (id: string, name: string, status: string, error: string | null = null) => ({
            id, key: `saved:${id}`, file: file(`saved:${id}`, name, 'Saved Messages', 8 * MIB), status, error,
            requestedAt: 1_783_632_600_000, deleteAfter: 1_786_224_600_000,
        });
        const fixture = {
            files, calls: [] as { command: string; args: any }[], nextClearError: '', nextRestoreError: '',
            snapshot: { ownerId: '11', freeBytes: 8192 * MIB as number | null, limits: { previews: 1024 * MIB, thumbnails: 128 * MIB, converted: 2048 * MIB },
                categories: [
                    { id: 'kept', bytes: 2048 * MIB, reclaimableBytes: 0, fileCount: 12 },
                    { id: 'previews', bytes: 768 * MIB, reclaimableBytes: 512 * MIB, fileCount: 8 },
                    { id: 'thumbnails', bytes: 64 * MIB, reclaimableBytes: 64 * MIB, fileCount: 120 },
                    { id: 'nativePreviews', bytes: 128 * MIB, reclaimableBytes: 128 * MIB, fileCount: 4 },
                    { id: 'converted', bytes: 1536 * MIB, reclaimableBytes: 1536 * MIB, fileCount: 3 },
                    { id: 'downloads', bytes: 3072 * MIB, reclaimableBytes: 0, fileCount: 5, measured: true },
                    { id: 'staging', bytes: 96 * MIB, reclaimableBytes: 0, fileCount: 2 },
                ] },
            removals: [removal('501', 'Prior notes.pdf', 'pending'), removal('502', 'Old video.mp4', 'deleting'),
                removal('503', 'Old archive.zip', 'deleted'), removal('504', 'Changed workbook.xlsx', 'failed', 'FILE_CHANGED')],
        };
        Object.assign(window, {
            __storageCleanupTest: fixture,
            __TAURI_OS_PLUGIN_INTERNALS__: { os_type: 'linux', platform: 'linux', arch: 'x86_64', version: '1', family: 'unix' },
            __TAURI_INTERNALS__: {
                metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, convertFileSrc: (path: string) => path,
                invoke: async (command: string, args: any = {}) => {
                    fixture.calls.push({ command, args });
                    if (command === 'cmd_workspace_asset' || command === 'cmd_workspace_cancel_asset') return null;
                    if (command === 'cmd_storage_read') return structuredClone(fixture.snapshot);
                    if (command === 'cmd_storage_limits') { fixture.snapshot.limits = args.limits; return; }
                    if (command === 'cmd_storage_clear') {
                        if (fixture.nextClearError) { const error = fixture.nextClearError; fixture.nextClearError = ''; throw new Error(error); }
                        const category = fixture.snapshot.categories.find(item => item.id === args.category)!;
                        category.bytes -= category.reclaimableBytes; category.reclaimableBytes = 0;
                        return;
                    }
                    if (command === 'cmd_cleanup_list') return structuredClone(fixture.removals);
                    if (command === 'cmd_cleanup_restore') {
                        if (fixture.nextRestoreError) { const error = fixture.nextRestoreError; fixture.nextRestoreError = ''; throw new Error(error); }
                        const item = fixture.removals.find(value => value.key === args.key)!;
                        item.status = 'restored'; item.error = null;
                        return structuredClone(item);
                    }
                    throw new Error(`Unexpected native command: ${command}`);
                },
            },
        });
    }, { duplicateName, MIB });
    await page.route('**/__storage_cleanup_browser**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="storage-cleanup-browser-fixture"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/components/dev/StorageCleanupBrowserFixture.tsx"></script></body></html>' }));
    await page.goto(`/__storage_cleanup_browser?mode=${mode}`);
}

const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__storageCleanupTest.calls.filter((call: any) => call.command === command), command);
async function noHorizontalOverflow(page: Page, width: number) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const dimensions = await page.getByTestId('panel-scroll').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
}

for (const width of [390, 1280]) {
    test(`Storage ${width}px preserves kept files, confirms exact cache, saves limits and reports busy work`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await mount(page, 'storage');
        await expect(page.getByRole('heading', { name: 'Device storage', exact: true })).toBeVisible();
        const category = (name: string) => page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
        await expect(category('Kept offline files').getByRole('button')).toHaveCount(0);
        await expect(category('Downloaded files').getByRole('button')).toHaveCount(0);
        await expect(category('Temporary staging').getByRole('button', { name: 'No disposable files' })).toBeDisabled();
        await noHorizontalOverflow(page, width);
        await page.screenshot({ path: testInfo.outputPath(`storage-initial-${width}.png`) });
        await category('Image and PDF previews').getByRole('button').click();
        const dialog = page.getByRole('alertdialog');
        await expect(dialog).toContainText('Clear Image and PDF previews?');
        expect(await calls(page, 'cmd_storage_clear')).toHaveLength(0);
        await page.screenshot({ path: testInfo.outputPath(`storage-clear-prompt-${width}.png`) });
        await expect(dialog, 'Clear confirmation must come into view after selecting a category').toBeInViewport();
        await expect(dialog).toBeFocused();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(await calls(page, 'cmd_storage_clear')).toHaveLength(0);
        await category('Image and PDF previews').getByRole('button').click();
        await dialog.getByRole('button', { name: 'Clear cache', exact: true }).click();
        await expect(page.getByRole('status')).toHaveText('Cache cleared. Storage sizes have been refreshed.');
        expect(await calls(page, 'cmd_storage_clear')).toEqual([{ command: 'cmd_storage_clear', args: { ownerId: '11', category: 'previews' } }]);
        await expect(category('Image and PDF previews')).toContainText('256 MB');
        await expect(category('Kept offline files')).toContainText('2 GB');
        await expect(page.getByRole('status'), 'Cache success should be visible after the confirmation closes').toBeInViewport();
        await expect(page.getByRole('status')).toBeFocused();
        const previewLimit = page.getByRole('slider', { name: /Image and PDF previews/ });
        await previewLimit.focus(); await previewLimit.press('Home'); await previewLimit.press('ArrowRight'); await previewLimit.press('ArrowRight');
        await page.getByRole('button', { name: 'Save limits', exact: true }).click();
        await expect(page.getByRole('status')).toHaveText('Cache limits saved.');
        expect(await calls(page, 'cmd_storage_limits')).toEqual([{ command: 'cmd_storage_limits', args: { ownerId: '11', limits: { previews: 768 * MIB, thumbnails: 128 * MIB, converted: 2048 * MIB } } }]);
        await page.evaluate(() => { (window as any).__storageCleanupTest.nextClearError = 'CACHE_BUSY'; });
        await category('Converted video').getByRole('button').click();
        await dialog.getByRole('button', { name: 'Clear cache', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText('Active conversions must finish before their cache can be cleared.');
        await expect(category('Converted video')).toContainText('1.5 GB');
        await page.screenshot({ path: testInfo.outputPath(`storage-busy-${width}.png`) });
        await expect(page.getByRole('alert'), 'Busy feedback must be visible beside the pending confirmation').toBeInViewport();
        await expect(page.getByRole('alert')).toBeFocused();
        await noHorizontalOverflow(page, width);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.evaluate(() => {
            const snapshot = (window as any).__storageCleanupTest.snapshot; snapshot.freeBytes = null;
            snapshot.categories.find((item: any) => item.id === 'downloads').measured = false;
        });
        await page.getByRole('button', { name: 'Refresh sizes', exact: true }).click();
        await expect(page.getByText('Available device space could not be read.')).toBeVisible();
        await expect(category('Downloaded files')).toContainText('Not measured on this device');
    });

    test(`Cleanup ${width}px removes file analysis views but preserves exact-original recovery`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await mount(page, 'cleanup');
        await expect(page.getByRole('heading', { name: 'Recently removed', exact: true })).toBeVisible();
        for (const name of ['Possible duplicates', 'Large files', 'Older than a year', 'Review removal', 'Schedule removal']) {
            await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
        }
        await expect(page.getByRole('checkbox')).toHaveCount(0);
        await expect(page.getByText(duplicateName, { exact: true })).toHaveCount(0);
        await noHorizontalOverflow(page, width);
        await page.screenshot({ path: testInfo.outputPath(`cleanup-recovery-${width}.png`) });
        const recovery = (name: string) => page.locator('article').filter({ has: page.getByText(name, { exact: true }) });
        await expect(recovery('Old video.mp4').getByRole('button', { name: 'Restore to workspace' })).toHaveCount(0);
        await expect(recovery('Old archive.zip').getByRole('button', { name: 'Restore to workspace' })).toHaveCount(0);
        await recovery('Prior notes.pdf').getByRole('button', { name: 'Restore to workspace' }).click();
        await expect(recovery('Prior notes.pdf')).toContainText('Restored');
        expect(await calls(page, 'cmd_cleanup_restore')).toEqual([{ command: 'cmd_cleanup_restore', args: { ownerId: '11', key: 'saved:501' } }]);
        await page.evaluate(() => { (window as any).__storageCleanupTest.nextRestoreError = 'OFFLINE'; });
        await recovery('Changed workbook.xlsx').getByRole('button', { name: 'Restore to workspace' }).click();
        await expect(page.getByRole('alert')).toHaveText('The cleanup operation could not finish. Unverified originals are preserved.');
        await expect(recovery('Changed workbook.xlsx')).toContainText('Needs review; original preserved');
        await page.screenshot({ path: testInfo.outputPath(`cleanup-restore-error-${width}.png`) });
        await expect(page.getByRole('alert'), 'Restore failure must be visible from the recovery action').toBeInViewport();
        await expect(page.getByRole('alert')).toBeFocused();
        expect(await calls(page, 'cmd_cleanup_process')).toHaveLength(0);
        expect(await calls(page, 'cmd_cleanup_schedule')).toHaveLength(0);
        await noHorizontalOverflow(page, width);
    });
}
