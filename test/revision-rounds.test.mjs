import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture,login,submit,delivery,pdf,withStore} from '../test-support/studio-fixture.mjs';
import {restarted} from '../test-support/expansion-fixture.mjs';

const bearer=token=>({Authorization:`Bearer ${token}`});
const video=Buffer.from('000000186674797069736f6d0000000069736f6d6d703432','hex');
async function upload(app,auth,id,bytes=pdf,type='application/pdf'){
 const response=await app.request(`/api/admin/deliveries/${id}/files`,{method:'POST',...auth,raw:bytes,headers:{'Content-Type':type}});
 assert.equal(response.status,201,await response.clone().text());return (await response.json()).delivery;
}
const feedback=(app,token,body)=>app.request('/api/delivery/feedback',{method:'POST',headers:bearer(token),body});
test('a bounded multi-note revision accepts valid multibyte text without weakening the byte cap',async t=>{
 const app=await fixture(t),auth=await login(app),result=await delivery(app,auth,await submit(app));
 const saved=await upload(app,auth,result.delivery.id,video,'video/mp4'),assetId=saved.files[0].id;
 const body={action:'revision',version:saved.version,requestId:randomUUID(),message:'ü'.repeat(1000),notes:Array.from({length:11},(_,i)=>({assetId,timeSeconds:i,message:'ş'.repeat(1000)}))};
 assert.ok(Buffer.byteLength(JSON.stringify(body))>16384);
 const response=await feedback(app,result.token,body);assert.equal(response.status,200,await response.clone().text());
 const value=(await response.json()).delivery;assert.equal(value.revisions.used,1);assert.equal(value.feedback[0].notes.length,11);
 const oversized=await feedback(app,result.token,{...body,requestId:randomUUID(),padding:'a'.repeat(65536)});assert.equal(oversized.status,413);
 assert.equal(withStore(app,store=>store.db.prepare('SELECT COUNT(*) AS count FROM delivery_revision_rounds WHERE lead_id=?').get(result.delivery.leadId).count),1);
});
async function lookup(app,result,patch={}){
 return app.request('/api/delivery/lookup',{method:'POST',body:{orderNumber:result.orderNumber,accessCode:result.accessCode,...patch}});
}

test('order lookup needs both random credentials, stores only hashes, and grants a short scoped customer session',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app,{phone:'05300000000'}),result=await delivery(app,auth,leadId);
 const saved=await upload(app,auth,result.delivery.id),second=await delivery(app,auth,await submit(app,{name:'Other Customer'}));await upload(app,auth,second.delivery.id);
 assert.match(result.orderNumber,/^ORD-\d{4}-[A-F0-9]{10}$/);assert.match(result.accessCode,/^(?:[A-F0-9]{8}-){3}[A-F0-9]{8}$/);
 withStore(app,store=>{
  const row=store.db.prepare('SELECT * FROM delivery_orders WHERE lead_id=?').get(leadId);
  assert.equal(row.access_code_hash,createHash('sha256').update(result.accessCode.replaceAll('-','')).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(result.accessCode.replaceAll('-','')));assert.ok(!Object.hasOwn(row,'access_code'));
 });
 for(const patch of [{accessCode:''},{accessCode:undefined},{orderNumber:undefined},{orderNumber:'ORD-2026-0000000000'},{accessCode:'0'.repeat(32)}]){
  const response=await lookup(app,result,patch);assert.equal(response.status,404,JSON.stringify(patch));assert.equal(response.headers.get('set-cookie'),null);
 }
 const response=await lookup(app,result);assert.equal(response.status,200,await response.clone().text());const access=await response.json();
 assert.match(access.accessToken,/^[a-f0-9]{64}$/);assert.notEqual(access.accessToken,result.token);assert.equal(access.delivery.id,saved.id);
 assert.match(response.headers.get('cache-control'),/no-store/);
 assert.doesNotMatch(JSON.stringify(access),/deniz@example|05300000000|token_hash|access_code_hash|payment|private|notesJson/);
 withStore(app,store=>{const row=store.db.prepare('SELECT * FROM delivery_access_sessions WHERE delivery_id=?').get(saved.id);assert.equal(row.token_hash,createHash('sha256').update(access.accessToken).digest('hex'));assert.ok(row.expires_at>Date.now());assert.ok(row.expires_at<=Date.now()+3600000);});
 const session=await app.request('/api/delivery/session',{method:'POST',headers:bearer(access.accessToken),body:{}});assert.equal(session.status,200);
 const cookie=session.headers.get('set-cookie').split(';')[0];assert.match(session.headers.get('set-cookie'),/HttpOnly/);assert.match(session.headers.get('set-cookie'),/SameSite=Strict/);
 const ownFile=access.delivery.files[0].url,otherFile=(await (await app.request('/api/delivery',{headers:bearer(second.token)})).json()).delivery.files[0].url;
 assert.equal((await app.request(ownFile,{cookie})).status,200);assert.equal((await app.request(otherFile,{cookie})).status,404);
 withStore(app,store=>store.db.prepare('UPDATE delivery_access_sessions SET expires_at=? WHERE delivery_id=?').run(Date.now()-1,saved.id));
 assert.equal((await app.request('/api/delivery',{headers:bearer(access.accessToken)})).status,404,'lookup bearer expires independently of the original share link');
 assert.equal((await app.request('/api/delivery',{headers:bearer(result.token)})).status,200);
});

