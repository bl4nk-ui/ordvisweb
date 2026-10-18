import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture,login,submit,delivery,png,pdf,origin,withStore,waitForBodyReader} from '../test-support/studio-fixture.mjs';

const bearer=token=>({Authorization:`Bearer ${token}`});
async function upload(app,auth,id,bytes=pdf,type='application/pdf') {
 const response=await app.request(`/api/admin/deliveries/${id}/files`,{method:'POST',...auth,raw:bytes,headers:{'Content-Type':type}});
 assert.equal(response.status,201,await response.clone().text());
 return (await response.json()).delivery;
}
async function mediaSession(app,token) {
 const response=await app.request('/api/delivery/session',{method:'POST',headers:bearer(token),body:{}});
 assert.equal(response.status,200,await response.clone().text());
 return {response,cookie:response.headers.get('set-cookie').split(';')[0]};
}
async function mediaFiles(app) {try{return await readdir(join(app.dataDir,'studio-media'));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function filesEventuallyEmpty(app) {for(let attempt=0;attempt<30;attempt++){if(!(await mediaFiles(app)).length)return;await delay(10);}assert.deepEqual(await mediaFiles(app),[]);}

test('delivery links contain a one-time 256-bit token and expose only a minimal customer payload',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app,{phone:'05300000000'});
 const result=await delivery(app,auth,leadId),path=`/api/admin/leads/${leadId}/deliveries`;
 assert.match(result.sharePath,/^\/teslim#[a-f0-9]{64}$/);assert.match(result.token,/^[a-f0-9]{64}$/);
 const hash=createHash('sha256').update(result.token).digest('hex');
 withStore(app,store=>{
  const saved=store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(result.delivery.id);
  assert.equal(saved.token_hash,hash);assert.ok(!JSON.stringify(saved).includes(result.token));
  assert.ok(!Object.keys(saved).includes('token'));
 });
 const list=await app.request(path,auth),listText=await list.text();
 assert.equal(list.status,200);assert.ok(!listText.includes(result.token));assert.doesNotMatch(listText,/sharePath|token_hash/);
 assert.equal((await app.request('/api/delivery')).status,404);
 assert.equal((await app.request(`/api/delivery?token=${result.token}`)).status,404);
 assert.equal((await app.request('/api/delivery',{cookie:auth.cookie})).status,404);
 const response=await app.request('/api/delivery',{headers:bearer(result.token)}),data=await response.json();
 assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
 assert.deepEqual(Object.keys(data.delivery).sort(),['id','title','description','version','status','expiresAt','files','feedback','orderNumber','project','revisions'].sort());
 assert.ok(!JSON.stringify(data).includes(leadId));
 assert.doesNotMatch(JSON.stringify(data),/deniz@example|05300000000|payment|notes|briefDetails|token_hash|storageName/);
});

test('delivery management requires full MFA, CSRF, and same-origin requests; client mutations also enforce origin',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId),id=result.delivery.id;
 assert.equal((await app.request(`/api/admin/leads/${leadId}/deliveries`)).status,401);
 for(const patch of [{cookie:auth.cookie},{...auth,csrf:'forged'},{...auth,headers:{Origin:'https://foreign.example'}},{...auth,headers:{Origin:''}}]){
  assert.equal((await app.request(`/api/admin/deliveries/${id}/revoke`,{method:'POST',...patch,body:{}})).status,403);
  assert.equal((await app.request(`/api/admin/deliveries/${id}/files`,{method:'POST',...patch,raw:pdf,headers:{...patch.headers,'Content-Type':'application/pdf'}})).status,403);
 }
 const foreign={...bearer(result.token),Origin:'https://foreign.example'};
 for(const [path,body] of [['/api/delivery/session',{}],['/api/delivery/feedback',{action:'approve',version:1,confirmation:true}]])assert.equal((await app.request(path,{method:'POST',headers:foreign,body})).status,403);
 const restricted=await fixture(t,{mfa:false}),limited=await login(restricted),other=await submit(restricted);
 for(const [method,body] of [['GET',undefined],['POST',{title:'Denied'}]]){
  const response=await restricted.request(`/api/admin/leads/${other}/deliveries`,{method,...limited,body});
  assert.equal(response.status,403);assert.equal((await response.json()).code,'MFA_SETUP_REQUIRED');
 }
});

