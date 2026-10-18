import {randomUUID} from 'node:crypto';

export function initStudioSchema(store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS studio_projects (
  id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('production','drone','editing','digital')),
  summary TEXT NOT NULL,challenge TEXT NOT NULL DEFAULT '',approach TEXT NOT NULL DEFAULT '',result TEXT NOT NULL DEFAULT '',client_name TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS studio_project_media (project_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('cover','before','after','video')),file_id TEXT NOT NULL,storage_name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(project_id,role));
  CREATE TABLE IF NOT EXISTS lead_tracking (lead_id TEXT PRIMARY KEY,stage TEXT NOT NULL DEFAULT 'inquiry' CHECK(stage IN ('inquiry','proposal','waiting','scheduled','production','review','delivered')),next_action_at TEXT,next_action_note TEXT NOT NULL DEFAULT '',agreed_amount_cents INTEGER CHECK(agreed_amount_cents IS NULL OR (typeof(agreed_amount_cents)='integer' AND agreed_amount_cents BETWEEN 0 AND 99999999999)),payment_due_date TEXT,updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS studio_projects_published ON studio_projects(published,created_at DESC);`);
 const columns=new Set(store.db.prepare('PRAGMA table_info(studio_projects)').all().map(row=>row.name));
 if(!columns.has('featured'))store.db.exec('ALTER TABLE studio_projects ADD COLUMN featured INTEGER NOT NULL DEFAULT 0');
 if(!columns.has('sort_order'))store.db.exec('ALTER TABLE studio_projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
}
const fields='id,slug,title,category,summary,challenge,approach,result,client_name AS clientName,published,featured,sort_order AS sortOrder,created_at AS createdAt,updated_at AS updatedAt';
function mediaFields(row){return row?{id:row.file_id,storageName:row.storage_name,mimeType:row.mime_type,size:row.size}:null;}
export function createStudioStore(store){
 const db=store.db;
 const api={
  project(id){const row=db.prepare('SELECT '+fields+' FROM studio_projects WHERE id=?').get(id);return row&&!store.operations?.isTrashed('project',id)?{...row,published:Boolean(row.published),featured:Boolean(row.featured)}:null;},
  bySlug(slug){const row=db.prepare('SELECT '+fields+' FROM studio_projects WHERE slug=? AND published=1').get(slug);return row&&!store.operations?.isTrashed('project',row.id)?{...row,published:true,featured:Boolean(row.featured)}:null;},
  list({published=false}={}){return db.prepare('SELECT '+fields+' FROM studio_projects'+(published?' WHERE published=1':'')+' ORDER BY featured DESC,sort_order ASC,created_at DESC,id DESC').all().filter(row=>!store.operations?.isTrashed('project',row.id)).map(row=>({...row,published:Boolean(row.published),featured:Boolean(row.featured)}));},
  slugExists(slug,exceptId=''){return Boolean(db.prepare('SELECT 1 FROM studio_projects WHERE slug=? AND id!=?').get(slug,exceptId));},
  create(data){const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO studio_projects(id,slug,title,category,summary,challenge,approach,result,client_name,published,featured,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,data.slug,data.title,data.category,data.summary,data.challenge||'',data.approach||'',data.result||'',data.clientName||'',Number(data.published||false),Number(data.featured||false),data.sortOrder||0,now,now);return api.project(id);},
  update(id,data){if(!api.project(id))return null;db.prepare('UPDATE studio_projects SET slug=?,title=?,category=?,summary=?,challenge=?,approach=?,result=?,client_name=?,published=?,featured=?,sort_order=?,updated_at=? WHERE id=?').run(data.slug,data.title,data.category,data.summary,data.challenge,data.approach,data.result,data.clientName,Number(data.published),Number(data.featured||false),data.sortOrder||0,new Date().toISOString(),id);return api.project(id);},
  remove(id){return store.transaction(()=>{if(!api.project(id))return null;const files=db.prepare('SELECT storage_name FROM studio_project_media WHERE project_id=?').all(id).map(row=>row.storage_name);files.push(...(store.operations?.cleanupProject(id)||[]));db.prepare('DELETE FROM studio_project_media WHERE project_id=?').run(id);db.prepare('DELETE FROM studio_projects WHERE id=?').run(id);return [...new Set(files)];});},
  media(id,role){return mediaFields(db.prepare('SELECT * FROM studio_project_media WHERE project_id=? AND role=?').get(id,role));},
  allMedia(id){return Object.fromEntries(db.prepare('SELECT * FROM studio_project_media WHERE project_id=?').all(id).map(row=>[row.role,mediaFields(row)]));},
  setMedia(id,role,file){return store.transaction(()=>{if(!api.project(id))return false;const previous=api.media(id,role);db.prepare('INSERT INTO studio_project_media(project_id,role,file_id,storage_name,mime_type,size) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,role) DO UPDATE SET file_id=excluded.file_id,storage_name=excluded.storage_name,mime_type=excluded.mime_type,size=excluded.size').run(id,role,file.id,file.storageName,file.mimeType,file.size);db.prepare('UPDATE studio_projects SET updated_at=? WHERE id=?').run(new Date().toISOString(),id);return {previous};});},
  removeMedia(id,role){return store.transaction(()=>{const file=api.media(id,role);db.prepare('DELETE FROM studio_project_media WHERE project_id=? AND role=?').run(id,role);if(file)db.prepare('UPDATE studio_projects SET updated_at=? WHERE id=?').run(new Date().toISOString(),id);return file;});},
  tracking(lead,now=Date.now()){
   const row=db.prepare('SELECT stage,next_action_at AS nextActionAt,next_action_note AS nextActionNote,agreed_amount_cents AS agreedAmountCents,payment_due_date AS paymentDueDate,updated_at AS updatedAt FROM lead_tracking WHERE lead_id=?').get(lead.id)||{stage:'inquiry',nextActionAt:null,nextActionNote:'',agreedAmountCents:null,paymentDueDate:null,updatedAt:null};
   const revisionFeesCents=db.prepare('SELECT COALESCE(SUM(fee_cents),0) AS cents FROM delivery_revision_rounds WHERE lead_id=?').get(lead.id).cents;
   const baseAgreedAmountCents=row.agreedAmountCents,effectiveAgreedAmountCents=baseAgreedAmountCents===null?null:baseAgreedAmountCents+revisionFeesCents;
   const receivedAmountCents=lead.paymentReceivedCents||0,remainingCents=effectiveAgreedAmountCents===null?null:Math.max(0,effectiveAgreedAmountCents-receivedAmountCents),active=['new','contacted'].includes(lead.status);
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
   return {...row,baseAgreedAmountCents,revisionFeesCents,effectiveAgreedAmountCents,receivedAmountCents,remainingCents,actionOverdue:active&&Boolean(row.nextActionAt)&&Date.parse(row.nextActionAt)<now,paymentOverdue:remainingCents>0&&Boolean(row.paymentDueDate)&&row.paymentDueDate<today};
  },
  saveTracking(id,data){return store.transaction(()=>{
   const lead=store.getLead(id);if(!lead)return null;
   const received=data.receivedAmountCents===undefined?lead.paymentReceivedCents:data.receivedAmountCents;
   if(lead.status==='completed'&&(!Number.isSafeInteger(received)||received<=0))throw new Error('Tamamlanan işin alınan ödemesi sıfırlanamaz.');
   db.prepare('INSERT INTO lead_tracking(lead_id,stage,next_action_at,next_action_note,agreed_amount_cents,payment_due_date,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET stage=excluded.stage,next_action_at=excluded.next_action_at,next_action_note=excluded.next_action_note,agreed_amount_cents=excluded.agreed_amount_cents,payment_due_date=excluded.payment_due_date,updated_at=excluded.updated_at').run(id,data.stage,data.nextActionAt,data.nextActionNote,data.agreedAmountCents,data.paymentDueDate,new Date().toISOString());
   if(data.receivedAmountCents!==undefined)db.prepare('UPDATE leads SET payment_received_cents=? WHERE id=?').run(received===0?null:received,id);
   return store.getLead(id);
  });},
  cleanupLead(id){db.prepare('DELETE FROM lead_tracking WHERE lead_id=?').run(id);}
 };
 return api;
}
