import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {fixture,login,submit,project,delivery,png,pdf,withStore} from '../test-support/studio-fixture.mjs';
import {createPartner,enrollPartner} from '../test-support/expansion-fixture.mjs';

const bearer=token=>({Authorization:`Bearer ${token}`});
const quoteFields={title:'Türkçe çekim ve kurgu teklifi',scope:'Ürün tanıtım filmi çekimi ve kurgusu.',deliverables:'Bir yatay film ve üç dikey kesit.',deadline:'2026-12-10',items:[{description:'Çekim günü',quantity:3,unitPrice:'1000,10'},{description:'Kurgu',quantity:2,unitPrice:'0.25'}]};
async function quote(app,auth,id,extra={}){
 const response=await app.request(`/api/admin/leads/${id}/quotes`,{method:'POST',...auth,body:{...quoteFields,...extra}});assert.equal(response.status,201,await response.clone().text());return (await response.json()).quote;
}
async function trash(app,auth,type,id,extra={}){
 const response=await app.request('/api/admin/trash',{method:'POST',...auth,body:{type,id,...extra}});assert.equal(response.status,201,await response.clone().text());return (await response.json()).trash;
}
async function uploadDelivery(app,auth,id){const response=await app.request(`/api/admin/deliveries/${id}/files`,{method:'POST',...auth,raw:pdf,headers:{'Content-Type':'application/pdf'}});assert.equal(response.status,201,await response.clone().text());return (await response.json()).delivery;}
async function client(app,auth,extra={}){const response=await app.request('/api/admin/clients',{method:'POST',...auth,body:{name:'Permissioned Fixture Client',...extra}});assert.equal(response.status,201,await response.clone().text());return (await response.json()).client;}

test('project assignment accepts active identities and publishes only agreed customer scope and fixed revision policy',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app,{email:'private-contact@example.invalid'}),partner=await createPartner(app,auth);
 let response=await app.request(`/api/admin/leads/${leadId}/operations`,{method:'PATCH',...auth,body:{assigneeId:partner.id,scope:'One product film',deliverables:'Film + 3 short clips',deadline:'2026-12-10'}});assert.equal(response.status,200,await response.clone().text());
 const operations=(await response.json()).operations;assert.equal(operations.assigneeId,partner.id);assert.equal(operations.includedRevisions,3);assert.equal(operations.extraRevisionFeeCents,100000);
 for(const fields of [{includedRevisions:10},{extraRevisionFeeCents:0},{deadline:'2026-02-31'},{assigneeId:randomUUID()}])assert.equal((await app.request(`/api/admin/leads/${leadId}/operations`,{method:'PATCH',...auth,body:fields})).status,400);
 assert.equal((await app.request(`/api/admin/users/${partner.id}`,{method:'PATCH',...auth,body:{disabled:true}})).status,200);
 assert.equal((await app.request(`/api/admin/leads/${leadId}/operations`,{method:'PATCH',...auth,body:{assigneeId:partner.id}})).status,400,'disabled partners cannot receive a project');
 const result=await delivery(app,auth,leadId),customer=await app.request('/api/delivery',{headers:bearer(result.token)}),payload=(await customer.json()).delivery;
 assert.deepEqual(Object.keys(payload.project).sort(),['scope','deliverables','deadline','includedRevisions','extraRevisionFeeCents','stage'].sort());assert.equal(payload.project.scope,'One product film');
 assert.doesNotMatch(JSON.stringify(payload),/private-contact|assigneeId|payment|email|phone|nextActionNote/);
});

