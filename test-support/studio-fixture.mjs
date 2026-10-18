import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {generateSecret, generateRecoveryCodes} from '../lib/mfa.mjs';

export const origin = 'http://localhost:3000';
const username = 'studio-fixture-admin';
const password = 'Private-studio-fixture-password-2026!';
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6QZkAAAAASUVORK5CYII=', 'base64');
export const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
export const leadFields = {brand:'Fixture Brand', name:'Deniz Örnek', email:'deniz@example.invalid', phone:'', plan:'Tek seferlik proje', brief:'Markamız için kısa bir ürün tanıtım filmi hazırlatmak istiyoruz.', consent:true, website:''};

export async function fixture(t, {mfa=true}={}) {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-studio-test-'));
 const recoveryCodes = generateRecoveryCodes();
 const store = new Store({dataDir});
 try {
  await store.initializeAdmin(username, password);
  if (mfa) assert.equal(store.enableMfa(generateSecret(), {counter:-1, recoveryCodes, expectedVersion:store.getAdminState().authVersion}), true);
 } finally { store.close(); }
 const server = createServer({dataDir, publicOrigin:origin, secureCookies:false, aiConfig:()=>({apiKey:''})});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const base = `http://127.0.0.1:${server.address().port}`;
 const app = {
  dataDir, server, base, recoveryCodes,
  close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),
  request(path,{method='GET',body,raw,cookie,csrf,headers={}}={}) {
   return fetch(base+path, {method, headers:{
    ...(!['GET','HEAD'].includes(method)?{'Origin':origin,'Content-Type':'application/json'}:{}),
    ...(cookie?{'Cookie':cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers,
   },...(raw!==undefined?{body:raw}:body!==undefined?{body:JSON.stringify(body)}:{})});
  },
 };
 t.after(async()=>{if(server.listening)await app.close();await rm(dataDir,{recursive:true,force:true});});
 return app;
}

export async function login(app, code=app.recoveryCodes[0]) {
 const response=await app.request('/api/admin/login',{method:'POST',body:{username,password,code}});
 assert.equal(response.status,200,await response.clone().text());
 const session=await response.json();
 return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:session.csrfToken,session};
}

export async function submit(app, extra={}) {
 const response=await app.request('/api/leads',{method:'POST',body:{...leadFields,...extra}});
 assert.equal(response.status,201,await response.clone().text());
 return (await response.json()).id;
}

export async function project(app,auth,extra={}) {
 const response=await app.request('/api/admin/projects',{method:'POST',...auth,body:{title:'Fixture Project',category:'production',summary:'A real project description supplied by the site owner.',...extra}});
 assert.equal(response.status,201,await response.clone().text());
 return (await response.json()).project;
}

export async function delivery(app,auth,leadId,extra={}) {
 const response=await app.request(`/api/admin/leads/${leadId}/deliveries`,{method:'POST',...auth,body:{title:'Fixture Delivery',description:'Please review the current version.',...extra}});
 assert.equal(response.status,201,await response.clone().text());
 const result=await response.json();
 return {...result,token:result.sharePath.split('#')[1]};
}

export function withStore(app, run) {
 const store=new Store({dataDir:app.dataDir});
 try{return run(store);}finally{store.close();}
}

export async function waitForBodyReader(request) {
 // A data-event observer would itself start flowing the request before the
 // streamed-upload helper has opened its file. Observe readiness without
 // consuming bytes so this models a real slow upload.
 for(let attempt=0;attempt<100;attempt++){
  if(request.listenerCount('readable'))return;
  await delay(5);
 }
 assert.fail('The server did not attach its body reader');
}
