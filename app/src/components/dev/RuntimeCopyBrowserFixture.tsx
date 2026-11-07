import {useEffect,useState} from 'react';
import {ErrorBoundary} from '../shared/ErrorBoundary';
import i18n,{ensureLanguageResource} from '../../i18n';
import {getLanguageInfo} from '../../i18n/languages';

function Failure({failed}:{failed:boolean}) {if(failed)throw new Error('Controlled browser render failure');return <p>Healthy content</p>;}

/** Real crash recovery presentation; the browser controls rendering and language only. */
export function RuntimeCopyBrowserFixture(){
 const [language,setLanguage]=useState(new URLSearchParams(location.search).get('locale')??'es');
 const [ready,setReady]=useState(false),[failed,setFailed]=useState(false);
 useEffect(()=>{let live=true;void ensureLanguageResource(language).then(()=>i18n.changeLanguage(language)).then(()=>{
  if(!live)return;document.documentElement.lang=language;document.documentElement.dir=getLanguageInfo(language).dir;setReady(true);
 });return()=>{live=false;};},[language]);
 if(!ready)return null;
 return <main data-runtime-language={language} className="min-h-screen bg-app-canvas p-4 pt-24 text-app-text">
  <label>Fixture language<select value={language} onChange={event=>setLanguage(event.target.value)}><option value="es">Español</option><option value="en">English</option></select></label>
  <button onClick={()=>setFailed(true)}>Fail rendering</button>
  <ErrorBoundary><Failure failed={failed}/></ErrorBoundary>
 </main>;
}