test('quotes preserve integer cents, become immutable on acceptance, and bind the project agreement once',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),first=await quote(app,auth,leadId);
 assert.equal(first.totalCents,300080);assert.deepEqual(first.items.map(item=>item.lineTotalCents),[300030,50]);assert.equal(first.includedRevisions,3);assert.equal(first.extraRevisionFeeCents,100000);
 const path=`/api/admin/quotes/${first.id}`;
 let response=await app.request(path,{method:'PATCH',...auth,body:{status:'sent'}});assert.equal(response.status,200);
 response=await app.request(path,{method:'PATCH',...auth,body:{title:'Change a sent offer'}});assert.equal(response.status,409);
 response=await app.request(path,{method:'PATCH',...auth,body:{status:'accepted'}});assert.equal(response.status,200,await response.clone().text());const accepted=await response.json();
 assert.equal(accepted.quote.status,'accepted');assert.ok(accepted.quote.acceptedAt);assert.equal(accepted.lead.tracking.agreedAmountCents,300080);assert.equal(accepted.lead.operations.scope,quoteFields.scope);assert.equal(accepted.lead.operations.deliverables,quoteFields.deliverables);
 for(const body of [{status:'draft'},{status:'rejected'},{title:'Mutate accepted offer'},{items:[{description:'Replacement',quantity:1,unitPrice:'1.00'}]}])assert.equal((await app.request(path,{method:'PATCH',...auth,body})).status,409);
 const second=await quote(app,auth,leadId,{items:[{description:'Different offer',quantity:1,unitPrice:'9000'}]});
 assert.equal((await app.request(`/api/admin/quotes/${second.id}`,{method:'PATCH',...auth,body:{status:'accepted'}})).status,409);
 assert.equal(withStore(app,store=>store.getLead(leadId).tracking.agreedAmountCents),300080);assert.equal(withStore(app,store=>store.getLead(leadId).paymentReceivedCents),null);
});

test('quote PDFs are real private documents and malformed money never changes an agreement',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),saved=await quote(app,auth,leadId,{terms:'3 revizyon dahildir. Sonraki her tur 1.000 TL. ĞÜŞİÖÇ ğüşiöç'});
 const url=`/api/admin/quotes/${saved.id}/pdf`;assert.equal((await app.request(url)).status,401);
 const response=await app.request(url,auth);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type'),'application/pdf');assert.match(response.headers.get('cache-control'),/private, no-store/);assert.match(response.headers.get('content-disposition'),/attachment;/);
 const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');const parsed=await PDFDocument.load(bytes);assert.ok(parsed.getPageCount()>=1);assert.ok(bytes.length>2000,'an actual typeset branded PDF is emitted');
 for(const item of [{quantity:1.1,unitPrice:'10'},{quantity:0,unitPrice:'10'},{quantity:1,unitPrice:'1.005'},{quantity:1,unitPrice:'1e3'},{quantity:10000,unitPrice:'999999999.99'},{quantity:1,unitPrice:-1}]){
  const result=await app.request(`/api/admin/leads/${leadId}/quotes`,{method:'POST',...auth,body:{...quoteFields,items:[{description:'Invalid amount',...item}]}});assert.equal(result.status,400,JSON.stringify(item));
 }
 assert.equal(withStore(app,store=>store.getLead(leadId).tracking.agreedAmountCents),null);
});

test('simultaneous offer acceptance binds exactly one complete agreement',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),first=await quote(app,auth,leadId),second=await quote(app,auth,leadId,{scope:'Alternative scope',items:[{description:'Alternative service',quantity:1,unitPrice:'8000.75'}]});
 const responses=await Promise.all([first,second].map(value=>app.request(`/api/admin/quotes/${value.id}`,{method:'PATCH',...auth,body:{status:'accepted'}})));
 assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
 const success=responses.find(response=>response.status===200),accepted=(await success.json()).quote;
 const lead=withStore(app,store=>store.getLead(leadId));assert.equal(lead.tracking.agreedAmountCents,accepted.totalCents);assert.equal(lead.operations.scope,accepted.scope);assert.equal(lead.operations.deliverables,accepted.deliverables);
 withStore(app,store=>assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM project_quotes WHERE lead_id=? AND status='accepted'").get(leadId).n,1));
});

