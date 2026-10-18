import {test} from 'node:test';
import assert from 'node:assert/strict';
import {totpCode} from '../lib/mfa.mjs';
import {fixture,login,submit,withStore} from '../test-support/studio-fixture.mjs';
import {authFrom,createPartner,enrollPartner,userLogin,partnerFields,partnerPassword,ownerUsername,ownerPassword,restarted} from '../test-support/expansion-fixture.mjs';

test('partner onboarding changes only its own password and requires an independently enrolled authenticator',async t=>{
 const app=await fixture(t),owner=await login(app),before=withStore(app,store=>store.getAdminState()),user=await createPartner(app,owner);
 assert.equal(user.role,'partner');assert.equal(user.mustChangePassword,true);assert.equal(user.mfaEnabled,false);
 let partner=await userLogin(app,partnerFields);
 assert.equal(partner.session.userId,user.id);assert.equal(partner.session.role,'partner');assert.equal(partner.session.mustChangePassword,true);
 for(const path of ['/api/admin/leads','/api/admin/projects','/api/admin/team'])assert.equal((await app.request(path,partner)).status,403,path);
 let response=await app.request('/api/admin/mfa/setup',{method:'POST',...partner,body:{password:partnerFields.password}});
 assert.equal(response.status,403);assert.equal((await response.json()).code,'PASSWORD_CHANGE_REQUIRED');
 response=await app.request('/api/admin/password',{method:'POST',...partner,body:{currentPassword:partnerFields.password,newPassword:partnerPassword}});
 assert.equal(response.status,200,await response.clone().text());const old=partner;partner=authFrom(response,await response.json());
 assert.equal(partner.session.mustChangePassword,false);assert.equal(partner.session.mfaRequired,true);
 assert.equal((await app.request('/api/admin/session',old)).status,401,'temporary-password cookies are revoked');
 assert.equal((await app.request('/api/admin/leads',partner)).status,403,'a permanent password alone does not bypass MFA');
 response=await app.request('/api/admin/mfa/setup',{method:'POST',...partner,body:{password:partnerPassword}});
 assert.equal(response.status,200);const setup=await response.json();assert.match(setup.secret,/^[A-Z2-7]{32}$/);
 response=await app.request('/api/admin/mfa/enable',{method:'POST',...partner,body:{code:totpCode(setup.secret)}});
 assert.equal(response.status,200,await response.clone().text());const enabled=await response.json();partner=authFrom(response,enabled);
 assert.equal(enabled.recoveryCodes.length,10);assert.equal((await app.request('/api/admin/leads',partner)).status,200);
 assert.equal((await app.request('/api/admin/leads',owner)).status,200,'a partner enrollment leaves the owner cookie valid');
 assert.deepEqual(withStore(app,store=>store.getAdminState()),before,'owner MFA state, version and recovery codes stay unchanged');
 const security=await app.request('/api/admin/security',partner),securityText=await security.text();
 assert.doesNotMatch(securityText,/password_hash|mfa_secret|otpauth/);assert.ok(!securityText.includes(setup.secret));
 for(const code of enabled.recoveryCodes)assert.ok(!securityText.includes(code));
 const foreignFactor=await app.request('/api/admin/login',{method:'POST',body:{username:partnerFields.username,password:partnerPassword,code:app.recoveryCodes[1]}});
 assert.equal(foreignFactor.status,401,'owner recovery codes never authenticate another account');
 await userLogin(app,{username:ownerUsername,password:ownerPassword,code:app.recoveryCodes[1]});
});

