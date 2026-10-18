import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
function error(status,message){const err=new Error(message);err.status=status;return err;}
const validId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const validRequestId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const INCLUDED_REVISION_ROUNDS=3;
export const EXTRA_REVISION_FEE_CENTS=100000;
export function initDeliverySchema(store){
 const db=store.db;
 db.exec(`
 CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,revoked_at INTEGER,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS deliveries_lead ON deliveries(lead_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS delivery_assets(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,storage_name TEXT NOT NULL UNIQUE,mime_type TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS delivery_assets_delivery ON delivery_assets(delivery_id);
 CREATE TABLE IF NOT EXISTS delivery_feedback(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS delivery_feedback_delivery ON delivery_feedback(delivery_id,created_at);
 CREATE TABLE IF NOT EXISTS delivery_sessions(token_hash TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,version INTEGER NOT NULL,expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS delivery_sessions_delivery ON delivery_sessions(delivery_id);
 CREATE TABLE IF NOT EXISTS delivery_orders(lead_id TEXT PRIMARY KEY,order_number TEXT NOT NULL UNIQUE,access_code_hash TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS delivery_access_sessions(token_hash TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS delivery_access_sessions_delivery ON delivery_access_sessions(delivery_id);
 CREATE TABLE IF NOT EXISTS delivery_revision_rounds(id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,delivery_id TEXT NOT NULL,version INTEGER NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,round_number INTEGER NOT NULL,fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(fee_cents IN (0,100000)),created_at TEXT NOT NULL,UNIQUE(lead_id,request_id),UNIQUE(delivery_id,version),UNIQUE(lead_id,round_number));
 CREATE INDEX IF NOT EXISTS delivery_revision_rounds_lead ON delivery_revision_rounds(lead_id);`);
 const columns=new Set(db.prepare('PRAGMA table_info(delivery_feedback)').all().map(column=>column.name));
 for(const [name,type] of [['notes_json',"TEXT NOT NULL DEFAULT '[]'"],['round_number','INTEGER'],['fee_cents','INTEGER NOT NULL DEFAULT 0'],['request_id','TEXT']])if(!columns.has(name))db.exec(`ALTER TABLE delivery_feedback ADD COLUMN ${name} ${type}`);
 // Previous feedback already used an agency revision round. Count each historical
 // delivery/version once and never apply the new fee retroactively.
 store.transaction(()=>{
  const history=db.prepare("SELECT f.id,f.delivery_id AS deliveryId,d.lead_id AS leadId,f.version,f.created_at AS createdAt FROM delivery_feedback f JOIN deliveries d ON d.id=f.delivery_id WHERE f.action='revision' AND f.round_number IS NULL ORDER BY f.created_at,f.id").all();
  for(const row of history){
   let round=db.prepare('SELECT round_number AS roundNumber FROM delivery_revision_rounds WHERE delivery_id=? AND version=?').get(row.deliveryId,row.version);
   if(!round){
    const roundNumber=db.prepare('SELECT COALESCE(MAX(round_number),0)+1 AS n FROM delivery_revision_rounds WHERE lead_id=?').get(row.leadId).n;
    db.prepare('INSERT INTO delivery_revision_rounds(id,lead_id,delivery_id,version,request_id,input_hash,round_number,fee_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.leadId,row.deliveryId,row.version,'historical:'+row.id,'historical',roundNumber,0,row.createdAt);round={roundNumber};
   }
   db.prepare('UPDATE delivery_feedback SET round_number=?,fee_cents=0 WHERE id=?').run(round.roundNumber,row.id);
  }
 });
}
export function cleanupDeliveryLead(store,leadId){
 const files=store.db.prepare('SELECT a.storage_name AS storageName FROM delivery_assets a JOIN deliveries d ON d.id=a.delivery_id WHERE d.lead_id=?').all(leadId).map(row=>row.storageName);
 for(const table of ['delivery_sessions','delivery_access_sessions','delivery_feedback','delivery_assets'])store.db.prepare(`DELETE FROM ${table} WHERE delivery_id IN(SELECT id FROM deliveries WHERE lead_id=?)`).run(leadId);
 store.db.prepare('DELETE FROM delivery_revision_rounds WHERE lead_id=?').run(leadId);
 store.db.prepare('DELETE FROM delivery_orders WHERE lead_id=?').run(leadId);
 store.db.prepare('DELETE FROM deliveries WHERE lead_id=?').run(leadId);return files;
}
export function createDeliveryStore(store){
 const db=store.db;
 const get=id=>db.prepare('SELECT id,lead_id AS leadId,title,description,expires_at AS expiresAt,revoked_at AS revokedAt,version,status,created_at AS createdAt FROM deliveries WHERE id=?').get(id)||null;
 const active=(delivery,now=Date.now())=>Boolean(delivery&&delivery.revokedAt===null&&delivery.expiresAt>now&&store.getLead(delivery.leadId));
 const assets=id=>db.prepare('SELECT id,storage_name AS storageName,mime_type AS mimeType,size,created_at AS createdAt FROM delivery_assets WHERE delivery_id=? ORDER BY created_at,id').all(id);
 function revisions(leadId){const row=db.prepare('SELECT COUNT(*) AS used,COALESCE(SUM(fee_cents),0) AS extraFeeCentsTotal FROM delivery_revision_rounds WHERE lead_id=?').get(leadId);return {included:INCLUDED_REVISION_ROUNDS,used:row.used,remaining:Math.max(0,INCLUDED_REVISION_ROUNDS-row.used),nextFeeCents:row.used>=INCLUDED_REVISION_ROUNDS?EXTRA_REVISION_FEE_CENTS:0,extraFeeCentsTotal:row.extraFeeCentsTotal};}
 function order(leadId){return db.prepare('SELECT order_number AS orderNumber FROM delivery_orders WHERE lead_id=?').get(leadId)||null;}
 function payload(delivery,{admin=false}={}){
  const files=assets(delivery.id).map(({storageName,...file})=>({...file,url:admin?`/api/admin/deliveries/${delivery.id}/files/${file.id}`:`/api/delivery/media/${delivery.id}/${file.id}`}));
  const feedback=db.prepare('SELECT id,version,action,message,notes_json AS notesJson,round_number AS roundNumber,fee_cents AS feeCents,created_at AS createdAt FROM delivery_feedback WHERE delivery_id=? ORDER BY created_at DESC,id DESC LIMIT 500').all(delivery.id).reverse().map(({notesJson,...row})=>({...row,notes:JSON.parse(notesJson)}));
  const result={id:delivery.id,title:delivery.title,description:delivery.description,version:delivery.version,status:delivery.status,expiresAt:new Date(delivery.expiresAt).toISOString(),files,feedback,orderNumber:order(delivery.leadId)?.orderNumber||null,revisions:revisions(delivery.leadId)};
  // The operations module supplies an explicit public allowlist, never the lead
  // record with its contact details, private notes, or payments.
  if(store.operations?.customerProject)result.project=store.operations.customerProject(delivery.leadId);
  if(admin)Object.assign(result,{leadId:delivery.leadId,createdAt:delivery.createdAt,revokedAt:delivery.revokedAt?new Date(delivery.revokedAt).toISOString():null});return result;
 }
 function invalidateSessions(deliveryId){db.prepare('DELETE FROM delivery_sessions WHERE delivery_id=?').run(deliveryId);db.prepare('DELETE FROM delivery_access_sessions WHERE delivery_id=?').run(deliveryId);}
 function validateNotes(notes){
  if(notes===undefined)return [];
  if(!Array.isArray(notes)||notes.length>20)throw error(400,'Bir revizyon turuna en fazla 20 zaman kodlu not ekleyebilirsiniz.');
  return notes.map(note=>{
   if(!note||typeof note!=='object'||Array.isArray(note)||Object.keys(note).some(key=>!['assetId','timeSeconds','message'].includes(key))||!validId(note.assetId)||!Number.isFinite(note.timeSeconds)||note.timeSeconds<0||note.timeSeconds>10800||typeof note.message!=='string'||!note.message.trim()||note.message.length>1000)throw error(400,'Zaman kodlu notları kontrol edin.');
   return {assetId:note.assetId,timeSeconds:Math.round(note.timeSeconds*1000)/1000,message:note.message.trim()};
  });
 }
 return {
  get,active,assets,payload,revisions,
  list(leadId){return db.prepare('SELECT id FROM deliveries WHERE lead_id=? ORDER BY created_at DESC,id DESC').all(leadId).map(row=>payload(get(row.id),{admin:true}));},
  create(leadId,{title,description='',expiresInDays=7},now=Date.now()){
   if(typeof title!=='string'||!title.trim()||title.length>150||typeof description!=='string'||description.length>2000||!Number.isInteger(expiresInDays)||expiresInDays<1||expiresInDays>30)throw error(400,'Teslim alanlarını kontrol edin.');
   return store.transaction(()=>{if(!store.getLead(leadId))throw error(404,'Talep bulunamadı.');
    const id=randomUUID(),token=randomBytes(32).toString('hex'),rawCode=randomBytes(16).toString('hex').toUpperCase();
    let orderNumber=order(leadId)?.orderNumber;
    if(!orderNumber){do{orderNumber='ORD-'+new Date(now).getUTCFullYear()+'-'+randomBytes(5).toString('hex').toUpperCase();}while(db.prepare('SELECT 1 FROM delivery_orders WHERE order_number=?').get(orderNumber));}
    db.prepare('INSERT INTO delivery_orders(lead_id,order_number,access_code_hash,created_at) VALUES(?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET access_code_hash=excluded.access_code_hash').run(leadId,orderNumber,hash(rawCode),new Date(now).toISOString());
    db.prepare('UPDATE deliveries SET revoked_at=? WHERE lead_id=? AND revoked_at IS NULL').run(now,leadId);
    for(const table of ['delivery_sessions','delivery_access_sessions'])db.prepare(`DELETE FROM ${table} WHERE delivery_id IN(SELECT id FROM deliveries WHERE lead_id=?)`).run(leadId);
    db.prepare('INSERT INTO deliveries(id,lead_id,title,description,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id,leadId,title.trim(),description.trim(),hash(token),now+expiresInDays*86400000,new Date(now).toISOString());
    return {delivery:payload(get(id),{admin:true}),sharePath:'/teslim#'+token,orderNumber,accessCode:rawCode.match(/.{8}/g).join('-')};
   });
  },
  revoke(id,now=Date.now()){return store.transaction(()=>{if(!get(id))return false;db.prepare('UPDATE deliveries SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now,id);invalidateSessions(id);return true;});},
  addAsset(id,file,now=Date.now()){return store.transaction(()=>{const delivery=get(id);if(!active(delivery,now))throw error(409,'Teslim bağlantısı etkin değil. Yeni bağlantı oluşturun.');if(assets(id).length>=20)throw error(409,'Bir teslimde en fazla 20 dosya bulunabilir.');
   db.prepare('INSERT INTO delivery_assets(id,delivery_id,storage_name,mime_type,size,created_at) VALUES(?,?,?,?,?,?)').run(file.id,id,file.storageName,file.mimeType,file.size,new Date(now).toISOString());
   db.prepare("UPDATE deliveries SET version=version+1,status='pending' WHERE id=?").run(id);db.prepare('DELETE FROM delivery_sessions WHERE delivery_id=?').run(id);return payload(get(id),{admin:true});});},
  deleteAsset(id,assetId){return store.transaction(()=>{const delivery=get(id);if(!active(delivery))throw error(404,'Teslim bulunamadı.');const file=db.prepare('SELECT storage_name AS storageName FROM delivery_assets WHERE id=? AND delivery_id=?').get(assetId,id);if(!file)throw error(404,'Dosya bulunamadı.');db.prepare('DELETE FROM delivery_assets WHERE id=? AND delivery_id=?').run(assetId,id);db.prepare("UPDATE deliveries SET version=version+1,status='pending' WHERE id=?").run(id);db.prepare('DELETE FROM delivery_sessions WHERE delivery_id=?').run(id);return {storageName:file.storageName,delivery:payload(get(id),{admin:true})};});},
  findToken(token,now=Date.now()){
   if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
   const tokenHash=hash(token),row=db.prepare('SELECT id,NULL AS accessExpiresAt FROM deliveries WHERE token_hash=? UNION ALL SELECT delivery_id AS id,expires_at AS accessExpiresAt FROM delivery_access_sessions WHERE token_hash=? AND expires_at>? LIMIT 1').get(tokenHash,tokenHash,now);
   const delivery=row?get(row.id):null;
   return active(delivery,now)?{...delivery,...(row.accessExpiresAt?{accessExpiresAt:row.accessExpiresAt}:{})}:null;
  },
  lookup(orderNumber,accessCode,now=Date.now()){
   if(typeof orderNumber!=='string'||typeof accessCode!=='string'||orderNumber.length>64||accessCode.length>80)return null;
   const normalizedOrder=orderNumber.trim().toUpperCase(),normalizedCode=accessCode.replaceAll('-','').trim().toUpperCase();
   if(!/^ORD-\d{4}-[A-F0-9]{10}$/.test(normalizedOrder)||!/^[A-F0-9]{32}$/.test(normalizedCode))return null;
   return store.transaction(()=>{
    const row=db.prepare('SELECT lead_id AS leadId,access_code_hash AS accessCodeHash FROM delivery_orders WHERE order_number=?').get(normalizedOrder);
    const expected=Buffer.from(row?.accessCodeHash||'0'.repeat(64),'hex'),actual=Buffer.from(hash(normalizedCode),'hex');
    if(!timingSafeEqual(expected,actual)||!row)return null;
    const latest=db.prepare('SELECT id FROM deliveries WHERE lead_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1').get(row.leadId),delivery=latest?get(latest.id):null;
    if(!active(delivery,now))return null;
    db.prepare('DELETE FROM delivery_access_sessions WHERE expires_at<=?').run(now);
    const accessToken=randomBytes(32).toString('hex'),expiresAt=Math.min(now+3600000,delivery.expiresAt);
    db.prepare('INSERT INTO delivery_access_sessions(token_hash,delivery_id,expires_at) VALUES(?,?,?)').run(hash(accessToken),delivery.id,expiresAt);
    db.prepare('DELETE FROM delivery_access_sessions WHERE token_hash IN(SELECT token_hash FROM delivery_access_sessions WHERE delivery_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 100)').run(delivery.id);
    return {accessToken,delivery:payload(delivery)};
   });
  },
  newMediaSession(delivery,now=Date.now()){return store.transaction(()=>{const current=get(delivery.id);if(!active(current,now)||current.version!==delivery.version||delivery.accessExpiresAt<=now)throw error(409,'Teslim güncellendi veya oturum sona erdi. Sayfayı yenileyin.');db.prepare('DELETE FROM delivery_sessions WHERE expires_at<=?').run(now);const token=randomBytes(32).toString('hex'),expiresAt=Math.min(now+3600000,current.expiresAt,delivery.accessExpiresAt??Infinity);db.prepare('INSERT INTO delivery_sessions(token_hash,delivery_id,version,expires_at) VALUES(?,?,?,?)').run(hash(token),current.id,current.version,expiresAt);db.prepare('DELETE FROM delivery_sessions WHERE token_hash IN(SELECT token_hash FROM delivery_sessions WHERE delivery_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 100)').run(current.id);return {token,maxAge:Math.max(0,Math.floor((expiresAt-now)/1000))};});},
  mediaAsset(deliveryId,assetId,token,now=Date.now()){if(!validId(deliveryId)||!validId(assetId)||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;const delivery=get(deliveryId);if(!active(delivery,now))return null;const session=db.prepare('SELECT 1 FROM delivery_sessions WHERE token_hash=? AND delivery_id=? AND version=? AND expires_at>?').get(hash(token),deliveryId,delivery.version,now);if(!session)return null;return db.prepare('SELECT id,storage_name AS storageName,mime_type AS mimeType,size FROM delivery_assets WHERE id=? AND delivery_id=?').get(assetId,deliveryId)||null;},
  feedback(delivery,{action,message='',version,confirmation,requestId,notes,extraFeeAccepted=false},now=Date.now()){
   if(!['revision','approve'].includes(action)||typeof message!=='string'||message.length>2000||!Number.isSafeInteger(version)||version<1||(requestId!==undefined&&!validRequestId(requestId))||typeof extraFeeAccepted!=='boolean')throw error(400,'Geri bildirim alanlarını kontrol edin.');
   return store.transaction(()=>{
    const current=get(delivery.id);if(!active(current,now))throw error(404,'Teslim bağlantısı bulunamadı veya süresi doldu.');
    const normalizedNotes=action==='revision'?validateNotes(notes):[];
    if(action==='revision'&&(!message.trim()&&!normalizedNotes.length||message.length+normalizedNotes.reduce((sum,note)=>sum+note.message.length,0)>12000))throw error(400,'Revizyon açıklaması veya zaman kodlu not ekleyin; toplam metin 12.000 karakteri geçmemeli.');
    const stableRequestId=requestId||'legacy:'+current.id+':'+version;
    const inputHash=hash(JSON.stringify({deliveryId:current.id,version,message:message.trim(),notes:normalizedNotes,extraFeeAccepted}));
    if(action==='revision'){
     const duplicate=db.prepare('SELECT input_hash AS inputHash FROM delivery_revision_rounds WHERE lead_id=? AND request_id=?').get(current.leadId,stableRequestId);
     if(duplicate){if(duplicate.inputHash!==inputHash)throw error(409,'Bu gönderim kimliği farklı bir revizyonda kullanıldı.');return payload(current);}
    }
    if(current.version!==version)throw error(409,'Dosyalar güncellendi. Son sürümü görüntüleyip tekrar deneyin.');
    if(current.status==='approved'){if(action==='approve')return payload(current);throw error(409,'Bu sürüm onaylandı. Yeni revizyon için ajansınızla iletişime geçin.');}
    if(action==='approve'&&(confirmation!==true||!assets(current.id).length))throw error(400,'Onaylamak için dosyaları inceleyip onay kutusunu işaretleyin.');
    let roundNumber=null,feeCents=0;
    const feedbackId=randomUUID();
    if(action==='revision'){
     const currentAssets=new Map(assets(current.id).map(file=>[file.id,file]));
     if(normalizedNotes.some(note=>!currentAssets.get(note.assetId)?.mimeType.startsWith('video/')))throw error(400,'Zaman kodlu not yalnız bu teslimdeki bir videoya eklenebilir.');
     if(db.prepare('SELECT 1 FROM delivery_revision_rounds WHERE delivery_id=? AND version=?').get(current.id,version))throw error(409,'Bu sürüm için revizyonunuz alındı. Ajans yeni sürümü yüklediğinde sonraki turu gönderebilirsiniz.');
     const budget=revisions(current.leadId);roundNumber=budget.used+1;feeCents=budget.nextFeeCents;
     if(feeCents&&(!requestId||extraFeeAccepted!==true))throw error(400,'Üç revizyon hakkı kullanıldı. Yeni tur için 1.000 TL ek revizyon ücretini açıkça kabul edin.');
     db.prepare('INSERT INTO delivery_revision_rounds(id,lead_id,delivery_id,version,request_id,input_hash,round_number,fee_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(feedbackId,current.leadId,current.id,version,stableRequestId,inputHash,roundNumber,feeCents,new Date(now).toISOString());
    }
    db.prepare('INSERT INTO delivery_feedback(id,delivery_id,version,action,message,created_at,notes_json,round_number,fee_cents,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(feedbackId,current.id,version,action,message.trim(),new Date(now).toISOString(),JSON.stringify(normalizedNotes),roundNumber,feeCents,action==='revision'?stableRequestId:null);
    db.prepare('UPDATE deliveries SET status=? WHERE id=? AND version=?').run(action==='approve'?'approved':'revision_requested',current.id,version);return payload(get(current.id));
   });
  }
 };
}