test('client names and logos require publication permission and use a safe public allowlist',async t=>{
 const app=await fixture(t),auth=await login(app),saved=await client(app,auth),path=`/api/admin/clients/${saved.id}`;
 assert.deepEqual((await (await app.request('/api/clients')).json()).clients,[]);
 assert.equal((await app.request(path,{method:'PATCH',...auth,body:{published:true}})).status,400);
 assert.equal((await app.request(path+'/logo',{method:'POST',...auth,raw:Buffer.from('<svg onload="alert(1)"/>'),headers:{'Content-Type':'image/png'}})).status,415);
 assert.equal((await app.request(path+'/logo',{method:'POST',cookie:auth.cookie,raw:png,headers:{'Content-Type':'image/png'}})).status,403);
 let response=await app.request(path+'/logo',{method:'POST',...auth,raw:png,headers:{'Content-Type':'image/png'}});assert.equal(response.status,200);
 const logo=(await response.json()).client.logo;assert.equal((await app.request(`/media/clients/${saved.id}/logo`)).status,404,'draft logo cannot be read publicly');assert.equal((await app.request(logo.url,auth)).status,200);
 response=await app.request(path,{method:'PATCH',...auth,body:{published:true,permissionConfirmed:true,sortOrder:2}});assert.equal(response.status,200);
 const visible=(await (await app.request('/api/clients')).json()).clients[0];assert.deepEqual(Object.keys(visible).sort(),['id','name','description','logoUrl','sortOrder'].sort());
 response=await app.request(visible.logoUrl);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 response=await app.request(path,{method:'PATCH',...auth,body:{permissionConfirmed:false,published:false}});assert.equal(response.status,200);assert.equal((await app.request(visible.logoUrl)).status,404);assert.deepEqual((await (await app.request('/api/clients')).json()).clients,[]);
});

test('featured portfolio ordering persists through the public API while unpublished work remains hidden',async t=>{
 const app=await fixture(t),auth=await login(app);
 const a=await project(app,auth,{title:'Unfeatured Fixture',published:true,sortOrder:-50}),b=await project(app,auth,{title:'Featured Second',published:true,featured:true,sortOrder:2}),c=await project(app,auth,{title:'Featured First',published:true,featured:true,sortOrder:1}),hidden=await project(app,auth,{title:'Private Featured',published:false,featured:true,sortOrder:-100});
 let response=await app.request('/api/projects'),projects=(await response.json()).projects;assert.deepEqual(projects.map(value=>value.id),[c.id,b.id,a.id]);assert.ok(!JSON.stringify(projects).includes(hidden.id));
 response=await app.request(`/api/admin/projects/${b.id}`,{method:'PATCH',...auth,body:{sortOrder:0}});assert.equal(response.status,200);projects=(await (await app.request('/api/projects')).json()).projects;assert.deepEqual(projects.map(value=>value.id),[b.id,c.id,a.id]);
 assert.equal((await app.request(`/api/admin/projects/${b.id}`,{method:'PATCH',...auth,body:{sortOrder:1.5}})).status,400);
});

test('customer testimonials require delivery approval, explicit publication consent and admin moderation',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app,{phone:'05300000000'}),result=await delivery(app,auth,leadId),headers=bearer(result.token);
 const body={displayName:'Customer Display',company:'Fixture Company',rating:5,text:'The agreed film was delivered as expected.',publicationConsent:true};
 assert.equal((await app.request('/api/delivery/review',{method:'POST',headers,body})).status,409);
 const saved=await uploadDelivery(app,auth,result.delivery.id);
 assert.equal((await app.request('/api/delivery/feedback',{method:'POST',headers,body:{action:'approve',version:saved.version,confirmation:true}})).status,200);
 assert.equal((await app.request('/api/delivery/review',{method:'POST',headers,body:{...body,publicationConsent:false}})).status,400);
 const response=await app.request('/api/delivery/review',{method:'POST',headers,body});assert.equal(response.status,201,await response.clone().text());const review=(await response.json()).review;assert.equal(review.status,'pending');
 assert.deepEqual((await (await app.request('/api/reviews')).json()).reviews,[]);
 assert.equal((await app.request('/api/delivery/review',{method:'POST',headers,body})).status,409);
 assert.equal((await app.request(`/api/admin/reviews/${review.id}`,{method:'PATCH',...auth,body:{status:'approved'}})).status,200);
 let visible=(await (await app.request('/api/reviews')).json()).reviews;assert.equal(visible.length,1);assert.deepEqual(Object.keys(visible[0]).sort(),['id','displayName','company','rating','text','createdAt'].sort());assert.doesNotMatch(JSON.stringify(visible),/leadId|email|phone|05300000000|token|status/);
 assert.equal((await app.request(`/api/admin/reviews/${review.id}`,{method:'PATCH',...auth,body:{status:'rejected'}})).status,200);visible=(await (await app.request('/api/reviews')).json()).reviews;assert.deepEqual(visible,[]);
});

