import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
import {promisify} from 'node:util';
import {verifyTotp,normalizeRecoveryCode,hashRecoveryCode} from './mfa.mjs';
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
   CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,brand TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,plan TEXT NOT NULL,brief TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','archived')),notes TEXT NOT NULL DEFAULT '',consent_at TEXT NOT NULL,request_id TEXT UNIQUE);
   CREATE INDEX IF NOT EXISTS leads_created_at ON leads(created_at DESC);
   CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,event TEXT NOT NULL,source TEXT NOT NULL);`);
  const columns=new Set(this.db.prepare('PRAGMA table_info(admin)').all().map(column=>column.name));
  for(const [name,type] of [['password_n','INTEGER NOT NULL DEFAULT 32768'],['mfa_secret','TEXT'],['mfa_last_counter','INTEGER NOT NULL DEFAULT -1'],['auth_version','INTEGER NOT NULL DEFAULT 1'],['recovery_hashes',"TEXT NOT NULL DEFAULT '[]'"]])if(!columns.has(name))this.db.exec(`ALTER TABLE admin ADD COLUMN ${name} ${type}`);
  if(process.platform!=='win32'&&(statSync(this.dataDir).mode&0o077))throw new Error('DATA_DIR yalnız sunucu hesabına açık olmalı (izin:700).');
  const keyPath=join(this.dataDir,'mfa.key');
  if(!existsSync(keyPath)){
   if(this.db.prepare('SELECT 1 FROM admin WHERE mfa_secret IS NOT NULL').get())throw new Error('MFA anahtar dosyası eksik. mfa.key dosyasını güvenli yedeğinizden geri yükleyin; yeni anahtar oluşturulmadı.');
   try{writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600,flush:true});}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  this.mfaKey=readFileSync(keyPath);if(this.mfaKey.length!==32)throw new Error('MFA anahtar dosyası geçersiz.');
  if(process.platform!=='win32'&&(statSync(keyPath).mode&0o077))throw new Error('mfa.key yalnız sunucu hesabına açık olmalı (izin:600).');
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
 encryptSecret(secret){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.mfaKey,iv);cipher.setAAD(Buffer.from('ordvis-totp-v1'));const body=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return ['v1',iv.toString('hex'),cipher.getAuthTag().toString('hex'),body.toString('hex')].join('.');}
 decryptSecret(value){const [version,iv,tag,body]=value.split('.');if(version!=='v1')throw new Error('MFA verisi geçersiz.');const decipher=createDecipheriv('aes-256-gcm',this.mfaKey,Buffer.from(iv,'hex'));decipher.setAAD(Buffer.from('ordvis-totp-v1'));decipher.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(body,'hex')),decipher.final()]).toString('utf8');}
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
 findRequest(requestId){return requestId?this.db.prepare('SELECT id FROM leads WHERE request_id=?').get(requestId)?.id:null;}
 createLead(lead){
  if(lead.requestId){const existing=this.db.prepare('SELECT id FROM leads WHERE request_id=?').get(lead.requestId);if(existing)return {id:existing.id,duplicate:true};}
  const id=randomUUID(),now=new Date().toISOString();
  this.db.prepare('INSERT INTO leads(id,created_at,brand,name,email,phone,plan,brief,consent_at,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,now,lead.brand,lead.name,lead.email,lead.phone,lead.plan,lead.brief,now,lead.requestId||null);
  return {id,duplicate:false};
 }
 listLeads(){return this.db.prepare('SELECT id,created_at AS createdAt,brand,name,email,phone,plan,brief,status,notes,consent_at AS consentAt FROM leads ORDER BY created_at DESC').all();}
 counts(){const counts={new:0,contacted:0,archived:0,total:0};for(const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM leads GROUP BY status').all()){counts[row.status]=row.count;counts.total+=row.count;}return counts;}
 updateLead(id,{status,notes}){return this.db.prepare('UPDATE leads SET status=?,notes=? WHERE id=?').run(status,notes,id).changes>0;}
 close(){this.db.close();this.mfaKey.fill(0);}
}
