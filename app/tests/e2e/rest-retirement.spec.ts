import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {desktopFixture,nativeCalls,openSettings} from './desktop-fixture';

// The REST API surface was retired. These journeys assert the browser-visible
// removal: a legacy `restPermissionExplained` flag must not resurrect a REST
// entry or invoke the retired IPC commands (cmd_get_api_settings,
// cmd_update_api_settings, cmd_regenerate_api_key), while WebDAV, Telegram
// links and local-password links keep working. A native/server-absence check is
// an isolated real-launch acceptance boundary and is not faked here.
const RETIRED=['cmd_get_api_settings','cmd_update_api_settings','cmd_regenerate_api_key'];

async function retiredCalls(page:Page) {
  return page.evaluate(names=>((window as any).__desktopTest.calls as {command:string}[]).filter(call=>names.includes(call.command)).map(call=>call.command),RETIRED);
}

test('legacy REST flag leaves no Settings entry and no retired IPC calls through a persisted preference change, polling and reload',async ({page})=>{
  test.setTimeout(90_000);
  const storeRecord=()=>page.evaluate(()=>(window as any).__desktopTest.stores['settings.json'] as {settings:Record<string,unknown>;legacy_setting_probe?:string});
  const persisted=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-e2e-stores')??'null')?.['settings.json'] as {settings:Record<string,unknown>;legacy_setting_probe?:string}|null);
  await desktopFixture(page,{networkEnabled:true,settings:{restPermissionExplained:true,language:'en',viewMode:'grid'}});
  await page.goto('/');
  // Initial UI hydrates the seeded grid preference, so the toggle offers the other mode.
  await expect(page.getByRole('button',{name:'Switch to List',exact:true})).toBeVisible();
  expect(await retiredCalls(page)).toEqual([]);
  expect((await storeRecord()).settings).toMatchObject({viewMode:'grid',language:'en',restPermissionExplained:true});
  expect((await storeRecord()).legacy_setting_probe).toBe('preserve-existing-value');

  // Change a non-REST preference through the real desktop control.
  await page.getByRole('button',{name:'Switch to List',exact:true}).click();
  await expect(page.getByRole('button',{name:'Switch to Grid',exact:true})).toBeVisible();
  await expect.poll(async()=>(await storeRecord()).settings.viewMode).toBe('list');
  await expect.poll(async()=>(await persisted())?.settings?.viewMode).toBe('list');
  expect((await persisted())!.settings).toMatchObject({viewMode:'list',language:'en',restPermissionExplained:true});
  expect((await persisted())!.legacy_setting_probe).toBe('preserve-existing-value');
  expect(await retiredCalls(page)).toEqual([]);

  // Settings/Advanced/WebDAV positive controls with no retired REST entry or command.
  await openSettings(page);
  let dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Advanced',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'REST API',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:/^WebDAV/}).click();
  await expect(dialog.getByRole('switch',{name:'Enable WebDAV server',exact:true})).toBeVisible();
  await expect(dialog.getByRole('switch',{name:'Allow file changes',exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Understand WebDAV permissions',exact:true})).toBeVisible();
  expect(await retiredCalls(page)).toEqual([]);
  // Wait past the retired 3-second Advanced poll. Only WebDAV state may refresh.
  await page.waitForTimeout(3_500);
  expect(await retiredCalls(page)).toEqual([]);
  expect((await nativeCalls(page,'cmd_get_webdav_settings')).length).toBeGreaterThan(1);
  expect(await nativeCalls(page,'cmd_update_webdav_settings')).toHaveLength(0);
  await dialog.getByRole('button',{name:'Done',exact:true}).click();await expect(dialog).toHaveCount(0);

  // Reload with the same fixture: the store record comes from localStorage before the
  // initial options, so the UI hydrates the saved list preference (not the seeded grid),
  // the unknown legacy flag is preserved, and the retired REST surface stays gone.
  await page.reload();
  await expect(page.getByRole('button',{name:'Switch to Grid',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Switch to List',exact:true})).toHaveCount(0);
  expect((await storeRecord()).settings).toMatchObject({viewMode:'list',language:'en',restPermissionExplained:true});
  expect((await persisted())!.settings).toMatchObject({viewMode:'list',language:'en',restPermissionExplained:true});
  expect((await persisted())!.legacy_setting_probe).toBe('preserve-existing-value');
  expect(await retiredCalls(page)).toEqual([]);
  await openSettings(page);dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Advanced',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'REST API',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:/^WebDAV/}).click();
  await expect(dialog.getByRole('switch',{name:'Enable WebDAV server',exact:true})).toBeVisible();
  expect(await retiredCalls(page)).toEqual([]);
});

test('a legacy REST preference does not localize or resurrect a REST entry in Spanish',async ({page})=>{
  const es=JSON.parse(await readFile(new URL('../../src/i18n/locales/es.json',import.meta.url),'utf8'));
  await desktopFixture(page,{networkEnabled:true,settings:{restPermissionExplained:true,language:'es'}});
  await page.goto('/?a11y-fixture=settings');
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:es.settings.tab_advanced,exact:true}).click();
  await expect(dialog.getByRole('button',{name:'REST API',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:/^WebDAV/}).click();
  const opener=dialog.getByRole('button',{name:es.access_copy.webdav_open,exact:true});await opener.click();
  const explanation=page.getByRole('dialog',{name:es.access_copy.webdav_title,exact:true});await expect(explanation).toBeVisible();
  await expect(explanation).toContainText(es.access_copy.webdav_token);
  await page.keyboard.press('Escape');await expect(explanation).toHaveCount(0);await expect(opener).toBeFocused();
  expect(await retiredCalls(page)).toEqual([]);
});

test('sharing power path stays WebDAV-only while Telegram and local-password modes remain',async ({page})=>{
  await desktopFixture(page,{networkEnabled:true,settings:{restPermissionExplained:true,language:'en'}});
  await page.goto('/');
  await page.getByRole('group',{name:'Photos',exact:true}).click();
  const row=page.getByRole('group',{name:'Holiday folder photo.jpg',exact:true});await expect(row).toBeVisible();
  await row.click({button:'right'});await page.getByRole('button',{name:'Share Link',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:/Share Link/});await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:/^Telegram link/})).toBeVisible();
  await expect(dialog.getByRole('button',{name:/^Local password link/})).toBeVisible();
  await dialog.getByRole('button',{name:/^WebDAV/}).click();
  await expect(dialog).toContainText('Power-user connections');
  await expect(dialog).toContainText('/dav/<token>/');
  await expect(dialog.getByText('REST API',{exact:true})).toHaveCount(0);
  await expect.poll(async()=>(await nativeCalls(page,'cmd_get_webdav_settings')).length).toBeGreaterThan(0);
  expect(await retiredCalls(page)).toEqual([]);
  // Telegram and local-password modes remain reachable.
  await dialog.getByRole('button',{name:'Back to sharing options',exact:true}).click();
  await dialog.getByRole('button',{name:/^Local password link/}).click();
  await expect(dialog.getByLabel('Password',{exact:true})).toBeVisible();
  expect(await retiredCalls(page)).toEqual([]);
});