test('rotating delivery access keeps the order number but replaces its code and revokes lookup sessions',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),first=await delivery(app,auth,leadId);
 const access=await (await lookup(app,first)).json();
 const second=await delivery(app,auth,leadId);assert.equal(second.orderNumber,first.orderNumber);assert.notEqual(second.accessCode,first.accessCode);
 assert.equal((await lookup(app,first)).status,404);assert.equal((await lookup(app,second)).status,200);
 assert.equal((await app.request('/api/delivery',{headers:bearer(access.accessToken)})).status,404);
 assert.equal((await app.request('/api/delivery',{headers:bearer(first.token)})).status,404);
 const list=await app.request(`/api/admin/leads/${leadId}/deliveries`,auth),text=await list.text();assert.doesNotMatch(text,/accessCode|access_code_hash|sharePath/);assert.ok(!text.includes(second.accessCode));
});

test('order lookup attempt limits survive a restart and ignore forged client forwarding headers',async t=>{
 const app=await fixture(t),auth=await login(app),result=await delivery(app,auth,await submit(app));
 for(let index=0;index<20;index++){
  const response=await app.request('/api/delivery/lookup',{method:'POST',body:{orderNumber:result.orderNumber,accessCode:'0'.repeat(32)},headers:{'X-Forwarded-For':`192.0.2.${index+1}`}});
  assert.equal(response.status,404,`attempt ${index+1}`);
 }
 const next=await restarted(app,t),limited=await lookup(next,result);
 assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);assert.equal(limited.headers.get('set-cookie'),null);
});

