import assert from 'node:assert/strict';
import {createServer} from '../server.mjs';
import {totpCode} from '../lib/mfa.mjs';
import {origin} from './studio-fixture.mjs';

export const ownerUsername='studio-fixture-admin';
export const ownerPassword='Private-studio-fixture-password-2026!';
export const partnerFields={username:'fixture-partner',displayName:'Fixture Partner',password:'Temporary-partner-password-2026!'};
export const partnerPassword='Independent-partner-password-2026!';

export function authFrom(response,data){return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:data.csrfToken,session:data};}
export async function userLogin(app,{username,password,code}){
 const response=await app.request('/api/admin/login',{method:'POST',body:{username,password,...(code?{code}:{})}});
 assert.equal(response.status,200,await response.clone().text());
 return authFrom(response,await response.json());
}
export async function createPartner(app,owner,extra={}){
 const response=await app.request('/api/admin/users',{method:'POST',...owner,body:{...partnerFields,...extra}});
 assert.equal(response.status,201,await response.clone().text());return (await response.json()).user;
}
export async function enrollPartner(app,owner,extra={}){
 const fields={...partnerFields,...extra},user=await createPartner(app,owner,extra);
 let auth=await userLogin(app,fields);
 const changed=await app.request('/api/admin/password',{method:'POST',...auth,body:{currentPassword:fields.password,newPassword:partnerPassword}});
 assert.equal(changed.status,200,await changed.clone().text());auth=authFrom(changed,await changed.json());
 const setup=await app.request('/api/admin/mfa/setup',{method:'POST',...auth,body:{password:partnerPassword}});
 assert.equal(setup.status,200,await setup.clone().text());const {secret}=await setup.json();
 const enabled=await app.request('/api/admin/mfa/enable',{method:'POST',...auth,body:{code:totpCode(secret)}});
 assert.equal(enabled.status,200,await enabled.clone().text());const result=await enabled.json();
 return {user,auth:authFrom(enabled,result),secret,recoveryCodes:result.recoveryCodes,username:fields.username,password:partnerPassword};
}
export async function restarted(app,t){
 await app.close();
 const server=createServer({dataDir:app.dataDir,publicOrigin:origin,secureCookies:false,aiConfig:()=>({apiKey:''})});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 const base=`http://127.0.0.1:${server.address().port}`;
 return {dataDir:app.dataDir,request(path,{method='GET',body,raw,cookie,csrf,headers={}}={}){
  return fetch(base+path,{method,headers:{...(!['GET','HEAD'].includes(method)?{Origin:origin,'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers},...(raw!==undefined?{body:raw}:body!==undefined?{body:JSON.stringify(body)}:{})});
 }};
}