test('private file viewing requires a scoped hashed session cookie and supports safe ranges and HEAD',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId),saved=await upload(app,auth,result.delivery.id),file=saved.files[0];
 const customer=await app.request('/api/delivery',{headers:bearer(result.token)}),publicFile=(await customer.json()).delivery.files[0];
 assert.ok(!JSON.stringify(publicFile).includes('storageName'));
 assert.equal((await app.request(publicFile.url)).status,404);
 assert.equal((await app.request(publicFile.url,{headers:bearer(result.token)})).status,404,'bearer links cannot be used as native media URLs');
 const session=await mediaSession(app,result.token),cookieHeader=session.response.headers.get('set-cookie');
 assert.match(cookieHeader,/HttpOnly/);assert.match(cookieHeader,/SameSite=Strict/);assert.ok(cookieHeader.includes(`Path=/api/delivery/media/${saved.id}/`));assert.match(cookieHeader,/Max-Age=3600/);
 const rawCookie=session.cookie.split('=')[1];
 withStore(app,store=>{const row=store.db.prepare('SELECT * FROM delivery_sessions WHERE delivery_id=?').get(saved.id);assert.equal(row.token_hash,createHash('sha256').update(rawCookie).digest('hex'));assert.ok(!JSON.stringify(row).includes(rawCookie));});
 const response=await app.request(publicFile.url,{cookie:session.cookie});
 assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);assert.match(response.headers.get('cache-control'),/private, no-store/);assert.equal(response.headers.get('content-type'),'application/pdf');assert.match(response.headers.get('content-disposition'),/^attachment; filename="ordvis-/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 const head=await app.request(publicFile.url,{method:'HEAD',cookie:session.cookie});
 assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(pdf.length));assert.equal(await head.text(),'');
 const ranged=await app.request(publicFile.url,{cookie:session.cookie,headers:{Range:'bytes=5-14'}});
 assert.equal(ranged.status,206);assert.equal(ranged.headers.get('content-range'),`bytes 5-14/${pdf.length}`);assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),pdf.subarray(5,15));
 const suffix=await app.request(publicFile.url,{cookie:session.cookie,headers:{Range:'bytes=-7'}});
 assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),pdf.subarray(-7));
 assert.equal((await app.request(publicFile.url,{cookie:session.cookie,headers:{Range:'bytes=999999-'}})).status,416);
 assert.equal((await app.request(file.url)).status,401,'admin preview never accepts a customer-only cookie');
 const adminPreview=await app.request(file.url,{...auth});assert.equal(adminPreview.status,200);
});

test('file changes invalidate media sessions and stale approvals; approval never completes the customer lead',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId),headers=bearer(result.token);
 const feedback=body=>app.request('/api/delivery/feedback',{method:'POST',headers,body});
 assert.equal((await feedback({action:'approve',version:1,confirmation:true})).status,400,'an empty delivery cannot be approved');
 let saved=await upload(app,auth,result.delivery.id,png,'image/png');assert.equal(saved.version,2);
 const oldSession=await mediaSession(app,result.token),oldUrl=(await (await app.request('/api/delivery',{headers})).json()).delivery.files[0].url;
 assert.equal((await feedback({action:'approve',version:1,confirmation:true})).status,409);
 assert.equal((await feedback({action:'approve',version:2})).status,400);
 assert.equal((await feedback({action:'revision',message:'Please shorten the introduction.',version:2})).status,200);
 let approved=await feedback({action:'approve',message:'Current version approved.',version:2,confirmation:true});
 assert.equal(approved.status,200);let payload=(await approved.json()).delivery;assert.equal(payload.status,'approved');assert.equal(payload.feedback.length,2);
 approved=await feedback({action:'approve',version:2,confirmation:true});
 assert.equal(approved.status,200);assert.equal((await approved.json()).delivery.feedback.length,2,'duplicate approval is idempotent');
 assert.equal((await feedback({action:'revision',message:'Late change',version:2})).status,409);
 assert.equal(withStore(app,store=>store.getLead(leadId).status),'new');assert.equal(withStore(app,store=>store.getLead(leadId).paymentReceivedCents),null);
 saved=await upload(app,auth,result.delivery.id);assert.equal(saved.version,3);assert.equal(saved.status,'pending');
 assert.equal((await app.request(oldUrl,{cookie:oldSession.cookie})).status,404);
 assert.equal((await feedback({action:'approve',version:2,confirmation:true})).status,409);
 const deleted=await app.request(`/api/admin/deliveries/${saved.id}/files/${saved.files[0].id}`,{method:'DELETE',...auth,body:{}});
 assert.equal(deleted.status,200);payload=(await deleted.json()).delivery;assert.equal(payload.version,4);assert.equal(payload.status,'pending');assert.equal(payload.files.length,1);
});