test('partners cannot manage identities, automation, or redacted exports, and cannot elevate their own role',async t=>{
 const app=await fixture(t),owner=await login(app),partner=await enrollPartner(app,owner);
 await submit(app);
 for(const path of ['/api/admin/users','/api/admin/automation','/api/admin/assistant-export']){
  const response=await app.request(path,partner.auth);assert.equal(response.status,403,path);assert.equal((await response.json()).code,'OWNER_REQUIRED');
 }
 for(const [path,body,method] of [['/api/admin/users',{...partnerFields,username:'unauthorized-new'},'POST'],[`/api/admin/users/${partner.user.id}`,{disabled:false,role:'owner'},'PATCH'],['/api/admin/users/owner',{disabled:true},'PATCH'],['/api/admin/automation',{enabled:true},'POST']])assert.equal((await app.request(path,{method,...partner.auth,body})).status,403,path);
 const team=await (await app.request('/api/admin/team',partner.auth)).json();
 assert.ok(team.users.some(user=>user.id===partner.user.id));
 for(const user of team.users)assert.deepEqual(Object.keys(user).sort(),['id','username','displayName','role','disabled'].sort());
 const ownerEdit=await app.request('/api/admin/users/owner',{method:'PATCH',...owner,body:{disabled:true}});assert.equal(ownerEdit.status,400);
 assert.equal((await app.request('/api/admin/leads',owner)).status,200);
 const elevate=await app.request(`/api/admin/users/${partner.user.id}`,{method:'PATCH',...owner,body:{role:'owner'}});assert.equal(elevate.status,400);
});

test('disabling or resetting a partner revokes its sessions without changing the owner and retains its own MFA',async t=>{
 const app=await fixture(t),owner=await login(app),partner=await enrollPartner(app,owner);
 const other=await userLogin(app,{...partner,code:partner.recoveryCodes[0]});
 let response=await app.request(`/api/admin/users/${partner.user.id}`,{method:'PATCH',...owner,body:{disabled:true}});assert.equal(response.status,200);
 for(const auth of [partner.auth,other])assert.equal((await app.request('/api/admin/session',auth)).status,401);
 assert.equal((await app.request('/api/admin/leads',owner)).status,200);
 response=await app.request('/api/admin/login',{method:'POST',body:{username:partner.username,password:partner.password,code:partner.recoveryCodes[1]}});assert.equal(response.status,401);
 response=await app.request(`/api/admin/users/${partner.user.id}`,{method:'PATCH',...owner,body:{disabled:false}});assert.equal(response.status,200);
 await userLogin(app,{...partner,code:partner.recoveryCodes[1]});
 const resetPassword='New-temporary-partner-password-2026!';
 response=await app.request(`/api/admin/users/${partner.user.id}`,{method:'PATCH',...owner,body:{resetPassword}});assert.equal(response.status,200);
 assert.equal((await app.request('/api/admin/session',other)).status,401);
 response=await app.request('/api/admin/login',{method:'POST',body:{username:partner.username,password:resetPassword}});assert.equal(response.status,401);assert.equal((await response.json()).code,'MFA_CODE_REQUIRED');
 const reset=await userLogin(app,{username:partner.username,password:resetPassword,code:partner.recoveryCodes[2]});
 assert.equal(reset.session.mustChangePassword,true);assert.equal((await app.request('/api/admin/leads',reset)).status,403);
 const current=withStore(app,store=>store.accounts.state(partner.user.id));assert.equal(current.mfaEnabled,true);
 assert.equal((await app.request('/api/admin/session',owner)).status,200);
});

test('partner recovery codes are consumed atomically and remain consumed after restart',async t=>{
 const app=await fixture(t),owner=await login(app),partner=await enrollPartner(app,owner);
 const credentials={username:partner.username,password:partner.password,code:partner.recoveryCodes[0]};
 const requests=await Promise.all([1,2].map(()=>app.request('/api/admin/login',{method:'POST',body:credentials})));
 assert.deepEqual(requests.map(response=>response.status).sort(),[200,401]);
 const next=await restarted(app,t);
 assert.equal((await next.request('/api/admin/login',{method:'POST',body:credentials})).status,401);
 await userLogin(next,{...credentials,code:partner.recoveryCodes[1]});
});

test('owner and partner usernames share a canonical identity namespace',async t=>{
 const app=await fixture(t),owner=await login(app);
 for(const username of [ownerUsername.toUpperCase(),'ｓｔｕｄｉｏ-fixture-admin']){
  const response=await app.request('/api/admin/users',{method:'POST',...owner,body:{...partnerFields,username}});assert.equal(response.status,400,username);
 }
 await createPartner(app,owner,{username:'Shared.Name'});
 const duplicate=await app.request('/api/admin/users',{method:'POST',...owner,body:{...partnerFields,username:'shared.name'}});assert.equal(duplicate.status,400);
 const list=await app.request('/api/admin/users',owner),text=await list.text();assert.equal(list.status,200);assert.doesNotMatch(text,/password_hash|recovery_hashes|mfa_secret|salt/);
});
