import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {fixture,login,submit,project,png,origin,withStore,waitForBodyReader} from '../test-support/studio-fixture.mjs';

test('portfolio starts empty, drafts remain private, and publication exposes only the project projection',async t=>{
 const app=await fixture(t),auth=await login(app);
 assert.deepEqual(await (await app.request('/api/projects')).json(),{projects:[]});
 const saved=await project(app,auth,{slug:'gercek-proje',clientName:'Approved Client',challenge:'Original challenge',approach:'Creative approach',result:'Owner-supplied result'});
 assert.equal(saved.published,false);
 assert.equal((await app.request('/api/projects/gercek-proje')).status,404);
 assert.deepEqual((await (await app.request('/api/projects')).json()).projects,[]);
 const publish=await app.request(`/api/admin/projects/${saved.id}`,{method:'PATCH',...auth,body:{published:true}});
 assert.equal(publish.status,200,await publish.clone().text());
 const response=await app.request('/api/projects/gercek-proje'),{project:visible}=await response.json();
 assert.equal(response.status,200);
 assert.equal(visible.clientName,'Approved Client');
 assert.equal(visible.challenge,'Original challenge');
 assert.deepEqual(Object.keys(visible).sort(),['id','slug','title','category','summary','challenge','approach','result','clientName','createdAt','updatedAt','media','featured','sortOrder'].sort());
 assert.doesNotMatch(JSON.stringify(visible),/storageName|tokenHash|paymentReceived|briefDetails|password_hash/);
 assert.equal((await app.request('/api/projects')).status,200);
 assert.equal((await app.request(`/api/admin/projects/${saved.id}`,{method:'PATCH',...auth,body:{published:false}})).status,200);
 assert.equal((await app.request('/api/projects/gercek-proje')).status,404);
});

test('project management and uploads require full MFA, same origin, and CSRF',async t=>{
 const app=await fixture(t),auth=await login(app),saved=await project(app,auth);
 assert.equal((await app.request('/api/admin/projects')).status,401);
 for(const patch of [{cookie:auth.cookie},{...auth,csrf:'forged'},{...auth,headers:{Origin:'https://foreign.example'}},{...auth,headers:{Origin:''}}]){
  assert.equal((await app.request(`/api/admin/projects/${saved.id}`,{method:'PATCH',...patch,body:{published:true}})).status,403);
  assert.equal((await app.request(`/api/admin/projects/${saved.id}/media/cover`,{method:'POST',...patch,raw:png,headers:{...patch.headers,'Content-Type':'image/png'}})).status,403);
 }
 const restricted=await fixture(t,{mfa:false}),limited=await login(restricted);
 assert.equal(limited.session.mfaRequired,true);
 for(const [path,method,body] of [['/api/admin/projects','GET'],['/api/admin/projects','POST',{title:'No access',category:'drone',summary:'Denied'}],['/api/admin/tracking','GET']]){
  const response=await restricted.request(path,{method,...limited,...(body?{body}:{})});
  assert.equal(response.status,403);
  assert.equal((await response.json()).code,'MFA_SETUP_REQUIRED');
 }
});

test('slug collisions, malformed project metadata, and unknown fields cannot overwrite a project',async t=>{
 const app=await fixture(t),auth=await login(app),saved=await project(app,auth,{slug:'protected-project'});
 const collision=await app.request('/api/admin/projects',{method:'POST',...auth,body:{title:'Another',category:'drone',summary:'Another project',slug:saved.slug}});
 assert.equal(collision.status,409);
 for(const body of [{slug:'../escape'},{slug:'UPPER'},{slug:'x'.repeat(101)},{published:'true'},{category:'private'},{title:''},{summary:'x'.repeat(601)},{title:'bad\u0000title'},{paymentReceivedCents:100}]){
  const response=await app.request(`/api/admin/projects/${saved.id}`,{method:'PATCH',...auth,body});
  assert.equal(response.status,400,JSON.stringify(body));
 }
 const current=(await (await app.request('/api/admin/projects',auth)).json()).projects;
 assert.equal(current.length,1);assert.equal(current[0].slug,saved.slug);assert.equal(current[0].published,false);
});