test('three revision rounds belong to the project across delivery rotations and restart; every additional round needs explicit 1000 TL consent',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app);let current=await delivery(app,auth,leadId);
 assert.equal((await app.request(`/api/admin/leads/${leadId}/tracking`,{method:'PATCH',...auth,body:{agreedAmount:'10000'}})).status,200);
 let version=await upload(app,auth,current.delivery.id);
 for(let round=1;round<=3;round++){
  const response=await feedback(app,current.token,{action:'revision',version:version.version,requestId:randomUUID(),message:`Round ${round}`});
  assert.equal(response.status,200,await response.clone().text());const result=(await response.json()).delivery;
  assert.equal(result.revisions.used,round);assert.equal(result.revisions.remaining,3-round);assert.equal(result.revisions.extraFeeCentsTotal,0);
  assert.equal(result.feedback.at(-1).feeCents,0);assert.equal(result.feedback.at(-1).roundNumber,round);
  if(round===1){current=await delivery(app,auth,leadId);version=await upload(app,auth,current.delivery.id);}
  else if(round<3)version=await upload(app,auth,current.delivery.id);
 }
 const next=await restarted(app,t),nextAuth=await login({...next,recoveryCodes:app.recoveryCodes},app.recoveryCodes[1]);
 version=await upload(next,nextAuth,current.delivery.id);
 const fourth={action:'revision',version:version.version,requestId:randomUUID(),message:'Fourth revision'};
 for(const patch of [{},{extraFeeAccepted:false},{extraFeeAccepted:'true'}])assert.equal((await feedback(next,current.token,{...fourth,...patch})).status,400);
 let payload=(await (await next.request('/api/delivery',{headers:bearer(current.token)})).json()).delivery;
 assert.equal(payload.revisions.used,3);assert.equal(payload.revisions.nextFeeCents,100000);assert.equal(payload.revisions.extraFeeCentsTotal,0);
 const paidRequests=await Promise.all([1,2].map(()=>feedback(next,current.token,{...fourth,extraFeeAccepted:true})));assert.deepEqual(paidRequests.map(response=>response.status),[200,200]);payload=(await paidRequests[0].json()).delivery;
 assert.equal(payload.revisions.used,4);assert.equal(payload.revisions.extraFeeCentsTotal,100000);assert.equal(payload.feedback.at(-1).feeCents,100000);
 assert.equal(payload.feedback.at(-1).roundNumber,4);assert.equal(withStore(app,store=>store.getLead(leadId).paymentReceivedCents),null,'fee consent records an agreed charge, never a received payment');
 version=await upload(next,nextAuth,current.delivery.id);
 const fifth=await feedback(next,current.token,{action:'revision',version:version.version,requestId:randomUUID(),message:'Fifth round',extraFeeAccepted:true});assert.equal(fifth.status,200);
 assert.equal((await fifth.json()).delivery.revisions.extraFeeCentsTotal,200000);
 let tracking=withStore(app,store=>store.getLead(leadId).tracking);assert.equal(tracking.baseAgreedAmountCents,1000000);assert.equal(tracking.revisionFeesCents,200000);assert.equal(tracking.effectiveAgreedAmountCents,1200000);assert.equal(tracking.remainingCents,1200000);
 const paid=await next.request(`/api/admin/leads/${leadId}/tracking`,{method:'PATCH',...nextAuth,body:{receivedAmount:'2500,25'}});assert.equal(paid.status,200);tracking=(await paid.json()).tracking;assert.equal(tracking.receivedAmountCents,250025);assert.equal(tracking.remainingCents,949975);
});

test('media cookies minted from a lookup session cannot extend its original expiry',async t=>{
 const app=await fixture(t),auth=await login(app),result=await delivery(app,auth,await submit(app));await upload(app,auth,result.delivery.id);
 const access=await (await lookup(app,result)).json(),expiresAt=Date.now()+5000;
 withStore(app,store=>store.db.prepare('UPDATE delivery_access_sessions SET expires_at=? WHERE token_hash=?').run(expiresAt,createHash('sha256').update(access.accessToken).digest('hex')));
 const response=await app.request('/api/delivery/session',{method:'POST',headers:bearer(access.accessToken),body:{}});assert.equal(response.status,200);
 const maxAge=Number(/Max-Age=(\d+)/.exec(response.headers.get('set-cookie'))?.[1]);assert.ok(maxAge>=0&&maxAge<=5);
 withStore(app,store=>{const row=store.db.prepare('SELECT expires_at FROM delivery_sessions WHERE delivery_id=?').get(result.delivery.id);assert.ok(row.expires_at<=expiresAt);});
});

