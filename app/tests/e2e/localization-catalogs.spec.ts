import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const appRoot=fileURLToPath(new URL('../..',import.meta.url));
import {desktopFixture,nativeCalls} from './desktop-fixture';

// Serve the actual production artifacts, not Vite's development JSON transform.
// The native application boundary remains controlled by desktopFixture.
test('only English and Spanish catalogs ship and load losslessly through the real application',async ({browser})=>{
  test.setTimeout(240_000);
  execFileSync(process.execPath,[resolve(appRoot,'node_modules/vite/bin/vite.js'),'build'],{cwd:appRoot,timeout:120_000,stdio:'pipe'});
  const dist=resolve(appRoot,'dist');
  const server=createServer(async(request,response)=>{
    try {
      const pathname=decodeURIComponent(new URL(request.url!,'http://localhost').pathname);
      const file=resolve(dist,pathname==='/'?'index.html':'.'+pathname);
      if(!file.startsWith(dist+sep)) {response.writeHead(403).end();return;}
      const body=await readFile(file);
      const extension=file.split('.').at(-1);
      response.setHeader('Content-Type',({html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml'} as Record<string,string>)[extension!]??'application/octet-stream');
      response.end(body);
    } catch {response.writeHead(404).end();}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing production server port');
  const origin=`http://127.0.0.1:${address.port}`;
  const languages=['en','es'];
  try {
    expect((await readdir(resolve(appRoot,'src/i18n/locales'))).filter(file=>file.endsWith('.json')).sort()).toEqual(['en.json','es.json']);
    const catalogs=[];
    for(const file of await readdir(resolve(dist,'assets'))) {
      if(!file.endsWith('.json'))continue;
      const packet=JSON.parse(await readFile(resolve(dist,'assets',file),'utf8'));
      if(packet.format==='td-locale-v2')catalogs.push(packet.language);
    }
    expect(catalogs.sort()).toEqual(languages);
    for(const delayed of [/\/assets\/en-[^/]+\.json$/, /\/assets\/translation-keys-[^/]+\.json$/]) {
      const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(10_000);
      let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});let requested=false;
      try {
        await page.route(delayed,async route=>{requested=true;await gate;await route.continue();});
        await desktopFixture(page,{holdSupporter:true});await page.goto(origin);
        await expect.poll(()=>requested).toBe(true);
        await expect(page.locator('[data-language-bootstrap="loading"]')).toBeVisible();
        expect(await nativeCalls(page,'cmd_get_supporter_status')).toHaveLength(0);
        await expect(page.locator('iframe')).toHaveCount(0);
        release();
        await expect(page.getByText('Holiday folder photo.jpg',{exact:true})).toBeVisible();
        await expect(page.locator('iframe')).toHaveCount(0);
        await page.evaluate(()=>(window as any).__desktopTest.releaseSupporter());
        await expect(page.getByRole('button',{name:'Preferences',exact:true})).toBeVisible();
        await expect(page.locator('[data-language-bootstrap]')).toHaveCount(0);
      } finally {release();await context.close();}
    }
    for(const broken of [/\/assets\/en-[^/]+\.json$/, /\/assets\/translation-keys-[^/]+\.json$/].flatMap(pattern=>[ {pattern,malformed:false}, {pattern,malformed:true} ])) {
      const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(10_000);
      try {
        await page.route(broken.pattern,route=>route.fulfill(broken.malformed?{status:200,contentType:'application/json',body:JSON.stringify({format:'broken-resource'})}:{status:503,body:'Unavailable local resource'}));
        await desktopFixture(page);await page.goto(origin);
        const error=page.locator('[data-language-bootstrap="error"]');await expect(error).toBeVisible();
        await expect(error).not.toContainText('common.');
        expect(await nativeCalls(page,'cmd_get_supporter_status')).toHaveLength(0);
        await page.unroute(broken.pattern);await error.getByRole('button',{name:'Retry',exact:true}).click();
        await expect(page.getByRole('button',{name:'Preferences',exact:true})).toBeVisible();
        await expect(page.locator('iframe')).toHaveCount(0);
      } finally {await context.close();}
    }
    {
      const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(10_000);
      const resource=/\/assets\/en-[^/]+\.json$/;
      let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});let requested=false;
      try {
        await page.route(resource,async route=>{requested=true;await gate;await route.continue().catch(()=>undefined);});
        await desktopFixture(page);await page.goto(origin);await expect.poll(()=>requested).toBe(true);
        const error=page.locator('[data-language-bootstrap="error"]');await expect(error).toBeVisible({timeout:10_000});
        release();await page.waitForLoadState('networkidle');await expect(error).toBeVisible();
        expect(await nativeCalls(page,'cmd_get_supporter_status')).toHaveLength(0);
        await page.unroute(resource);await error.getByRole('button',{name:'Retry',exact:true}).click();
        await expect(page.getByRole('button',{name:'Preferences',exact:true})).toBeVisible();
      } finally {release();await context.close();}
    }
    for(const invalid of [0, [0, 999999, 'suffix'], [-1, 0, 'suffix']]) {
      const context=await browser.newContext();const page=await context.newPage();
      try {
        await page.route(/\/assets\/en-[^/]+\.json$/,async route=>{
          const response=await route.fetch();const packet=await response.json();packet.values[0]=invalid;
          await route.fulfill({response,body:JSON.stringify(packet)});
        });
        await desktopFixture(page);await page.goto(origin);
        await expect(page.locator('[data-language-bootstrap="error"]')).toBeVisible();
        expect(await nativeCalls(page,'cmd_get_supporter_status')).toHaveLength(0);
      } finally {await context.close();}
    }
    for(const language of languages) {
      const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(10_000);
      try {
        const catalog=JSON.parse(await readFile(resolve(appRoot,'src/i18n/locales',language+'.json'),'utf8'));
        const packets:any[]=[];
        page.on('response',response=>{
          if(response.url().endsWith('.json')&&new URL(response.url()).pathname.startsWith('/assets/'))void response.json().then(packet=>packets.push(packet));
        });
        await desktopFixture(page,{settings:{language}});await page.goto(origin);
        await expect(page.locator('html')).toHaveAttribute('lang',language);
        await expect(page.getByRole('button',{name:catalog.common.preferences,exact:true})).toBeVisible();
        await page.getByRole('button',{name:catalog.common.preferences,exact:true}).click();
        await page.getByRole('menu').getByRole('button',{name:catalog.common.preferences,exact:true}).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('dialog').getByRole('button',{name:catalog.settings.tab_encryption,exact:true})).toBeVisible();
        {
           await expect.poll(()=>packets.filter(packet=>packet.format==='td-locale-v2').length).toBe(language==='en'?1:2);
          const keys=packets.find(packet=>packet.format==='td-keys-v1');expect(keys).toBeTruthy();
           const packed=packets.find(packet=>packet.format==='td-locale-v2'&&packet.language===language);expect(packed.id).toBe(keys.id);
          const flat:Record<string,string>={};
          const flatten=(value:Record<string,unknown>,prefix='')=>{for(const [name,entry]of Object.entries(value)){const key=prefix?prefix+'.'+name:name;if(typeof entry==='string')flat[key]=entry;else flatten(entry as Record<string,unknown>,key);}};
          flatten(catalog);
           const values: (string|null)[]=[];
           for(const [index,value] of packed.values.entries()) {
              if(typeof value==='number') {expect(Number.isInteger(value)&&value>=0&&value<index).toBe(true);expect(typeof values[value]).toBe('string');values.push(values[value]);}
              else if(Array.isArray(value)) {const [reference,prefix,suffix]=value;expect(reference>=0&&reference<index&&prefix>=0&&prefix<=values[reference]!.length).toBe(true);values.push(values[reference]!.slice(0,prefix)+suffix);}
             else values.push(value);
           }
           const unpacked=Object.fromEntries(keys.keys.flatMap((key:string,index:number)=>values[index]===null?[]:[[key,values[index]]]));
          expect(unpacked).toEqual(flat);
        }
      } finally {await context.close();}
    }
    const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(10_000);
    try {
      const spanish=JSON.parse(await readFile(resolve(appRoot,'src/i18n/locales/es.json'),'utf8'));
      const resource=/\/assets\/es-[^/]+\.json$/;
      let delivered=false;
      await page.route(resource,async route=>{
        const response=await route.fetch();const packet=await response.json();delete packet.format;
        await route.fulfill({response,body:JSON.stringify(packet)});delivered=true;
      });
      await desktopFixture(page,{settings:{language:'en'}});await page.goto(origin);
      await page.getByRole('button',{name:'Preferences',exact:true}).click();
      await page.getByRole('menu').getByRole('button',{name:'Preferences',exact:true}).click();
      const choice=page.getByRole('combobox',{name:'Application Language',exact:true});
      await choice.selectOption('es');
      await expect.poll(()=>delivered).toBe(true);await page.waitForLoadState('networkidle');
      // An invalid resource must not publish a partial bundle or hide the usable language.
      await expect(page.getByRole('button',{name:'Preferences',exact:true})).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang','en');
      expect((await nativeCalls(page,'cmd_set_native_language')).some(call=>call.args.language==='es')).toBe(false);
      await page.unroute(resource);
      await choice.selectOption('en');await expect(page.locator('html')).toHaveAttribute('lang','en');
      await choice.selectOption('es');
      await expect(page.getByRole('button',{name:spanish.common.preferences,exact:true})).toBeVisible();
      await expect.poll(async()=>{const calls=await nativeCalls(page,'cmd_set_native_language');return calls.at(-1)?.args.language;}).toBe('es');
    } finally {await context.close();}
  } finally {await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
});