test('portfolio media uses validated bytes, authenticated drafts, byte ranges, and replacement/deletion cleanup',async t=>{
 const app=await fixture(t),auth=await login(app),saved=await project(app,auth,{slug:'media-project'}),media=`/api/admin/projects/${saved.id}/media/cover`;
 for(const [contentType,raw] of [['image/svg+xml',Buffer.from('<svg/>')],['image/png',Buffer.from('<html>fake image</html>')],['image/png',Buffer.alloc(0)],['application/pdf',Buffer.from('%PDF-1.7')]]){
  const response=await app.request(media,{method:'POST',...auth,raw,headers:{'Content-Type':contentType}});
  assert.equal(response.status,415,contentType);
 }
 let uploaded=await app.request(media,{method:'POST',...auth,raw:png,headers:{'Content-Type':'image/png'}});
 assert.equal(uploaded.status,200,await uploaded.clone().text());
 assert.equal((await app.request(media)).status,401);
 assert.equal((await app.request('/media/projects/media-project/cover')).status,404);
 const head=await app.request(media,{method:'HEAD',...auth});
 assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(png.length));assert.equal(await head.text(),'');assert.match(head.headers.get('cache-control'),/no-store/);
 const range=await app.request(media,{...auth,headers:{Range:'bytes=1-7'}});
 assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 1-7/${png.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),png.subarray(1,8));
 const suffix=await app.request(media,{...auth,headers:{Range:'bytes=-9'}});
 assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),png.subarray(-9));
 for(const Range of ['bytes=999999-','bytes=0-2,5-7','bytes=-0','bytes=7-3'])assert.equal((await app.request(media,{...auth,headers:{Range}})).status,416,Range);
 uploaded=await app.request(media,{method:'POST',...auth,raw:png,headers:{'Content-Type':'image/png'}});
 assert.equal(uploaded.status,200);
 assert.equal((await readdir(join(app.dataDir,'studio-media'))).length,1,'replacement removes the previous file and temp files');
 assert.equal((await app.request(`/api/admin/projects/${saved.id}`,{method:'PATCH',...auth,body:{published:true}})).status,200);
 const visible=await app.request('/media/projects/media-project/cover');
 assert.equal(visible.status,200);assert.equal(visible.headers.get('content-type'),'image/png');assert.equal(visible.headers.get('x-content-type-options'),'nosniff');
 assert.equal((await app.request(`/api/admin/projects/${saved.id}`,{method:'DELETE',...auth,body:{confirmation:'SİL'}})).status,200);
 assert.equal((await app.request('/media/projects/media-project/cover')).status,404);
 assert.deepEqual(await readdir(join(app.dataDir,'studio-media')),[]);
});

