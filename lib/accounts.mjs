import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {verifyTotp,normalizeRecoveryCode,hashRecoveryCode} from './mfa.mjs';
const scrypt=promisify(scryptCallback),options={N:131072,r:8,p:1,maxmem:256*1024*1024},dummySalt=randomBytes(16).toString('hex');
export function initAccountsSchema(store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS admin_accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'partner' CHECK(role='partner'),salt TEXT NOT NULL,password_hash TEXT NOT NULL,password_n INTEGER NOT NULL DEFAULT 131072,mfa_secret TEXT,mfa_last_counter INTEGER NOT NULL DEFAULT -1,recovery_hashes TEXT NOT NULL DEFAULT '[]',auth_version INTEGER NOT NULL DEFAULT 1,disabled INTEGER NOT NULL DEFAULT 0,must_change_password INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);`);
 const columns=new Set(store.db.prepare('PRAGMA table_info(security_events)').all().map(column=>column.name));
 if(!columns.has('actor_id'))store.db.exec("ALTER TABLE security_events ADD COLUMN actor_id TEXT NOT NULL DEFAULT 'owner'");
}
export function usernameKey(value){return typeof value==='string'?value.normalize('NFKC').toLocaleLowerCase('en-US'):null;}
function validateUsername(value){if(typeof value!=='string'||value.length>80||!/^[-\p{L}\p{N}_.@]{3,80}$/u.test(value))throw new Error('Kullanıcı adı 3–80 karakter olmalı; harf, rakam, nokta, tire, @ veya alt çizgi kullanın.');return value;}
function validatePassword(value){if(typeof value!=='string'||value.length<12||value.length>128)throw new Error('Parola 12–128 karakter olmalı.');return value;}
function validateDisplayName(value){if(typeof value!=='string'||!value.trim()||value.trim().length>100||/[\u0000-\u001F\u007F]/.test(value))throw new Error('Görünen ad 1–100 karakter olmalı.');return value.trim();}
export function createAccounts(store){
 const db=store.db;
 const owner=()=>{const value=store.getAdminState();return value?{...value,id:'owner',role:'owner',displayName:value.username,disabled:false,mustChangePassword:false}:null;};
 function state(id='owner'){
  if(id==='owner')return owner();
  const row=db.prepare('SELECT id,username,display_name AS displayName,role,auth_version AS authVersion,mfa_secret,recovery_hashes,disabled,must_change_password AS mustChangePassword FROM admin_accounts WHERE id=?').get(id);
  if(!row)return null;const {mfa_secret,recovery_hashes,...safe}=row;return {...safe,disabled:Boolean(row.disabled),mustChangePassword:Boolean(row.mustChangePassword),mfaEnabled:Boolean(mfa_secret),recoveryCodesRemaining:JSON.parse(recovery_hashes).length};
 }
 function find(username){if(typeof username!=='string')return null;const key=usernameKey(username),currentOwner=owner();if(currentOwner&&usernameKey(currentOwner.username)===key)return currentOwner;const row=db.prepare('SELECT id,username FROM admin_accounts').all().find(value=>usernameKey(value.username)===key);return row?state(row.id):null;}
 function publicState(account){if(!account)return null;const {id,username,displayName,role,disabled,mfaEnabled,mustChangePassword}=account;return {id,username,displayName,role,disabled,mfaEnabled,mustChangePassword};}
 function list(){return [owner(),...db.prepare('SELECT id FROM admin_accounts ORDER BY created_at,id').all().map(row=>state(row.id))].filter(Boolean).map(publicState);}
 async function verify(username,password){
  const account=find(username);
  if(account?.id==='owner')return await store.verifyAdmin(account.username,password)?account:null;
  const row=account?db.prepare('SELECT salt,password_hash,password_n,auth_version FROM admin_accounts WHERE id=?').get(account.id):null;
  if(row&&! [32768,131072].includes(row.password_n))return null;
  const hash=await scrypt(password,row?.salt||dummySalt,64,{...options,N:row?.password_n||options.N}),expected=row?Buffer.from(row.password_hash,'hex'):null;
  if(!account||account.disabled||!expected||expected.length!==hash.length||!timingSafeEqual(hash,expected)||state(account.id)?.authVersion!==row.auth_version)return null;
  return state(account.id);
 }
 async function create(data,beforeCommit=()=>{}){
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!['username','displayName','password'].includes(key)))throw new Error('Kullanıcı alanlarını kontrol edin.');
  let {username,displayName,password}=data;validateUsername(username);displayName=validateDisplayName(displayName);validatePassword(password);
  if(find(username))throw new Error('Bu kullanıcı adı kullanılıyor.');
  if(db.prepare('SELECT COUNT(*) AS count FROM admin_accounts').get().count>=50)throw new Error('En fazla 50 ekip hesabı oluşturabilirsiniz.');
  const salt=randomBytes(16).toString('hex'),hash=await scrypt(password,salt,64,options);beforeCommit();
  if(find(username))throw new Error('Bu kullanıcı adı kullanılıyor.');
  if(db.prepare('SELECT COUNT(*) AS count FROM admin_accounts').get().count>=50)throw new Error('En fazla 50 ekip hesabı oluşturabilirsiniz.');
  const id=randomUUID();db.prepare('INSERT INTO admin_accounts(id,username,display_name,salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id,username,displayName,salt,hash.toString('hex'),new Date().toISOString());return publicState(state(id));
 }
 async function update(id,patch,beforeCommit=()=>{}){
  if(id==='owner')throw new Error('Ana yönetici bu alandan değiştirilemez.');
  const current=state(id);if(!current)return null;
  if(Object.keys(patch).some(key=>!['disabled','displayName','resetPassword'].includes(key))||!Object.keys(patch).length)throw new Error('Kullanıcı alanlarını kontrol edin.');
  if(patch.disabled!==undefined&&typeof patch.disabled!=='boolean')throw new Error('Hesap durumu geçersiz.');
  const displayName=patch.displayName===undefined?current.displayName:validateDisplayName(patch.displayName);
  let salt,hash;if(patch.resetPassword!==undefined){validatePassword(patch.resetPassword);salt=randomBytes(16).toString('hex');hash=await scrypt(patch.resetPassword,salt,64,options);}
  beforeCommit();if(state(id)?.authVersion!==current.authVersion)throw new Error('Hesap değişti. Yeniden deneyin.');
  if(hash)db.prepare('UPDATE admin_accounts SET salt=?,password_hash=?,password_n=?,must_change_password=1,auth_version=auth_version+1 WHERE id=?').run(salt,hash.toString('hex'),options.N,id);
  db.prepare('UPDATE admin_accounts SET display_name=?,disabled=?,auth_version=auth_version+1 WHERE id=?').run(displayName,Number(patch.disabled??current.disabled),id);
  return publicState(state(id));
 }
 async function changePassword(id,password,expectedVersion,beforeCommit=()=>{}){
  validatePassword(password);const salt=randomBytes(16).toString('hex'),hash=await scrypt(password,salt,64,options);beforeCommit();
  if(id==='owner')return db.prepare('UPDATE admin SET salt=?,password_hash=?,password_n=?,auth_version=auth_version+1 WHERE id=1 AND auth_version=?').run(salt,hash.toString('hex'),options.N,expectedVersion).changes>0;
  return db.prepare('UPDATE admin_accounts SET salt=?,password_hash=?,password_n=?,must_change_password=0,auth_version=auth_version+1 WHERE id=? AND auth_version=? AND disabled=0').run(salt,hash.toString('hex'),options.N,id,expectedVersion).changes>0;
 }
 function verifyMfa(code,id='owner',{now=Date.now()}={}){
  if(id==='owner')return store.verifyMfa(code,{now});
  const row=db.prepare('SELECT mfa_secret,mfa_last_counter,recovery_hashes FROM admin_accounts WHERE id=? AND disabled=0').get(id);if(!row?.mfa_secret)return false;
  const normalized=normalizeRecoveryCode(code);
  if(/^[A-F0-9]{24}$/.test(normalized)){const hashes=JSON.parse(row.recovery_hashes),hash=hashRecoveryCode(normalized),index=hashes.findIndex(value=>timingSafeEqual(Buffer.from(value),Buffer.from(hash)));if(index===-1)return false;hashes.splice(index,1);return db.prepare('UPDATE admin_accounts SET recovery_hashes=? WHERE id=? AND recovery_hashes=? AND disabled=0').run(JSON.stringify(hashes),id,row.recovery_hashes).changes>0;}
  const counter=verifyTotp(store.decryptSecret(row.mfa_secret,'totp-account-'+id),code,{now,lastCounter:row.mfa_last_counter});if(counter===null)return false;
  return db.prepare('UPDATE admin_accounts SET mfa_last_counter=? WHERE id=? AND mfa_last_counter<? AND disabled=0').run(counter,id,counter).changes>0;
 }
 function enableMfa(secret,{counter,recoveryCodes,expectedVersion},id='owner'){
  if(id==='owner')return store.enableMfa(secret,{counter,recoveryCodes,expectedVersion});
  if(!Number.isInteger(counter)||!Array.isArray(recoveryCodes))throw new Error('Geçersiz MFA kurulumu.');
  return db.prepare('UPDATE admin_accounts SET mfa_secret=?,mfa_last_counter=?,recovery_hashes=?,auth_version=auth_version+1 WHERE id=? AND auth_version=? AND disabled=0 AND must_change_password=0').run(store.encryptSecret(secret,'totp-account-'+id),counter,JSON.stringify(recoveryCodes.map(hashRecoveryCode)),id,expectedVersion).changes>0;
 }
 function replaceRecoveryCodes(codes,version,id='owner'){if(id==='owner')return store.replaceRecoveryCodes(codes,version);return db.prepare('UPDATE admin_accounts SET recovery_hashes=?,auth_version=auth_version+1 WHERE id=? AND auth_version=? AND disabled=0').run(JSON.stringify(codes.map(hashRecoveryCode)),id,version).changes>0;}
 return {state,find,list,verify,create,update,changePassword,verifyMfa,enableMfa,replaceRecoveryCodes,publicState};
}
