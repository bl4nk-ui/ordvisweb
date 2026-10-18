import {randomBytes,randomUUID,createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
function error(status,message){const err=new Error(message);err.status=status;return err;}
const validId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
export function initDeliverySchema(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,revoked_at INTEGER,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS deliveries_lead ON deliveries(lead_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS delivery_assets(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,storage_name TEXT NOT NULL UNIQUE,mime_type TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS delivery_assets_delivery ON delivery_assets(delivery_id);
 CREATE TABLE IF NOT EXISTS delivery_feedback(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS delivery_feedback_delivery ON delivery_feedback(delivery_id,created_at);
 CREATE TABLE IF NOT EXISTS delivery_sessions(token_hash TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,version INTEGER NOT NULL,expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS delivery_sessions_delivery ON delivery_sessions(delivery_id);`);}
export function cleanupDeliveryLead(store,leadId){
 const files=store.db.prepare('SELECT a.storage_name AS storageName FROM delivery_assets a JOIN deliveries d ON d.id=a.delivery_id WHERE d.lead_id=?').all(leadId).map(row=>row.storageName);
 for(const table of ['delivery_sessions','delivery_feedback','delivery_assets'])store.db.prepare(`DELETE FROM ${table} WHERE delivery_id IN(SELECT id FROM deliveries WHERE lead_id=?)`).run(leadId);
 store.db.prepare('DELETE FROM deliveries WHERE lead_id=?').run(leadId);return files;
}
export function createDeliveryStore(store){
 const db=store.db;
 const get=id=>db.prepare('SELECT id,lead_id AS leadId,title,description,expires_at AS expiresAt,revoked_at AS revokedAt,version,status,created_at AS createdAt FROM deliveries WHERE id=?').get(id)||null;
 const active=(delivery,now=Date.now())=>Boolean(delivery&&delivery.revokedAt===null&&delivery.expiresAt>now&&store.getLead(delivery.leadId));
 const assets=id=>db.prepare('SELECT id,storage_name AS storageName,mime_type AS mimeType,size,created_at AS createdAt FROM delivery_assets WHERE delivery_id=? ORDER BY created_at,id').all(id);
 function payload(delivery,{admin=false}={}){
  const files=assets(delivery.id).map(({storageName,...file})=>({...file,url:admin?`/api/admin/deliveries/${delivery.id}/files/${file.id}`:`/api/delivery/media/${delivery.id}/${file.id}`}));
  const feedback=db.prepare('SELECT id,version,action,message,created_at AS createdAt FROM delivery_feedback WHERE delivery_id=? ORDER BY created_at DESC,id DESC LIMIT 500').all(delivery.id).reverse();
  const result={id:delivery.id,title:delivery.title,description:delivery.description,version:delivery.version,status:delivery.status,expiresAt:new Date(delivery.expiresAt).toISOString(),files,feedback};
  if(admin)Object.assign(result,{leadId:delivery.leadId,createdAt:delivery.createdAt,revokedAt:delivery.revokedAt?new Date(delivery.revokedAt).toISOString():null});return result;
 }
 return {
  get,active,assets,payload,
  list(leadId){return db.prepare('SELECT id FROM deliveries WHERE lead_id=? ORDER BY created_at DESC,id DESC').all(leadId).map(row=>payload(get(row.id),{admin:true}));},
  create(leadId,{title,description='',expiresInDays=7},now=Date.now()){
   if(typeof title!=='string'||!title.trim()||title.length>150||typeof description!=='string'||description.length>2000||!Number.isInteger(expiresInDays)||expiresInDays<1||expiresInDays>30)throw error(400,'Teslim alanlarını kontrol edin.');
   return store.transaction(()=>{if(!store.getLead(leadId))throw error(404,'Talep bulunamadı.');
    const id=randomUUID(),token=randomBytes(32).toString('hex');
    db.prepare('UPDATE deliveries SET revoked_at=? WHERE lead_id=? AND revoked_at IS NULL').run(now,leadId);
    db.prepare('DELETE FROM delivery_sessions WHERE delivery_id IN(SELECT id FROM deliveries WHERE lead_id=?)').run(leadId);
    db.prepare('INSERT INTO deliveries(id,lead_id,title,description,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id,leadId,title,description,hash(token),now+expiresInDays*86400000,new Date(now).toISOString());
    return {delivery:payload(get(id),{admin:true}),sharePath:'/teslim#'+token};
   });
  },
  revoke(id,now=Date.now()){return store.transaction(()=>{if(!get(id))return false;db.prepare('UPDATE deliveries SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now,id);db.prepare('DELETE FROM delivery_sessions WHERE delivery_id=?').run(id);return true;});},
  addAsset(id,file,now=Date.now()){return store.transaction(()=>{const delivery=get(id);if(!active(delivery,now))throw error(409,'Teslim bağlantısı etkin değil. Yeni bağlantı oluşturun.');if(assets(id).length>=20)throw error(409,'Bir teslimde en fazla 20 dosya bulunabilir.');
   db.prepare('INSERT INTO delivery_assets(id,delivery_id,storage_name,mime_type,size,created_at) VALUES(?,?,?,?,?,?)').run(file.id,id,file.storageName,file.mimeType,file.size,new Date(now).toISOString());
   db.prepare("UPDATE deliveries SET version=version+1,status='pending' WHERE id=?").run(id);db.prepare('DELETE FROM delivery_sessions WHERE delivery_id=?').run(id);return payload(get(id),{admin:true});});},
  deleteAsset(id,assetId){return store.transaction(()=>{if(!get(id))throw error(404,'Teslim bulunamadı.');const file=db.prepare('SELECT storage_name AS storageName FROM delivery_assets WHERE id=? AND delivery_id=?').get(assetId,id);if(!file)throw error(404,'Dosya bulunamadı.');db.prepare('DELETE FROM delivery_assets WHERE id=? AND delivery_id=?').run(assetId,id);db.prepare("UPDATE deliveries SET version=version+1,status='pending' WHERE id=?").run(id);db.prepare('DELETE FROM delivery_sessions WHERE delivery_id=?').run(id);return {storageName:file.storageName,delivery:payload(get(id),{admin:true})};});},
  findToken(token,now=Date.now()){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;const row=db.prepare('SELECT id FROM deliveries WHERE token_hash=?').get(hash(token));const delivery=row?get(row.id):null;return active(delivery,now)?delivery:null;},
  newMediaSession(delivery,now=Date.now()){return store.transaction(()=>{const current=get(delivery.id);if(!active(current,now)||current.version!==delivery.version)throw error(409,'Teslim güncellendi. Sayfayı yenileyin.');db.prepare('DELETE FROM delivery_sessions WHERE expires_at<=?').run(now);const token=randomBytes(32).toString('hex'),expiresAt=Math.min(now+3600000,current.expiresAt);db.prepare('INSERT INTO delivery_sessions(token_hash,delivery_id,version,expires_at) VALUES(?,?,?,?)').run(hash(token),current.id,current.version,expiresAt);db.prepare('DELETE FROM delivery_sessions WHERE token_hash IN(SELECT token_hash FROM delivery_sessions WHERE delivery_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 100)').run(current.id);return {token,maxAge:Math.max(0,Math.floor((expiresAt-now)/1000))};});},
  mediaAsset(deliveryId,assetId,token,now=Date.now()){if(!validId(deliveryId)||!validId(assetId)||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;const delivery=get(deliveryId);if(!active(delivery,now))return null;const session=db.prepare('SELECT 1 FROM delivery_sessions WHERE token_hash=? AND delivery_id=? AND version=? AND expires_at>?').get(hash(token),deliveryId,delivery.version,now);if(!session)return null;return db.prepare('SELECT id,storage_name AS storageName,mime_type AS mimeType,size FROM delivery_assets WHERE id=? AND delivery_id=?').get(assetId,deliveryId)||null;},
  feedback(delivery,{action,message='',version,confirmation},now=Date.now()){if(!['revision','approve'].includes(action)||typeof message!=='string'||message.length>2000||(action==='revision'&&!message.trim())||!Number.isSafeInteger(version)||version<1)throw error(400,'Geri bildirim alanlarını kontrol edin.');return store.transaction(()=>{const current=get(delivery.id);if(!active(current,now))throw error(404,'Teslim bağlantısı bulunamadı veya süresi doldu.');if(current.version!==version)throw error(409,'Dosyalar güncellendi. Son sürümü görüntüleyip tekrar deneyin.');
   if(current.status==='approved'){if(action==='approve')return payload(current);throw error(409,'Bu sürüm onaylandı. Yeni revizyon için ajansınızla iletişime geçin.');}
   if(action==='approve'&&(confirmation!==true||!assets(current.id).length))throw error(400,'Onaylamak için dosyaları inceleyip onay kutusunu işaretleyin.');
   db.prepare('INSERT INTO delivery_feedback(id,delivery_id,version,action,message,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),current.id,version,action,message,new Date(now).toISOString());
   db.prepare('UPDATE deliveries SET status=? WHERE id=? AND version=?').run(action==='approve'?'approved':'revision_requested',current.id,version);return payload(get(current.id));
  });}
 };
}