test('revision requests are idempotent across retries and concurrent submits without granting duplicate rounds',async t=>{
 const app=await fixture(t),auth=await login(app),result=await delivery(app,auth,await submit(app)),saved=await upload(app,auth,result.delivery.id);
 const body={action:'revision',version:saved.version,requestId:randomUUID(),message:'Use the shorter opening.'};
 const responses=await Promise.all([1,2].map(()=>feedback(app,result.token,body)));assert.deepEqual(responses.map(response=>response.status),[200,200]);
 for(const response of responses){const value=(await response.json()).delivery;assert.equal(value.revisions.used,1);assert.equal(value.feedback.length,1);}
 assert.equal((await feedback(app,result.token,{...body,message:'A changed request under the same ID'})).status,409);
 assert.equal((await feedback(app,result.token,{...body,requestId:randomUUID()})).status,409,'another ID cannot open a second round for the same version');
 const updated=await upload(app,auth,result.delivery.id);
 const retry=await feedback(app,result.token,body);assert.equal(retry.status,200);assert.equal((await retry.json()).delivery.revisions.used,1,'a network retry after an upload does not bill another round');
 assert.equal((await feedback(app,result.token,{...body,requestId:randomUUID()})).status,409,'a fresh stale request fails the version check');
 const competing=await Promise.all(['One editor','Another editor'].map(message=>feedback(app,result.token,{action:'revision',version:updated.version,requestId:randomUUID(),message})));
 assert.deepEqual(competing.map(response=>response.status).sort(),[200,409]);
 const current=(await (await app.request('/api/delivery',{headers:bearer(result.token)})).json()).delivery;assert.equal(current.revisions.used,2);assert.equal(current.feedback.length,2);
});

test('timestamp notes are bounded and tied to video assets in the current delivery',async t=>{
 const app=await fixture(t),auth=await login(app),result=await delivery(app,auth,await submit(app)),other=await delivery(app,auth,await submit(app));
 const foreign=await upload(app,auth,other.delivery.id,video,'video/mp4');
 let saved=await upload(app,auth,result.delivery.id,video,'video/mp4');saved=await upload(app,auth,result.delivery.id);
 const file=saved.files.find(file=>file.mimeType==='video/mp4'),document=saved.files.find(file=>file.mimeType==='application/pdf');
 const base={action:'revision',version:saved.version,requestId:randomUUID(),message:'Review the marked shot.'};
 for(const patch of [{timeSeconds:-1},{timeSeconds:10800.001},{timeSeconds:'15'},{timeSeconds:null},{assetId:foreign.files[0].id},{assetId:document.id},{assetId:randomUUID()},{message:''}]){
  const body={...base,notes:[{assetId:file.id,timeSeconds:12.3456,message:'Shorten this shot',...patch}]};
  const response=await feedback(app,result.token,body);assert.equal(response.status,400,JSON.stringify(patch));
 }
 const oversized={...base,notes:Array.from({length:21},()=>({assetId:file.id,timeSeconds:1,message:'One note'}))};assert.equal((await feedback(app,result.token,oversized)).status,400);
 const valid=await feedback(app,result.token,{...base,message:'',notes:[{assetId:file.id,timeSeconds:12.3456,message:'Shorten this shot'}]});
 assert.equal(valid.status,200,await valid.clone().text());const payload=(await valid.json()).delivery;assert.equal(payload.revisions.used,1);assert.equal(payload.feedback[0].notes[0].timeSeconds,12.346);assert.equal(payload.feedback[0].notes[0].assetId,file.id);
});

test('historical revision feedback migrates by project round without retroactive charges',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId);
 await upload(app,auth,result.delivery.id);
 withStore(app,store=>{
  const insert=store.db.prepare('INSERT INTO delivery_feedback(id,delivery_id,version,action,message,created_at) VALUES(?,?,?,?,?,?)');
  for(let version=1;version<=4;version++)insert.run(randomUUID(),result.delivery.id,version,'revision',`Historical revision ${version}`,new Date(Date.now()-10000+version*1000).toISOString());
  insert.run(randomUUID(),result.delivery.id,1,'revision','An old duplicate note in the same round',new Date(Date.now()-9000).toISOString());
 });
 const next=await restarted(app,t),response=await next.request('/api/delivery',{headers:bearer(result.token)});assert.equal(response.status,200);
 const payload=(await response.json()).delivery;assert.equal(payload.revisions.used,4);assert.equal(payload.revisions.remaining,0);assert.equal(payload.revisions.extraFeeCentsTotal,0);assert.equal(payload.revisions.nextFeeCents,100000);
 assert.equal(payload.feedback.length,5);for(const item of payload.feedback){assert.equal(item.feeCents,0);assert.ok(item.roundNumber>=1&&item.roundNumber<=4);}
});