test('rotation, revocation, and expiry immediately invalidate bearer access and existing media sessions',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),first=await delivery(app,auth,leadId);
 await upload(app,auth,first.delivery.id);
 const oldSession=await mediaSession(app,first.token),oldFile=(await (await app.request('/api/delivery',{headers:bearer(first.token)})).json()).delivery.files[0].url;
 const second=await delivery(app,auth,leadId);assert.notEqual(second.token,first.token);
 assert.equal((await app.request('/api/delivery',{headers:bearer(first.token)})).status,404);assert.equal((await app.request(oldFile,{cookie:oldSession.cookie})).status,404);
 await upload(app,auth,second.delivery.id);
 const session=await mediaSession(app,second.token),file=(await (await app.request('/api/delivery',{headers:bearer(second.token)})).json()).delivery.files[0].url;
 assert.equal((await app.request(`/api/admin/deliveries/${second.delivery.id}/revoke`,{method:'POST',...auth,body:{}})).status,200);
 assert.equal((await app.request('/api/delivery',{headers:bearer(second.token)})).status,404);assert.equal((await app.request(file,{cookie:session.cookie})).status,404);
 const third=await delivery(app,auth,leadId);await upload(app,auth,third.delivery.id);
 const thirdSession=await mediaSession(app,third.token),thirdFile=(await (await app.request('/api/delivery',{headers:bearer(third.token)})).json()).delivery.files[0].url;
 withStore(app,store=>store.db.prepare('UPDATE deliveries SET expires_at=? WHERE id=?').run(Date.now()-1,third.delivery.id));
 assert.equal((await app.request('/api/delivery',{headers:bearer(third.token)})).status,404);assert.equal((await app.request(thirdFile,{cookie:thirdSession.cookie})).status,404);
});

test('customer cookies are scoped to a delivery and cannot access another lead’s files',async t=>{
 const app=await fixture(t),auth=await login(app),first=await delivery(app,auth,await submit(app)),second=await delivery(app,auth,await submit(app,{name:'Another Customer'}));
 await upload(app,auth,first.delivery.id);await upload(app,auth,second.delivery.id);
 const session=await mediaSession(app,first.token),otherFile=(await (await app.request('/api/delivery',{headers:bearer(second.token)})).json()).delivery.files[0].url;
 assert.equal((await app.request(otherFile,{cookie:session.cookie})).status,404);
 assert.equal((await app.request('/api/delivery',{headers:{Authorization:`Bearer ${first.token.toUpperCase()}`}})).status,404);
});

test('delivery inputs and disguised executable uploads fail without adding assets or feedback',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId),headers=bearer(result.token);
 for(const extra of [{title:''},{title:'x'.repeat(151)},{description:'x'.repeat(2001)},{expiresInDays:0},{expiresInDays:31},{expiresInDays:1.5}]){
  const response=await app.request(`/api/admin/leads/${leadId}/deliveries`,{method:'POST',...auth,body:{title:'Fixture',...extra}});assert.equal(response.status,400,JSON.stringify(extra));
 }
 for(const [type,bytes] of [['image/svg+xml',Buffer.from('<svg/>')],['application/pdf',Buffer.from('<html><script>alert(1)</script></html>')],['image/png',pdf],['video/mp4',Buffer.from('not-an-mp4')]]){
  const response=await app.request(`/api/admin/deliveries/${result.delivery.id}/files`,{method:'POST',...auth,raw:bytes,headers:{'Content-Type':type}});assert.equal(response.status,415,type);
 }
 for(const body of [{action:'revision',message:'',version:1},{action:'revision',message:'x'.repeat(2001),version:1},{action:'revision',message:'Edit',version:1.5},{action:'delete',version:1},{action:'approve',version:'1',confirmation:true}]){
  const response=await app.request('/api/delivery/feedback',{method:'POST',headers,body});assert.equal(response.status,400,JSON.stringify(body));
 }
 const current=(await (await app.request('/api/delivery',{headers})).json()).delivery;
 assert.deepEqual(current.files,[]);assert.deepEqual(current.feedback,[]);assert.equal(current.version,1);await filesEventuallyEmpty(app);
});