test('logging out during a project upload prevents metadata attachment and removes the incomplete file',{timeout:10000},async t=>{
 const app=await fixture(t),auth=await login(app),saved=await project(app,auth),path=`/api/admin/projects/${saved.id}/media/cover`;
 let observe;const received=new Promise(resolve=>{observe=req=>{if(req.url!==path||req.method!=='POST')return;app.server.off('request',observe);resolve(req);};app.server.on('request',observe);});
 let pending;const result=new Promise((resolve,reject)=>{pending=httpRequest({hostname:'127.0.0.1',port:app.server.address().port,path,method:'POST',headers:{Origin:origin,'Content-Type':'image/png','Content-Length':png.length,Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});pending.on('error',reject);});
 result.catch(()=>{});
 try{
  pending.flushHeaders();await waitForBodyReader(await received);pending.write(png.subarray(0,16));
  assert.equal((await app.request('/api/admin/logout',{method:'POST',...auth,body:{}})).status,200);
  pending.end(png.subarray(16));assert.equal(await result,401);
  const fresh=await login(app,app.recoveryCodes[1]);
  assert.deepEqual((await (await app.request('/api/admin/projects',fresh)).json()).projects[0].media,{});
  assert.deepEqual(await readdir(join(app.dataDir,'studio-media')),[]);
 }finally{app.server.off('request',observe);pending.destroy();}
});

test('tracking persists exact partial payments, derives outstanding balances, and preserves completion payment constraints',async t=>{
 const app=await fixture(t),auth=await login(app),id=await submit(app),path=`/api/admin/leads/${id}/tracking`;
 const response=await app.request(path,{method:'PATCH',...auth,body:{stage:'proposal',nextActionAt:'2020-01-02T12:30:00.000Z',nextActionNote:'Follow up on the proposal',agreedAmount:'12500,50',receivedAmount:'5000.25',paymentDueDate:'2020-01-01'}});
 assert.equal(response.status,200,await response.clone().text());
 const {lead,tracking}=await response.json();
 assert.equal(lead.status,'new');assert.equal(lead.paymentReceivedCents,500025);assert.equal(tracking.agreedAmountCents,1250050);assert.equal(tracking.remainingCents,750025);assert.equal(tracking.actionOverdue,true);assert.equal(tracking.paymentOverdue,true);
 withStore(app,store=>{const persisted=store.getLead(id);assert.equal(persisted.tracking.stage,'proposal');assert.equal(persisted.tracking.remainingCents,750025);});
 const cleared=await app.request(path,{method:'PATCH',...auth,body:{receivedAmount:'0',nextActionAt:null,nextActionNote:'',paymentDueDate:null}});
 assert.equal(cleared.status,200);assert.equal((await cleared.json()).lead.paymentReceivedCents,null);
 const completed=await app.request(`/api/admin/leads/${id}`,{method:'PATCH',...auth,body:{status:'completed',notes:'Paid',paymentReceived:'100'}});
 assert.equal(completed.status,200);
 assert.equal((await app.request(path,{method:'PATCH',...auth,body:{receivedAmount:'0'}})).status,400);
 assert.equal(withStore(app,store=>store.getLead(id).paymentReceivedCents),10000);
 const outstanding=await app.request(path,{method:'PATCH',...auth,body:{stage:'delivered',nextActionAt:'2020-01-02T12:30:00Z',paymentDueDate:'2020-01-01'}});
 assert.equal(outstanding.status,200);const completedTracking=(await outstanding.json()).tracking;
 assert.equal(completedTracking.remainingCents,1240050);assert.equal(completedTracking.paymentOverdue,true,'completion must not hide an overdue outstanding balance');assert.equal(completedTracking.actionOverdue,false,'completed work no longer needs a sales follow-up');
 assert.equal((await app.request(`/api/admin/leads/${id}`,{method:'DELETE',...auth,body:{confirmation:'SİL'}})).status,200);
 assert.equal(withStore(app,store=>store.db.prepare('SELECT COUNT(*) AS n FROM lead_tracking WHERE lead_id=?').get(id).n),0);
});

test('invalid tracking dates, money, stages and forged requests never mutate a lead',async t=>{
 const app=await fixture(t),auth=await login(app),id=await submit(app),path=`/api/admin/leads/${id}/tracking`;
 assert.equal((await app.request(path,{method:'PATCH',body:{stage:'review'}})).status,401);
 assert.equal((await app.request(path,{method:'PATCH',cookie:auth.cookie,body:{stage:'review'}})).status,403);
 const before=withStore(app,store=>store.getLead(id));
 for(const body of [{stage:'completed'},{agreedAmount:125},{receivedAmount:'-1'},{receivedAmount:'1e4'},{agreedAmount:'9999999999'},{paymentDueDate:'2026-02-30'},{nextActionAt:'2026-02-30T10:00:00Z'},{nextActionAt:'2026-10-18'},{nextActionNote:'a'.repeat(1001)},{unknown:'field'}]){
  const response=await app.request(path,{method:'PATCH',...auth,body});
  assert.equal(response.status,400,JSON.stringify(body));
 }
 assert.deepEqual(withStore(app,store=>store.getLead(id)),before);
});

test('structured brief details validate and persist without becoming public, while old form submissions still work',async t=>{
 const app=await fixture(t),auth=await login(app);
 const details={service:'drone',goal:'Show our location from above',location:'İstanbul',deadline:'2026-12-01',budgetRange:'10000-25000'};
 const old=await submit(app),id=await submit(app,{briefDetails:details});
 const leads=(await (await app.request('/api/admin/leads',auth)).json()).leads;
 assert.equal(leads.find(lead=>lead.id===old).briefDetails,null);assert.deepEqual(leads.find(lead=>lead.id===id).briefDetails,details);
 const exported=await app.request('/api/admin/assistant-export',auth),report=await exported.text();
 assert.equal(exported.status,200);assert.ok(!report.includes(details.goal));assert.ok(!report.includes(details.location));assert.doesNotMatch(report,/briefDetails|agreedAmountCents|paymentDueDate/);
 for(const briefDetails of [null,[],{service:'unknown'},{budgetRange:'unbounded'},{deadline:'2026-02-30'},{goal:'x'.repeat(401)},{location:'x'.repeat(161)},{leadId:id}]){
  const response=await app.request('/api/leads',{method:'POST',body:{brand:'Fixture',name:'Fixture',email:'fixture@example.invalid',phone:'',plan:'Tek seferlik proje',brief:'Test',consent:true,briefDetails}});
  assert.equal(response.status,400,JSON.stringify(briefDetails));
 }
 assert.equal((await app.request(`/api/leads/${id}`)).status,404);
 assert.doesNotMatch(await (await app.request('/api/projects')).text(),/İstanbul|Show our location/);
});