test('trashed leads are hidden from all operational and AI paths; restoring does not revive customer links',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId),saved=await uploadDelivery(app,auth,result.delivery.id);
 const session=await app.request('/api/delivery/session',{method:'POST',headers:bearer(result.token),body:{}}),cookie=session.headers.get('set-cookie').split(';')[0],mediaUrl=(await session.json()).delivery.files[0].url;
 const entry=await trash(app,auth,'lead',leadId);assert.equal(entry.type,'lead');assert.equal((await app.request(mediaUrl,{cookie})).status,404);assert.equal((await app.request('/api/delivery',{headers:bearer(result.token)})).status,404);
 const inbox=await (await app.request('/api/admin/leads',auth)).json();assert.equal(inbox.leads.length,0);assert.equal(inbox.counts.total,0);
 for(const route of [`/api/admin/leads/${leadId}/operations`,`/api/admin/leads/${leadId}/deliveries`,`/api/admin/leads/${leadId}/quotes`,saved.files[0].url])assert.equal((await app.request(route,auth)).status,404,route);
 withStore(app,store=>{assert.equal(store.getLead(leadId),null);assert.equal(store.isAiLeadEligible(leadId),false);assert.deepEqual(store.pendingAiLeads(),[]);assert.equal(store.aiPendingCount(),0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE id=?').get(leadId).n,1,'soft trash retains the project');});
 const restored=await app.request(`/api/admin/trash/${entry.id}/restore`,{method:'POST',...auth,body:{}});assert.equal(restored.status,200,await restored.clone().text());assert.ok(withStore(app,store=>store.getLead(leadId)));
 assert.equal((await app.request('/api/delivery',{headers:bearer(result.token)})).status,404,'restoration requires an explicit new customer link');assert.equal((await app.request(mediaUrl,{cookie})).status,404);
});

test('project and file trash hides public media, restores bytes safely, and requires owner confirmation for permanent purge',async t=>{
 const app=await fixture(t),auth=await login(app),partner=await enrollPartner(app,auth),saved=await project(app,auth,{published:true});
 let response=await app.request(`/api/admin/projects/${saved.id}/media/cover`,{method:'POST',...auth,raw:png,headers:{'Content-Type':'image/png'}});assert.equal(response.status,200);
 const publicUrl=(await response.json()).project.media.cover.url.replace(`/api/admin/projects/${saved.id}/media/cover`,`/media/projects/${saved.slug}/cover`);
 const fileTrash=await trash(app,partner.auth,'projectMedia',saved.id,{role:'cover'});assert.equal((await app.request(publicUrl)).status,404);assert.equal((await readdir(join(app.dataDir,'studio-media'))).length,1,'recovery retains bytes while removing access');
 response=await app.request(`/api/admin/trash/${fileTrash.id}/restore`,{method:'POST',...partner.auth,body:{}});assert.equal(response.status,200,await response.clone().text());assert.equal((await app.request(publicUrl)).status,200);
 const projectTrash=await trash(app,partner.auth,'project',saved.id);
 assert.equal((await app.request(`/api/projects/${saved.slug}`)).status,404);assert.equal((await app.request(`/portfolyo/${saved.slug}`)).status,404);assert.equal((await app.request(publicUrl)).status,404);
 assert.equal((await app.request(`/api/admin/trash/${projectTrash.id}`,{method:'DELETE',...partner.auth,body:{confirmation:'SİL'}})).status,403);
 assert.equal((await app.request(`/api/admin/trash/${projectTrash.id}`,{method:'DELETE',...auth,body:{confirmation:'wrong'}})).status,400);
 response=await app.request(`/api/admin/trash/${projectTrash.id}`,{method:'DELETE',...auth,body:{confirmation:'SİL'}});assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await readdir(join(app.dataDir,'studio-media')),[]);
 withStore(app,store=>assert.equal(store.db.prepare('SELECT 1 FROM studio_projects WHERE id=?').get(saved.id),undefined));
 const activity=await app.request('/api/admin/activity',auth),records=(await activity.json()).activity;assert.ok(records.some(record=>record.actorId===partner.user.id&&record.event==='trash_created'));assert.ok(records.some(record=>record.actorId==='owner'&&record.event==='trash_purged'));
 assert.doesNotMatch(JSON.stringify(records),/password|recovery|accessCode|token_hash|storage_name/);assert.equal((await app.request('/api/admin/activity',partner.auth)).status,403);
});

