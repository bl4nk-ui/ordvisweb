import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {Store} from './store.mjs';
import {generateSecret,generateRecoveryCodes,verifyTotp} from './mfa.mjs';
import {createAssistantReport} from './assistant-report.mjs';
const allowedPlans=new Set(['Vitrin','Büyüme','Prestij','Tek seferlik proje','Birlikte karar verelim']);
const statuses=new Set(['new','contacted','archived']);
class ApiError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}
const digest=value=>createHash('sha256').update(value).digest('hex');
function sameToken(a,b){if(typeof a!=='string'||typeof b!=='string')return false;return timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));}
function text(value,name,max,required=true){if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim()))throw new ApiError(400,`${name} alanını kontrol edin (en fazla ${max} karakter).`);return value.trim();}
async function jsonBody(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new ApiError(415,'JSON biçiminde bir istek gerekiyor.');
 let length=0;const chunks=[];
 for await(const chunk of req.iterator({destroyOnReturn:false})){length+=chunk.length;if(length>16384){req.resume();throw new ApiError(413,'Gönderilen içerik çok uzun.');}chunks.push(chunk);}
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'İstek okunamadı.');}
 if(!data||typeof data!=='object'||Array.isArray(data))throw new ApiError(400,'Geçerli form alanları gönderin.');return data;
}
export function createApi({dataDir,publicOrigin,secureCookies,trustProxy=false}={}){
 const store=new Store({dataDir});const sessions=new Map(),limits=new Map();
 const secure=secureCookies??Boolean(publicOrigin?.startsWith('https:'));
 const cookieName=secure?'__Host-ordvis_session':'ordvis_session';let activeKdf=0;
 function clientIP(req){if(trustProxy){const forwarded=req.headers['x-forwarded-for']?.split(',').at(-1)?.trim();if(forwarded&&isIP(forwarded))return forwarded;}return req.socket.remoteAddress||'unknown';}
 function checkLimit(key,max,windowMs,consume=false){
  const now=Date.now();let entry=limits.get(key);if(!entry||entry.expires<=now){entry={count:0,expires:now+windowMs};limits.set(key,entry);}
  if(entry.count>=max){const error=new ApiError(429,'Çok fazla deneme yapıldı. Lütfen daha sonra tekrar deneyin.');error.retryAfter=Math.ceil((entry.expires-now)/1000);throw error;}if(consume)entry.count++;
 }
 function authLimit(source,purpose='login'){
  const retry=store.checkAuthLimit(purpose+':'+source,5,900000,{consume:true});
  if(retry){const error=new ApiError(429,'Çok fazla doğrulama denemesi yapıldı. Daha sonra tekrar deneyin.');error.retryAfter=retry;throw error;}
 }

 function factorLimit(){const retry=store.checkAuthLimit('factor:admin',10,900000,{consume:true});if(retry){const error=new ApiError(429,'İkinci doğrulama için çok fazla deneme yapıldı. Daha sonra tekrar deneyin.');error.retryAfter=retry;throw error;}}
 function verifyFactor(code){factorLimit();const valid=store.verifyMfa(code);if(valid)store.resetAuthLimit('factor:admin');return valid;}
 async function passwordCheck(username,password){
  if(typeof username!=='string'||username.length>80||typeof password!=='string'||password.length>128)return false;
  if(activeKdf>=2){const error=new ApiError(503,'Doğrulama şu anda yoğun. Biraz sonra tekrar deneyin.');error.retryAfter=2;throw error;}
  activeKdf++;try{return await store.verifyAdmin(username,password);}finally{activeKdf--;}
 }
 const cleanup=setInterval(()=>{const now=Date.now();for(const [key,value] of limits)if(value.expires<=now)limits.delete(key);for(const [key,value] of sessions)if(value.expires<=now||value.lastSeen+900000<=now)sessions.delete(key);},60000);cleanup.unref();
 function originCheck(req){
  let expected=publicOrigin;
  if(!expected){try{const local=new URL('http://'+req.headers.host);if(!['localhost','127.0.0.1','[::1]'].includes(local.hostname))throw new Error();expected=local.origin;}catch{throw new ApiError(403,'Bu adres için PUBLIC_ORIGIN yapılandırılmalıdır.');}}
  if(req.headers.origin!==expected)throw new ApiError(403,'İsteğin kaynağı doğrulanamadı.');
 }
 function getSession(req){
  const cookie=req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(!cookie||!/^[a-f0-9]{64}$/.test(cookie))return null;
  const key=digest(cookie),session=sessions.get(key),now=Date.now(),admin=store.getAdminState();
  if(!session||!admin||session.authVersion!==admin.authVersion||session.expires<=now||session.lastSeen+900000<=now){sessions.delete(key);return null;}
  session.lastSeen=now;return {...session,key,mfaEnabled:admin.mfaEnabled,mfaRequired:!session.full};
 }
 const cookie=(value,maxAge)=>`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;
 function requireSession(req,{full=true}={}){
  const session=getSession(req);if(!session)throw new ApiError(401,'Lütfen yönetici girişi yapın.');
  if(full&&!session.full)throw new ApiError(403,'Taleplere erişmek için önce iki aşamalı doğrulamayı kurun.','MFA_SETUP_REQUIRED');return session;
 }
 function csrf(req,session){if(!sameToken(req.headers['x-csrf-token'],session.csrfToken))throw new ApiError(403,'Oturum doğrulaması başarısız. Sayfayı yenileyin.');}
 function send(res,headers,status,data,extra={}){res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(data));}
 function sessionFields(session){return {authenticated:true,username:session.username,csrfToken:session.csrfToken,mfaEnabled:session.mfaEnabled,mfaRequired:session.mfaRequired};}
 function newSession(req,full,expectedVersion){
  ensureVersion(expectedVersion);
  const old=getSession(req);if(old)sessions.delete(old.key);
  if(sessions.size>=1000)throw new ApiError(503,'Çok fazla aktif oturum var. Daha sonra deneyin.');
  const admin=store.getAdminState(),token=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
  const age=full?14400:600;const session={username:admin.username,authVersion:expectedVersion,csrfToken,full,expires:Date.now()+age*1000,lastSeen:Date.now()};
  sessions.set(digest(token),session);return {fields:sessionFields({...session,mfaEnabled:admin.mfaEnabled,mfaRequired:!full}),cookie:cookie(token,age)};
 }
 function ensureVersion(version){if(store.getAdminState()?.authVersion!==version)throw new ApiError(401,'Hesap güvenlik ayarları değişti. Yeniden giriş yapın.','SESSION_EXPIRED');}
 async function reauthenticate(req,data,session,source,{secondFactor=true}={}){
  authLimit(source,'sensitive');const version=session.authVersion;
  if(!await passwordCheck(session.username,data.password))throw new ApiError(401,'Mevcut parola doğrulanamadı.','INVALID_CREDENTIALS');ensureVersion(version);requireSession(req,{full:false});
  if(secondFactor&&session.mfaEnabled&&!verifyFactor(data.code))throw new ApiError(401,'Yeni bir Authenticator kodu veya kullanılmamış kurtarma kodu girin.','MFA_INVALID');
  store.resetAuthLimit('sensitive:'+source);
 }
 return {
  close(){clearInterval(cleanup);sessions.clear();limits.clear();store.close();},
  async handle(req,res,pathname,headers){
   if(!pathname.startsWith('/api/'))return false;
   try{
    const ip=clientIP(req),source=store.sourceKey(ip);
    if(limits.size>=10000)throw new ApiError(503,'Sunucu şu anda yoğun. Daha sonra tekrar deneyin.');
    checkLimit('general:'+ip,120,60000,true);
    if(req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'Başka bir siteden bu işleme erişilemez.');
    if(!['GET','POST','PATCH'].includes(req.method))throw new ApiError(405,'Bu istek yöntemi desteklenmiyor.');
    if(req.method!=='GET')originCheck(req);
    if(pathname==='/api/leads'&&req.method==='POST'){
     const data=await jsonBody(req);if(data.website){send(res,headers,201,{message:'Talebiniz alındı.'});return true;}
     const lead={brand:text(data.brand,'Marka',100),name:text(data.name,'Ad soyad',100),email:text(data.email,'E-posta',254),phone:text(data.phone??'','Telefon',40,false),plan:text(data.plan,'Hizmet',60),brief:text(data.brief,'Proje',2000)};
     if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)||!allowedPlans.has(lead.plan)||data.consent!==true)throw new ApiError(400,'E-posta, hizmet seçimi ve aydınlatma onayını kontrol edin.');
     if(data.requestId!==undefined){if(typeof data.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(data.requestId))throw new ApiError(400,'İstek kimliği geçersiz.');lead.requestId=data.requestId;}
     const previous=store.findRequest(lead.requestId);
     if(previous){send(res,headers,201,{id:previous,message:'Talebiniz ekibimize ulaştı. Projenizi inceleyip size dönüş yapacağız.'});return true;}
     checkLimit('leads:'+ip,5,600000);const result=store.createLead(lead);if(!result.duplicate)checkLimit('leads:'+ip,5,600000,true);
     send(res,headers,201,{id:result.id,message:'Talebiniz ekibimize ulaştı. Projenizi inceleyip iletişim bilgilerinizden size dönüş yapacağız.'});return true;
    }
    if(pathname==='/api/admin/login'&&req.method==='POST'){
     const admin=store.getAdminState();if(!admin)throw new ApiError(503,'Yönetici hesabı henüz kurulmadı. Sunucuda npm run admin:setup çalıştırın.','ADMIN_NOT_CONFIGURED');
     authLimit(source);const data=await jsonBody(req);
     if(!await passwordCheck(data.username,data.password)){store.audit('login_failed',source);throw new ApiError(401,'Kullanıcı adı veya parola hatalı.','INVALID_CREDENTIALS');}
     ensureVersion(admin.authVersion);
     if(admin.mfaEnabled){
      if(!data.code)throw new ApiError(401,'Authenticator kodunuzu veya bir kurtarma kodunu girin.','MFA_CODE_REQUIRED');
      if(!verifyFactor(data.code)){store.audit('mfa_failed',source);throw new ApiError(401,'Kod doğrulanamadı. Yeni bir kod veya kullanılmamış kurtarma kodu girin.','MFA_INVALID');}
     }
     store.resetAuthLimit('login:'+source);const result=newSession(req,admin.mfaEnabled,admin.authVersion);store.audit(admin.mfaEnabled?'login_success':'enrollment_login',source);
     send(res,headers,200,result.fields,{'Set-Cookie':result.cookie});return true;
    }
    if(pathname==='/api/admin/session'&&req.method==='GET'){
     if(!store.hasAdmin())throw new ApiError(503,'Yönetici hesabı henüz kurulmadı. Sunucuda npm run admin:setup çalıştırın.','ADMIN_NOT_CONFIGURED');
     send(res,headers,200,sessionFields(requireSession(req,{full:false})));return true;
    }
    if(pathname==='/api/admin/security'&&req.method==='GET'){
     requireSession(req,{full:false});const admin=store.getAdminState();send(res,headers,200,{mfaEnabled:admin.mfaEnabled,recoveryCodesRemaining:admin.recoveryCodesRemaining,events:store.securityEvents()});return true;
    }
    if(pathname==='/api/admin/mfa/setup'&&req.method==='POST'){
     const session=requireSession(req,{full:false});csrf(req,session);const data=await jsonBody(req);await reauthenticate(req,data,session,source);
     const secret=generateSecret();sessions.get(session.key).pendingMfa={secret,expires:Date.now()+300000,version:session.authVersion};
     store.audit('mfa_setup_started',source);
     const uri=`otpauth://totp/${encodeURIComponent('Ordvis Creative:'+session.username)}?secret=${secret}&issuer=Ordvis%20Creative&algorithm=SHA1&digits=6&period=30`;
     send(res,headers,200,{secret,otpauthUri:uri});return true;
    }
    if(pathname==='/api/admin/mfa/enable'&&req.method==='POST'){
     const session=requireSession(req,{full:false});csrf(req,session);authLimit(source,'enrollment');const data=await jsonBody(req);requireSession(req,{full:false});const pending=sessions.get(session.key)?.pendingMfa;
     if(!pending||pending.expires<=Date.now())throw new ApiError(400,'Kurulum süresi doldu. Yeni bir anahtar oluşturun.');ensureVersion(pending.version);
     factorLimit();const counter=verifyTotp(pending.secret,data.code);if(counter===null)throw new ApiError(401,'Authenticator kodu doğrulanamadı. Yeni kodu deneyin.','MFA_INVALID');
     const recoveryCodes=generateRecoveryCodes();if(!store.enableMfa(pending.secret,{counter,recoveryCodes,expectedVersion:pending.version}))throw new ApiError(401,'Güvenlik ayarları değişti. Tekrar giriş yapın.');
     sessions.clear();store.resetAuthLimit('factor:admin');store.resetAuthLimit('enrollment:'+source);const result=newSession(req,true,pending.version+1);store.audit('mfa_enabled',source);
     send(res,headers,200,{...result.fields,recoveryCodes},{'Set-Cookie':result.cookie});return true;
    }
    if(pathname==='/api/admin/mfa/recovery-codes'&&req.method==='POST'){
     const session=requireSession(req);csrf(req,session);const data=await jsonBody(req);await reauthenticate(req,data,session,source);
     const recoveryCodes=generateRecoveryCodes();if(!store.replaceRecoveryCodes(recoveryCodes,session.authVersion))throw new ApiError(401,'Güvenlik ayarları değişti. Tekrar giriş yapın.');
     sessions.clear();const result=newSession(req,true,session.authVersion+1);store.audit('recovery_codes_rotated',source);
     send(res,headers,200,{...result.fields,recoveryCodes},{'Set-Cookie':result.cookie});return true;
    }
    if(pathname==='/api/admin/leads'&&req.method==='GET'){
     requireSession(req);send(res,headers,200,{leads:store.listLeads(),counts:store.counts()});return true;
    }
    if(pathname==='/api/admin/assistant-export'&&req.method==='GET'){
     requireSession(req);const report=createAssistantReport(store.listLeads());store.audit('assistant_export',source);
     send(res,headers,200,report,{'Content-Disposition':'attachment; filename="ordvis-asistan-ozeti.json"'});return true;
    }
    const leadId=pathname.match(/^\/api\/admin\/leads\/([a-f0-9-]{36})$/i)?.[1];
    if(leadId&&req.method==='PATCH'){
     const session=requireSession(req);csrf(req,session);const data=await jsonBody(req);const currentSession=requireSession(req);csrf(req,currentSession);
     if(!statuses.has(data.status)||typeof data.notes!=='string'||data.notes.length>4000)throw new ApiError(400,'Durum ve not alanlarını kontrol edin.');
     if(!store.updateLead(leadId,{status:data.status,notes:data.notes.trim()}))throw new ApiError(404,'Talep bulunamadı.');
     send(res,headers,200,{message:'Talep güncellendi.'});return true;
    }
    if(pathname==='/api/admin/logout'&&req.method==='POST'){
     const session=requireSession(req,{full:false});csrf(req,session);await jsonBody(req);requireSession(req,{full:false});sessions.delete(session.key);store.audit('logout',source);send(res,headers,200,{message:'Oturum kapatıldı.'},{'Set-Cookie':cookie('',0)});return true;
    }
    throw new ApiError(404,'İşlem bulunamadı.');
   }catch(error){if(!res.headersSent){send(res,headers,error.status||500,{error:error.status?error.message:'İşlem tamamlanamadı. Lütfen tekrar deneyin.',...(error.code?{code:error.code}:{})},error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});}else res.end();return true;}
  }
 };
}