test('chunked oversized and interrupted uploads remove temporary files and cannot attach assets',{timeout:15000},async t=>{
 const app=await fixture(t),auth=await login(app),result=await delivery(app,auth,await submit(app)),path=`/api/admin/deliveries/${result.delivery.id}/files`;
 const oversized=await new Promise((resolve,reject)=>{
  const request=httpRequest({hostname:'127.0.0.1',port:app.server.address().port,path,method:'POST',headers:{Origin:origin,'Content-Type':'image/png',Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'Transfer-Encoding':'chunked',Connection:'close'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
  request.on('error',reject);request.write(png);request.end(Buffer.alloc(8*1024*1024));
 });
 assert.equal(oversized,413);await filesEventuallyEmpty(app);
 let observe;const received=new Promise(resolve=>{observe=req=>{if(req.url!==path||req.method!=='POST')return;app.server.off('request',observe);resolve(req);};app.server.on('request',observe);});
 const pending=httpRequest({hostname:'127.0.0.1',port:app.server.address().port,path,method:'POST',headers:{Origin:origin,'Content-Type':'image/png','Content-Length':1024,Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}});pending.on('error',()=>{});
 try{pending.flushHeaders();await waitForBodyReader(await received);pending.write(png);pending.destroy();await filesEventuallyEmpty(app);}finally{app.server.off('request',observe);pending.destroy();}
 const listed=(await (await app.request(`/api/admin/leads/${result.delivery.leadId}/deliveries`,auth)).json()).deliveries;
 assert.deepEqual(listed[0].files,[]);
});

test('deleting a lead clears delivery tokens, private sessions, history, metadata and physical files',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId),saved=await upload(app,auth,result.delivery.id),session=await mediaSession(app,result.token),clientFile=(await (await app.request('/api/delivery',{headers:bearer(result.token)})).json()).delivery.files[0].url;
 assert.equal((await app.request('/api/delivery/feedback',{method:'POST',headers:bearer(result.token),body:{action:'revision',message:'Adjust the ending.',version:saved.version}})).status,200);
 assert.equal((await app.request(`/api/admin/leads/${leadId}`,{method:'DELETE',...auth,body:{confirmation:'SİL'}})).status,200);
 assert.equal((await app.request('/api/delivery',{headers:bearer(result.token)})).status,404);assert.equal((await app.request(clientFile,{cookie:session.cookie})).status,404);
 withStore(app,store=>{for(const table of ['deliveries','delivery_assets','delivery_feedback','delivery_sessions'])assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,table);});
 await filesEventuallyEmpty(app);
});

test('deleting a lead or logging out while its delivery uploads cannot resurrect files or attach unauthorized data',{timeout:10000},async t=>{
 const app=await fixture(t),auth=await login(app);
 for(const action of ['delete','logout']){
  const leadId=await submit(app),result=await delivery(app,auth,leadId),path=`/api/admin/deliveries/${result.delivery.id}/files`;
  let observe;const received=new Promise(resolve=>{observe=req=>{if(req.url!==path||req.method!=='POST')return;app.server.off('request',observe);resolve(req);};app.server.on('request',observe);});
  let pending;const responsePromise=new Promise((resolve,reject)=>{
   pending=httpRequest({hostname:'127.0.0.1',port:app.server.address().port,path,method:'POST',headers:{Origin:origin,'Content-Type':'application/pdf','Content-Length':pdf.length,Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});pending.on('error',reject);
  });responsePromise.catch(()=>{});
  try{
   pending.flushHeaders();await waitForBodyReader(await received);pending.write(pdf.subarray(0,8));
   const changed=action==='delete'?await app.request(`/api/admin/leads/${leadId}`,{method:'DELETE',...auth,body:{confirmation:'SİL'}}):await app.request('/api/admin/logout',{method:'POST',...auth,body:{}});
   assert.equal(changed.status,200);pending.end(pdf.subarray(8));assert.equal(await responsePromise,action==='delete'?409:401);
   assert.equal(withStore(app,store=>store.db.prepare('SELECT COUNT(*) AS n FROM delivery_assets WHERE delivery_id=?').get(result.delivery.id).n),0);
   await filesEventuallyEmpty(app);
  }finally{app.server.off('request',observe);pending.destroy();}
 }
});