test('expired trash cannot be restored and permanent lead purge removes descendants and recovery files',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),result=await delivery(app,auth,leadId),saved=await uploadDelivery(app,auth,result.delivery.id);
 const asset=await trash(app,auth,'deliveryAsset',saved.files[0].id),lead=await trash(app,auth,'lead',leadId);
 withStore(app,store=>store.db.prepare('UPDATE operations_trash SET expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),asset.id));
 assert.equal((await app.request(`/api/admin/trash/${asset.id}/restore`,{method:'POST',...auth,body:{}})).status,410);
 const response=await app.request(`/api/admin/trash/${lead.id}`,{method:'DELETE',...auth,body:{confirmation:'SİL'}});assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await readdir(join(app.dataDir,'studio-media')),[]);
 withStore(app,store=>{
  for(const table of ['leads','deliveries','delivery_assets','delivery_feedback','delivery_sessions','delivery_access_sessions','delivery_orders','delivery_revision_rounds','lead_operations','project_quotes','customer_reviews','operations_trash'])assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,table);
 });
});

test('trash rejects unrelated role fields and repeated media replacement never restores over a live asset',async t=>{
 const app=await fixture(t),auth=await login(app),leadId=await submit(app),saved=await project(app,auth,{published:true});
 for(const [type,id] of [['lead',leadId],['project',saved.id]]){
  const response=await app.request('/api/admin/trash',{method:'POST',...auth,body:{type,id,role:'cover'}});assert.equal(response.status,400,type);
 }
 assert.ok(withStore(app,store=>store.getLead(leadId)));assert.equal((await app.request(`/api/projects/${saved.slug}`)).status,200);
 const upload=()=>app.request(`/api/admin/projects/${saved.id}/media/cover`,{method:'POST',...auth,raw:png,headers:{'Content-Type':'image/png'}});
 assert.equal((await upload()).status,200);const first=await trash(app,auth,'projectMedia',saved.id,{role:'cover'});
 assert.equal((await upload()).status,200);const second=await trash(app,auth,'projectMedia',saved.id,{role:'cover'});
 assert.notEqual(first.id,second.id);assert.equal((await readdir(join(app.dataDir,'studio-media'))).length,2);
 assert.equal((await app.request(`/api/admin/trash/${first.id}/restore`,{method:'POST',...auth,body:{}})).status,200);
 assert.equal((await app.request(`/api/admin/trash/${second.id}/restore`,{method:'POST',...auth,body:{}})).status,409,'restoration cannot overwrite the current cover');
 assert.equal((await app.request(`/api/admin/trash/${second.id}`,{method:'DELETE',...auth,body:{confirmation:'SİL'}})).status,200);assert.equal((await readdir(join(app.dataDir,'studio-media'))).length,1);
 assert.equal((await app.request(`/media/projects/${saved.slug}/cover`)).status,200);
});
