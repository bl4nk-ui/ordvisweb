import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
import {promisify} from 'node:util';
import {verifyTotp,normalizeRecoveryCode,hashRecoveryCode} from './mfa.mjs';
import {MAX_PAYMENT_RECEIVED_CENTS} from './lead-payment.mjs';
import {initStudioSchema,createStudioStore} from './studio-store.mjs';
import {initDeliverySchema,cleanupDeliveryLead} from './delivery-store.mjs';
import {removeMedia} from './media-files.mjs';
const scrypt=promisify(scryptCallback);
const hashOptions={N:131072,r:8,p:1,maxmem:256*1024*1024};
const dummySalt=randomBytes(16).toString('hex');
export class Store {
 constructor({dataDir=process.env.DATA_DIR||'.data'}={}){
  this.dataDir=resolve(dataDir);mkdirSync(this.dataDir,{recursive:true,mode:0o700});
  this.dbPath=join(this.dataDir,'ordvis.sqlite');this.db=new DatabaseSync(this.dbPath);
  try{chmodSync(this.dbPath,0o600);}catch(error){if(process.platform!=='win32')throw error;}
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,brand TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,plan TEXT NOT NULL,brief TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','archived','completed')),notes TEXT NOT NULL DEFAULT '',consent_at TEXT NOT NULL,request_id TEXT UNIQUE,payment_received_cents INTEGER CHECK(payment_received_cents IS NULL OR (typeof(payment_received_cents)='integer' AND payment_received_cents BETWEEN 1 AND 99999999999)),completed_at TEXT,CHECK(status!='completed' OR (payment_received_cents IS NOT NULL AND completed_at IS NOT NULL)));
   CREATE INDEX IF NOT EXISTS leads_created_at ON leads(created_at DESC);
   CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,event TEXT NOT NULL,source TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_settings (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,next_run_at INTEGER,retry_at INTEGER,last_run_at INTEGER,last_error TEXT,api_key_encrypted TEXT,model TEXT NOT NULL DEFAULT 'llama-3.3-70b-versatile',budget_start INTEGER NOT NULL DEFAULT 0,budget_used INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,lease_owner TEXT);
   INSERT OR IGNORE INTO automation_settings(id) VALUES(1);
   CREATE TABLE IF NOT EXISTS ai_summaries (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL UNIQUE,summary TEXT NOT NULL,needs_json TEXT NOT NULL,next_step TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ai_jobs (lead_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,status TEXT NOT NULL DEFAULT 'retry');
   CREATE TABLE IF NOT EXISTS ai_attempts (id INTEGER PRIMARY KEY,attempted_at INTEGER NOT NULL);`);
  this.migrateLeadLifecycle();
  const leadColumns=new Set(this.db.prepare('PRAGMA table_info(leads)').all().map(column=>column.name));
  if(!leadColumns.has('brief_details'))this.db.exec('ALTER TABLE leads ADD COLUMN brief_details TEXT');
  initStudioSchema(this);this.studio=createStudioStore(this);initDeliverySchema(this);
  const columns=new Set(this.db.prepare('PRAGMA table_info(admin)').all().map(column=>column.name));
  for(const [name,type] of [['password_n','INTEGER NOT NULL DEFAULT 32768'],['mfa_secret','TEXT'],['mfa_last_counter','INTEGER NOT NULL DEFAULT -1'],['auth_version','INTEGER NOT NULL DEFAULT 1'],['recovery_hashes',"TEXT NOT NULL DEFAULT '[]'"]])if(!columns.has(name))this.db.exec(`ALTER TABLE admin ADD COLUMN ${name} ${type}`);
  if(process.platform!=='win32'&&(statSync(this.dataDir).mode&0o077))throw new Error('DATA_DIR yalnız sunucu hesabına açık olmalı (izin:700).');
  const keyPath=join(this.dataDir,'mfa.key');
  if(!existsSync(keyPath)){
   if(this.db.prepare('SELECT 1 FROM admin WHERE mfa_secret IS NOT NULL').get()||this.db.prepare('SELECT 1 FROM automation_settings WHERE api_key_encrypted IS NOT NULL').get())throw new Error('MFA anahtar dosyası eksik. mfa.key dosyasını güvenli yedeğinizden geri yükleyin; yeni anahtar oluşturulmadı.');
   try{writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600,flush:true});}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  this.mfaKey=readFileSync(keyPath);if(this.mfaKey.length!==32)throw new Error('MFA anahtar dosyası geçersiz.');
  if(process.platform!=='win32'&&(statSync(keyPath).mode&0o077))throw new Error('mfa.key yalnız sunucu hesabına açık olmalı (izin:600).');
 }
 migrateLeadLifecycle(){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const columns=new Set(this.db.prepare('PRAGMA table_info(leads)').all().map(column=>column.name));
   const schema=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leads'").get().sql;
   if(!columns.has('payment_received_cents')||!columns.has('completed_at')||!schema.includes("'completed'")){
    // Rebuild the old CHECK constraint inside one transaction. Existing IDs,
    // timestamps, request deduplication keys and archived jobs stay intact.
    this.db.exec(`CREATE TABLE leads_lifecycle_upgrade (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,brand TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,plan TEXT NOT NULL,brief TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','archived','completed')),notes TEXT NOT NULL DEFAULT '',consent_at TEXT NOT NULL,request_id TEXT UNIQUE,payment_received_cents INTEGER CHECK(payment_received_cents IS NULL OR (typeof(payment_received_cents)='integer' AND payment_received_cents BETWEEN 1 AND 99999999999)),completed_at TEXT,CHECK(status!='completed' OR (payment_received_cents IS NOT NULL AND completed_at IS NOT NULL)));
     INSERT INTO leads_lifecycle_upgrade(id,created_at,brand,name,email,phone,plan,brief,status,notes,consent_at,request_id,payment_received_cents,completed_at)
      SELECT id,created_at,brand,name,email,phone,plan,brief,status,notes,consent_at,request_id,${columns.has('payment_received_cents')?'payment_received_cents':'NULL'},${columns.has('completed_at')?'completed_at':'NULL'} FROM leads;
     DROP TABLE leads;
     ALTER TABLE leads_lifecycle_upgrade RENAME TO leads;
     CREATE INDEX leads_created_at ON leads(created_at DESC);`);
   }
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 hasAdmin(){return Boolean(this.db.prepare('SELECT 1 FROM admin WHERE id=1').get());}
 async initializeAdmin(username,password,{expectedVersion}={}){
  if(typeof username!=='string'||!/^[-\p{L}\p{N}_.@]{3,80}$/u.test(username))throw new Error('Kullanıcı adı 3–80 karakter olmalı; harf, rakam, nokta, tire, @ veya alt çizgi kullanın.');
  if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('Parola 12–128 karakter olmalı.');
  const version=expectedVersion??(this.getAdminState()?.authVersion??0);
  const salt=randomBytes(16).toString('hex');const hash=await scrypt(password,salt,64,hashOptions);
  if((this.getAdminState()?.authVersion??0)!==version)throw new Error('Hesap kurulum sırasında değişti. İşlemi yeniden başlatın.');
  const result=this.db.prepare('INSERT INTO admin(id,username,salt,password_hash,password_n) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,password_hash=excluded.password_hash,password_n=excluded.password_n,auth_version=admin.auth_version+1 WHERE admin.auth_version=?').run(username,salt,hash.toString('hex'),hashOptions.N,version);
  if(!result.changes)throw new Error('Hesap değişti. İşlemi yeniden başlatın.');
 }
 async verifyAdmin(username,password){
  const admin=this.db.prepare('SELECT username,salt,password_hash,password_n,auth_version FROM admin WHERE id=1').get();
  const cost=admin?.password_n??hashOptions.N;if(![32768,131072].includes(cost))return false;
  const hash=await scrypt(password,admin?.salt||dummySalt,64,{...hashOptions,N:cost});
  if(!admin)return false;
  const expected=Buffer.from(admin.password_hash,'hex');
  if(expected.length!==hash.length||!timingSafeEqual(hash,expected)||username!==admin.username)return false;
  if(cost<hashOptions.N){
   const salt=randomBytes(16).toString('hex'),stronger=await scrypt(password,salt,64,hashOptions);
   const result=this.db.prepare('UPDATE admin SET salt=?,password_hash=?,password_n=? WHERE id=1 AND password_hash=? AND auth_version=?').run(salt,stronger.toString('hex'),hashOptions.N,admin.password_hash,admin.auth_version);
   if(!result.changes)return false;
  }
  return true;
 }

 getAdminState(){const row=this.db.prepare('SELECT username,auth_version AS authVersion,mfa_secret,recovery_hashes FROM admin WHERE id=1').get();return row?{username:row.username,authVersion:row.authVersion,mfaEnabled:Boolean(row.mfa_secret),recoveryCodesRemaining:JSON.parse(row.recovery_hashes).length}:null;}
 encryptSecret(secret,purpose='totp'){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.mfaKey,iv);cipher.setAAD(Buffer.from('ordvis-'+purpose+'-v1'));const body=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return ['v1',iv.toString('hex'),cipher.getAuthTag().toString('hex'),body.toString('hex')].join('.');}
 decryptSecret(value,purpose='totp'){const [version,iv,tag,body]=value.split('.');if(version!=='v1')throw new Error('MFA verisi geçersiz.');const decipher=createDecipheriv('aes-256-gcm',this.mfaKey,Buffer.from(iv,'hex'));decipher.setAAD(Buffer.from('ordvis-'+purpose+'-v1'));decipher.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(body,'hex')),decipher.final()]).toString('utf8');}
 enableMfa(secret,{counter,recoveryCodes,expectedVersion}={}){
  if(!Number.isInteger(counter)||!Array.isArray(recoveryCodes))throw new Error('Geçersiz MFA kurulumu.');
  return this.db.prepare('UPDATE admin SET mfa_secret=?,mfa_last_counter=?,recovery_hashes=?,auth_version=auth_version+1 WHERE id=1 AND auth_version=?').run(this.encryptSecret(secret),counter,JSON.stringify(recoveryCodes.map(hashRecoveryCode)),expectedVersion).changes>0;
 }
 verifyMfa(code,{now=Date.now()}={}){
  const admin=this.db.prepare('SELECT mfa_secret,mfa_last_counter,recovery_hashes FROM admin WHERE id=1').get();if(!admin?.mfa_secret)return false;
  const normalized=normalizeRecoveryCode(code);
  if(/^[A-F0-9]{24}$/.test(normalized)){
   const hashes=JSON.parse(admin.recovery_hashes),hash=hashRecoveryCode(normalized),index=hashes.findIndex(value=>timingSafeEqual(Buffer.from(value),Buffer.from(hash)));
   if(index===-1)return false;hashes.splice(index,1);
   return this.db.prepare('UPDATE admin SET recovery_hashes=? WHERE id=1 AND recovery_hashes=?').run(JSON.stringify(hashes),admin.recovery_hashes).changes>0;
  }
  const counter=verifyTotp(this.decryptSecret(admin.mfa_secret),code,{now,lastCounter:admin.mfa_last_counter});if(counter===null)return false;
  return this.db.prepare('UPDATE admin SET mfa_last_counter=? WHERE id=1 AND mfa_last_counter<?').run(counter,counter).changes>0;
 }
 replaceRecoveryCodes(codes,expectedVersion){return this.db.prepare('UPDATE admin SET recovery_hashes=?,auth_version=auth_version+1 WHERE id=1 AND auth_version=?').run(JSON.stringify(codes.map(hashRecoveryCode)),expectedVersion).changes>0;}
 sourceKey(value){return createHmac('sha256',this.mfaKey).update(value).digest('hex');}
 checkAuthLimit(key,max,windowMs,{consume=false,now=Date.now()}={}){
  this.db.prepare('DELETE FROM auth_limits WHERE expires<=?').run(now);
  const existing=this.db.prepare('SELECT count,expires FROM auth_limits WHERE key=?').get(key);
  if(existing&&existing.count>=max)return Math.ceil((existing.expires-now)/1000);
  if(consume)this.db.prepare('INSERT INTO auth_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+windowMs);
  return 0;
 }
 resetAuthLimit(key){this.db.prepare('DELETE FROM auth_limits WHERE key=?').run(key);}
 audit(event,source=''){this.db.prepare('INSERT INTO security_events(created_at,event,source) VALUES(?,?,?)').run(new Date().toISOString(),event,source);this.db.prepare('DELETE FROM security_events WHERE created_at<? OR id<(SELECT MAX(id)-1000 FROM security_events)').run(new Date(Date.now()-30*86400000).toISOString());}
 securityEvents(){return this.db.prepare('SELECT created_at AS createdAt,event FROM security_events ORDER BY id DESC LIMIT 20').all();}

 getAutomationSettings(){const row=this.db.prepare('SELECT enabled,next_run_at AS nextRunAt,retry_at AS retryAt,last_run_at AS lastRunAt,last_error AS lastError,model,budget_start AS budgetStart,budget_used AS budgetUsed,generation,lease_until AS leaseUntil,lease_owner AS leaseOwner FROM automation_settings WHERE id=1').get();return {...row,enabled:Boolean(row.enabled)};}
 updateAutomationSettings(patch){const columns={enabled:'enabled',nextRunAt:'next_run_at',retryAt:'retry_at',lastRunAt:'last_run_at',lastError:'last_error',model:'model',budgetStart:'budget_start',budgetUsed:'budget_used',generation:'generation',leaseUntil:'lease_until',leaseOwner:'lease_owner'};const entries=Object.entries(patch).filter(([name])=>Object.hasOwn(columns,name));if(entries.length)this.db.prepare('UPDATE automation_settings SET '+entries.map(([name])=>columns[name]+'=?').join(',')+' WHERE id=1').run(...entries.map(([name,value])=>name==='enabled'?Number(value):value));return this.getAutomationSettings();}
 getAiCredentials(){const row=this.db.prepare('SELECT api_key_encrypted,model FROM automation_settings WHERE id=1').get();return {apiKey:row.api_key_encrypted?this.decryptSecret(row.api_key_encrypted,'groq-api-key'):null,model:row.model};}
 setAiKey(key,{expectedVersion}={}){if(typeof key!=='string'||key.length<20||key.length>500||/\s/.test(key))throw new Error('Groq anahtarı geçersiz.');const encrypted=this.encryptSecret(key,'groq-api-key');const result=expectedVersion===undefined?this.db.prepare('UPDATE automation_settings SET api_key_encrypted=?,last_error=NULL WHERE id=1').run(encrypted):this.db.prepare('UPDATE automation_settings SET api_key_encrypted=?,last_error=NULL WHERE id=1 AND EXISTS(SELECT 1 FROM admin WHERE id=1 AND auth_version=?)').run(encrypted,expectedVersion);if(!result.changes)throw new Error('Hesap güvenlik ayarları değişti. Kurulumu yeniden başlatın.');}
 isAiLeadEligible(id){return Boolean(this.db.prepare("SELECT 1 FROM leads WHERE id=? AND status IN ('new','contacted')").get(id));}
 pendingAiLeads(limit=5){return this.db.prepare("SELECT l.id,l.name,l.brief FROM leads l LEFT JOIN ai_summaries s ON s.lead_id=l.id LEFT JOIN ai_jobs j ON j.lead_id=l.id WHERE l.status IN ('new','contacted') AND s.lead_id IS NULL AND (j.status IS NULL OR j.status!='failed') ORDER BY l.created_at,l.id LIMIT ?").all(limit);}
 aiPendingCount(){return this.db.prepare("SELECT COUNT(*) AS count FROM leads l LEFT JOIN ai_summaries s ON s.lead_id=l.id LEFT JOIN ai_jobs j ON j.lead_id=l.id WHERE l.status IN ('new','contacted') AND s.lead_id IS NULL AND (j.status IS NULL OR j.status!='failed')").get().count;}
 aiFailedCount(){return this.db.prepare("SELECT COUNT(*) AS count FROM ai_jobs j JOIN leads l ON l.id=j.lead_id WHERE j.status='failed' AND l.status IN ('new','contacted')").get().count;}
 listAiSummaries(){return this.db.prepare('SELECT s.id,s.lead_id AS leadId,l.name,s.created_at AS createdAt,s.summary,s.needs_json AS needs,s.next_step AS nextStep FROM ai_summaries s JOIN leads l ON l.id=s.lead_id ORDER BY s.created_at DESC,s.id DESC LIMIT 100').all().map(row=>({...row,needs:JSON.parse(row.needs)}));}
 recordAiSuccess(lead,result,now=Date.now()){
  return this.transaction(()=>{
   if(!this.isAiLeadEligible(lead.id))return false;
   if(!result||typeof result.summary!=='string'||!result.summary.trim()||result.summary.length>2000||typeof result.nextStep!=='string'||!result.nextStep.trim()||result.nextStep.length>2000||!Array.isArray(result.needs)||result.needs.length>6||result.needs.some(value=>typeof value!=='string'||!value.trim()||value.length>2000))throw new Error('Geçersiz özet biçimi.');
   const resultRow=this.db.prepare('INSERT OR IGNORE INTO ai_summaries(id,lead_id,summary,needs_json,next_step,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),lead.id,result.summary,JSON.stringify(result.needs),result.nextStep,new Date(now).toISOString());
   this.db.prepare("INSERT INTO ai_jobs(lead_id,status) VALUES(?,'complete') ON CONFLICT(lead_id) DO UPDATE SET status='complete',error_code=NULL").run(lead.id);
   return resultRow.changes>0;
  });
 }
 recordAiFailure(lead,code,now=Date.now()){
  if(!['INVALID_INPUT','INVALID_OUTPUT'].includes(code))return false;
  return this.transaction(()=>{
   if(!this.isAiLeadEligible(lead.id)||this.db.prepare('SELECT 1 FROM ai_summaries WHERE lead_id=?').get(lead.id))return false;
   this.db.prepare("INSERT INTO ai_jobs(lead_id,attempts,error_code,status) VALUES(?,1,?,'retry') ON CONFLICT(lead_id) DO UPDATE SET attempts=attempts+1,error_code=excluded.error_code,status=CASE WHEN attempts+1>=3 THEN 'failed' ELSE 'retry' END").run(lead.id,code);
   return true;
  });
 }
 reserveAiAttempt(now,max=5){this.db.prepare('DELETE FROM ai_attempts WHERE attempted_at<=?').run(now-3600000);const row=this.db.prepare('SELECT COUNT(*) AS count,MIN(attempted_at) AS oldest FROM ai_attempts').get();if(row.count>=max)return row.oldest+3600000;this.db.prepare('INSERT INTO ai_attempts(attempted_at) VALUES(?)').run(now);return 0;}

 claimAiLease(owner,now){return this.db.prepare('UPDATE automation_settings SET lease_owner=?,lease_until=? WHERE id=1 AND enabled=1 AND lease_until<=?').run(owner,now+120000,now).changes>0;}
 releaseAiLease(owner){this.db.prepare('UPDATE automation_settings SET lease_owner=NULL,lease_until=0 WHERE id=1 AND lease_owner=?').run(owner);}
 findRequest(requestId){return requestId?this.db.prepare('SELECT id FROM leads WHERE request_id=?').get(requestId)?.id:null;}
 createLead(lead){
  if(lead.requestId){const existing=this.db.prepare('SELECT id FROM leads WHERE request_id=?').get(lead.requestId);if(existing)return {id:existing.id,duplicate:true};}
  const id=randomUUID(),now=new Date().toISOString();
  this.db.prepare('INSERT INTO leads(id,created_at,brand,name,email,phone,plan,brief,consent_at,request_id,brief_details) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,now,lead.brand,lead.name,lead.email,lead.phone,lead.plan,lead.brief,now,lead.requestId||null,lead.briefDetails?JSON.stringify(lead.briefDetails):null);
  return {id,duplicate:false};
 }
 decorateLead(row){if(!row)return null;const {briefDetails,...lead}=row;return {...lead,briefDetails:briefDetails?JSON.parse(briefDetails):null,tracking:this.studio.tracking(lead)};}
 getLead(id){return this.decorateLead(this.db.prepare('SELECT id,created_at AS createdAt,brand,name,email,phone,plan,brief,status,notes,consent_at AS consentAt,payment_received_cents AS paymentReceivedCents,completed_at AS completedAt,brief_details AS briefDetails FROM leads WHERE id=?').get(id));}
 listLeads(){return this.db.prepare('SELECT id,created_at AS createdAt,brand,name,email,phone,plan,brief,status,notes,consent_at AS consentAt,payment_received_cents AS paymentReceivedCents,completed_at AS completedAt,brief_details AS briefDetails FROM leads ORDER BY created_at DESC').all().map(row=>this.decorateLead(row));}
 counts(){const counts={new:0,contacted:0,archived:0,completed:0,total:0};for(const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM leads GROUP BY status').all()){counts[row.status]=row.count;counts.total+=row.count;}return counts;}
 updateLead(id,{status,notes,paymentReceivedCents}){
  if(!['new','contacted','archived','completed'].includes(status)||typeof notes!=='string'||notes.length>4000)throw new TypeError('Geçersiz talep durumu veya not.');
  if(status==='completed'){
   if(!Number.isSafeInteger(paymentReceivedCents)||paymentReceivedCents<=0||paymentReceivedCents>MAX_PAYMENT_RECEIVED_CENTS)throw new TypeError('Tamamlanan iş için geçerli alınan ödeme gerekiyor.');
   return this.db.prepare('UPDATE leads SET status=?,notes=?,payment_received_cents=?,completed_at=COALESCE(completed_at,?) WHERE id=?').run(status,notes,paymentReceivedCents,new Date().toISOString(),id).changes>0;
  }
  return this.db.prepare('UPDATE leads SET status=?,notes=? WHERE id=?').run(status,notes,id).changes>0;
 }
 deleteLead(id){
  let files=[];const deleted=this.transaction(()=>{
   if(!this.getLead(id))return false;
   this.db.prepare('DELETE FROM ai_summaries WHERE lead_id=?').run(id);
   this.db.prepare('DELETE FROM ai_jobs WHERE lead_id=?').run(id);
   this.studio.cleanupLead(id);files=cleanupDeliveryLead(this,id);
   return this.db.prepare('DELETE FROM leads WHERE id=?').run(id).changes>0;
  });
  // Metadata is removed in the same transaction. Physical cleanup cannot bring
  // back a deleted record and must never run before the transaction commits.
  if(deleted)for(const name of files)void removeMedia(this.dataDir,name).catch(()=>{});
  return deleted;
 }
 transaction(run){this.db.exec('BEGIN IMMEDIATE');try{const result=run();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 close(){this.db.close();this.mfaKey.fill(0);}
}
