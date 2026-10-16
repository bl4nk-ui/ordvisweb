import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
const hashOptions={N:32768,r:8,p:1,maxmem:64*1024*1024};
const dummySalt=randomBytes(16).toString('hex');
export class Store {
 constructor({dataDir=process.env.DATA_DIR||'.data'}={}){
  this.dataDir=resolve(dataDir);mkdirSync(this.dataDir,{recursive:true,mode:0o700});
  this.dbPath=join(this.dataDir,'ordvis.sqlite');this.db=new DatabaseSync(this.dbPath);
  try{chmodSync(this.dbPath,0o600);}catch(error){if(process.platform!=='win32')throw error;}
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,brand TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,plan TEXT NOT NULL,brief TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','archived')),notes TEXT NOT NULL DEFAULT '',consent_at TEXT NOT NULL,request_id TEXT UNIQUE);
   CREATE INDEX IF NOT EXISTS leads_created_at ON leads(created_at DESC);`);
 }
 hasAdmin(){return Boolean(this.db.prepare('SELECT 1 FROM admin WHERE id=1').get());}
 async initializeAdmin(username,password){
  if(typeof username!=='string'||!/^[-\p{L}\p{N}_.@]{3,80}$/u.test(username))throw new Error('Kullanıcı adı 3–80 karakter olmalı; harf, rakam, nokta, tire, @ veya alt çizgi kullanın.');
  if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('Parola 12–128 karakter olmalı.');
  const salt=randomBytes(16).toString('hex');const hash=await scrypt(password,salt,64,hashOptions);
  this.db.prepare('INSERT INTO admin(id,username,salt,password_hash) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,password_hash=excluded.password_hash').run(username,salt,hash.toString('hex'));
 }
 async verifyAdmin(username,password){
  const admin=this.db.prepare('SELECT username,salt,password_hash FROM admin WHERE id=1').get();
  const hash=await scrypt(password,admin?.salt||dummySalt,64,hashOptions);
  if(!admin)return false;
  const expected=Buffer.from(admin.password_hash,'hex');
  return timingSafeEqual(hash,expected)&&username===admin.username;
 }
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
 close(){this.db.close();}
}
