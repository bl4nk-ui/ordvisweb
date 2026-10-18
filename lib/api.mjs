import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {Store} from './store.mjs';
import {generateSecret,generateRecoveryCodes,verifyTotp} from './mfa.mjs';
import {createAssistantReport} from './assistant-report.mjs';
import {createAutomation} from './automation.mjs';
import {summarizeLead} from './ai-summary.mjs';
import {createProviderTransport} from './provider-fetch.mjs';
import {parsePaymentReceived} from './lead-payment.mjs';
import {createStudioApi} from './studio-api.mjs';
import {createDeliveryApi} from './delivery-api.mjs';
import {createOperationsApi,operationsRoute} from './operations-api.mjs';
const allowedPlans=new Set(['Vitrin','Büyüme','Prestij','Tek seferlik proje','Birlikte karar verelim']);
const statuses=new Set(['new','contacted','archived','completed']);
class ApiError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}
const digest=value=>createHash('sha256').update(value).digest('hex');
function sameToken(a,b){if(typeof a!=='string'||typeof b!=='string')return false;return timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));}
function text(value,name,max,required=true){if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim()))throw new ApiError(400,`${name} alanını kontrol edin (en fazla ${max} karakter).`);return value.trim();}
async function jsonBody(req,{maxBytes=16384}={}){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new ApiError(415,'JSON biçiminde bir istek gerekiyor.');
 let length=0;const chunks=[];
 for await(const chunk of req.iterator({destroyOnReturn:false})){length+=chunk.length;if(length>maxBytes){req.resume();throw new ApiError(413,'Gönderilen içerik çok uzun.');}chunks.push(chunk);}
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'İstek okunamadı.');}
 if(!data||typeof data!=='object'||Array.isArray(data))throw new ApiError(400,'Geçerli form alanları gönderin.');return data;
}
export function createApi({dataDir,publicOrigin,secureCookies,trustProxy=false,aiConfig,aiSummarize,automationOptions}={}){
 const store=new Store({dataDir});const sessions=new Map(),limits=new Map();
 const secure=secureCookies??Boolean(publicOrigin?.startsWith('https:'));
 const transport=createProviderTransport();
 const automation=createAutomation({store,getConfig:aiConfig||(()=>{const saved=store.getAiCredentials();return {apiKey:process.env.GROQ_API_KEY||saved.apiKey,model:process.env.GROQ_MODEL||saved.model};}),summarize:aiSummarize||((lead,config)=>summarizeLead(lead,{...config,fetchImpl:transport.fetchImpl})),...automationOptions});
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

 function factorKey(userId='owner'){return userId==='owner'?'factor:admin':'factor:account:'+userId;}
 function factorLimit(userId='owner'){const retry=store.checkAuthLimit(factorKey(userId),10,900000,{consume:true});if(retry){const error=new ApiError(429,'İkinci doğrulama için çok fazla deneme yapıldı. Daha sonra tekrar deneyin.');error.retryAfter=retry;throw error;}}
 function verifyFactor(code,userId='owner'){factorLimit(userId);const valid=store.accounts.verifyMfa(code,userId);if(valid)store.resetAuthLimit(factorKey(userId));return valid;}
 async function withKdf(run){
  if(activeKdf>=2){const error=new ApiError(503,'Doğrulama şu anda yoğun. Biraz sonra tekrar deneyin.');error.retryAfter=2;throw error;}
  activeKdf++;try{return await run();}finally{activeKdf--;}
 }
 async function passwordCheck(username,password){
  if(typeof username!=='string'||username.length>80||typeof password!=='string'||password.length>128)return false;
  return withKdf(()=>store.accounts.verify(username,password));
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
  const key=digest(cookie),session=sessions.get(key),now=Date.now(),admin=session?store.accounts.state(session.userId):null;
  if(!session||!admin||admin.disabled||session.authVersion!==admin.authVersion||session.expires<=now||session.lastSeen+900000<=now){sessions.delete(key);return null;}
  session.lastSeen=now;return {...session,key,username:admin.username,displayName:admin.displayName,role:admin.role,mustChangePassword:admin.mustChangePassword,mfaEnabled:admin.mfaEnabled,mfaRequired:!session.full};
 }
 const cookie=(value,maxAge)=>`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;
 function requireSession(req,{full=true}={}){
  const session=getSession(req);if(!session)throw new ApiError(401,'Lütfen yönetici girişi yapın.');
  if(full&&session.mustChangePassword)throw new ApiError(403,'Devam etmek için geçici parolanızı değiştirin.','PASSWORD_CHANGE_REQUIRED');
  if(full&&!session.full)throw new ApiError(403,'Taleplere erişmek için önce iki aşamalı doğrulamayı kurun.','MFA_SETUP_REQUIRED');return session;
 }
 function requireOwner(req){const session=requireSession(req);if(session.role!=='owner')throw new ApiError(403,'Bu işlem için ana yönetici yetkisi gerekiyor.','OWNER_REQUIRED');return session;}
 function actor(req){const session=requireSession(req);return {id:session.userId,username:session.username,displayName:session.displayName,role:session.role};}
 function invalidateUser(userId){for(const [key,value] of sessions)if(value.userId===userId)sessions.delete(key);}
 function auditMutation(req,event,targetType,targetId){const user=actor(req);store.operations?.audit?.(user,event,targetType,targetId);}
 function csrf(req,session){if(!sameToken(req.headers['x-csrf-token'],session.csrfToken))throw new ApiError(403,'Oturum doğrulaması başarısız. Sayfayı yenileyin.');}
 function send(res,headers,status,data,extra={}){res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(data));}
 function sessionFields(session){return {authenticated:true,userId:session.userId,role:session.role,displayName:session.displayName,mustChangePassword:Boolean(session.mustChangePassword),username:session.username,csrfToken:session.csrfToken,mfaEnabled:session.mfaEnabled,mfaRequired:session.mfaRequired};}
 function newSession(req,full,expectedVersion,userId='owner'){
  ensureVersion(expectedVersion,userId);
  const old=getSession(req);if(old)sessions.delete(old.key);
  if(sessions.size>=1000)throw new ApiError(503,'Çok fazla aktif oturum var. Daha sonra deneyin.');
  const admin=store.accounts.state(userId),token=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
  const mfaVerified=Boolean(full&&admin.mfaEnabled);full=Boolean(mfaVerified&&!admin.mustChangePassword);const age=full?14400:600;const session={userId,role:admin.role,displayName:admin.displayName,mustChangePassword:admin.mustChangePassword,username:admin.username,authVersion:expectedVersion,csrfToken,full,mfaVerified,expires:Date.now()+age*1000,lastSeen:Date.now()};
  sessions.set(digest(token),session);return {fields:sessionFields({...session,mfaEnabled:admin.mfaEnabled,mfaRequired:!full}),cookie:cookie(token,age)};
 }
 function ensureVersion(version,userId='owner'){const account=store.accounts.state(userId);if(!account||account.disabled||account.authVersion!==version)throw new ApiError(401,'Hesap güvenlik ayarları değişti. Yeniden giriş yapın.','SESSION_EXPIRED');}
 async function reauthenticate(req,data,session,source,{secondFactor=true}={}){
  authLimit(source,'sensitive');const version=session.authVersion;
  if(!await passwordCheck(session.username,data.password))throw new ApiError(401,'Mevcut parola doğrulanamadı.','INVALID_CREDENTIALS');ensureVersion(version,session.userId);requireSession(req,{full:false});
  if(secondFactor&&session.mfaEnabled&&!verifyFactor(data.code,session.userId))throw new ApiError(401,'Yeni bir Authenticator kodu veya kullanılmamış kurtarma kodu girin.','MFA_INVALID');
  store.resetAuthLimit('sensitive:'+source);
 }
 function briefDetails(value){
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['service','goal','location','deadline','budgetRange'].includes(key)))throw new ApiError(400,'Proje detaylarını kontrol edin.');
  const service=value.service??'mixed',budgetRange=value.budgetRange??'undecided',deadline=value.deadline??null;
  if(!['production','drone','editing','digital','mixed'].includes(service)||!['undecided','under-10000','10000-25000','25000-50000','50000-plus'].includes(budgetRange))throw new ApiError(400,'Hizmet ve bütçe seçimini kontrol edin.');
  if(deadline!==null&&(typeof deadline!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(deadline)||!Number.isFinite(Date.parse(deadline+'T00:00:00Z'))||new Date(deadline+'T00:00:00Z').toISOString().slice(0,10)!==deadline))throw new ApiError(400,'Teslim tarihini kontrol edin.');
  return {service,goal:text(value.goal??'','Proje hedefi',400,false),location:text(value.location??'','Lokasyon',160,false),deadline,budgetRange};
 }
 const moduleContext={store,requireSession,requireOwner,actor,auditMutation,csrf,jsonBody,send,ApiError,checkLimit,secureCookies:secure};
 const studioApi=createStudioApi(moduleContext),deliveryApi=createDeliveryApi(moduleContext),operationsApi=createOperationsApi(moduleContext);
 return {
  publicProjectExists(slug){return Boolean(store.studio.bySlug(slug));},
  close(){studioApi.close();deliveryApi.close();operationsApi.close();automation.close();transport.close();clearInterval(cleanup);sessions.clear();limits.clear();store.close();},
  async handle(req,res,pathname,headers){
   const publicMedia=pathname.startsWith('/media/projects/')||pathname.startsWith('/media/clients/');
   if(!pathname.startsWith('/api/')&&!publicMedia)return false;
   try{
    const ip=clientIP(req),source=store.sourceKey(ip);
    if(limits.size>=10000)throw new ApiError(503,'Sunucu şu anda yoğun. Daha sonra tekrar deneyin.');
    checkLimit('general:'+ip,120,60000,true);
    if(!publicMedia&&req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'Başka bir siteden bu işleme erişilemez.');
    if(!['GET','HEAD','POST','PATCH','DELETE'].includes(req.method))throw new ApiError(405,'Bu istek yöntemi desteklenmiyor.');
    if(!['GET','HEAD'].includes(req.method))originCheck(req);
    if(pathname.startsWith('/api/admin/users')||pathname.startsWith('/api/admin/automation')||pathname==='/api/admin/assistant-export')requireOwner(req);
    const studioRoute=pathname.startsWith('/media/projects/')||pathname.startsWith('/api/projects')||pathname.startsWith('/api/admin/projects')||pathname==='/api/admin/tracking'||/^\/api\/admin\/leads\/[a-f0-9-]{36}\/tracking$/i.test(pathname);
    const deliveryRoute=pathname.startsWith('/api/delivery')||pathname.startsWith('/api/admin/deliveries')||/^\/api\/admin\/leads\/[a-f0-9-]{36}\/deliveries$/i.test(pathname);
    // Do not yield before the body reader is attached to unrelated routes.
    // A request observer may otherwise switch the stream to flowing mode.
    if(operationsRoute(pathname)&&await operationsApi.handle(req,res,pathname,headers,{source,ip}))return true;
    if(studioRoute&&await studioApi.handle(req,res,pathname,headers,{source,ip}))return true;
    if(deliveryRoute&&await deliveryApi.handle(req,res,pathname,headers,{source,ip}))return true;
    if(pathname==='/api/leads'&&req.method==='POST'){
     const data=await jsonBody(req);if(data.website){send(res,headers,201,{message:'Talebiniz alındı.'});return true;}
     const lead={brand:text(data.brand,'Marka',100),name:text(data.name,'Ad soyad',100),email:text(data.email,'E-posta',254),phone:text(data.phone??'','Telefon',40,false),plan:text(data.plan,'Hizmet',60),brief:text(data.brief,'Proje',2000)};
     const details=briefDetails(data.briefDetails);if(details)lead.briefDetails=details;
     if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)||!allowedPlans.has(lead.plan)||data.consent!==true)throw new ApiError(400,'E-posta, hizmet seçimi ve aydınlatma onayını kontrol edin.');
     if(data.requestId!==undefined){if(typeof data.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(data.requestId))throw new ApiError(400,'İstek kimliği geçersiz.');lead.requestId=data.requestId;}
     const previous=store.findRequest(lead.requestId);
     if(previous){send(res,headers,201,{id:previous,message:'Talebiniz ekibimize ulaştı. Projenizi inceleyip size dönüş yapacağız.'});return true;}
     checkLimit('leads:'+ip,5,600000);const result=store.createLead(lead);if(!result.duplicate)checkLimit('leads:'+ip,5,600000,true);
     send(res,headers,201,{id:result.id,message:'Talebiniz ekibimize ulaştı. Projenizi inceleyip iletişim bilgilerinizden size dönüş yapacağız.'});return true;
    }
    if(pathname==='/api/admin/login'&&req.method==='POST'){
     if(!store.hasAdmin())throw new ApiError(503,'Yönetici hesabı henüz kurulmadı. Sunucuda npm run admin:setup çalıştırın.','ADMIN_NOT_CONFIGURED');
     authLimit(source);const data=await jsonBody(req),snapshot=store.accounts.find(data.username);
     const account=await passwordCheck(data.username,data.password);
     if(!account){store.audit('login_failed',source,snapshot?.id||'owner');throw new ApiError(401,'Kullanıcı adı veya parola hatalı.','INVALID_CREDENTIALS');}
     if(!snapshot||snapshot.id!==account.id)throw new ApiError(401,'Hesap güvenlik ayarları değişti. Yeniden giriş yapın.','SESSION_EXPIRED');
     ensureVersion(snapshot.authVersion,account.id);
     if(account.mfaEnabled){
      if(!data.code)throw new ApiError(401,'Authenticator kodunuzu veya bir kurtarma kodunu girin.','MFA_CODE_REQUIRED');
      if(!verifyFactor(data.code,account.id)){store.audit('mfa_failed',source,account.id);throw new ApiError(401,'Kod doğrulanamadı. Yeni bir kod veya kullanılmamış kurtarma kodu girin.','MFA_INVALID');}
     }
     store.resetAuthLimit('login:'+source);const result=newSession(req,account.mfaEnabled,snapshot.authVersion,account.id);store.audit(account.mfaEnabled?'login_success':'enrollment_login',source,account.id);
     send(res,headers,200,result.fields,{'Set-Cookie':result.cookie});return true;
    }
    if(pathname==='/api/admin/session'&&req.method==='GET'){
     if(!store.hasAdmin())throw new ApiError(503,'Yönetici hesabı henüz kurulmadı. Sunucuda npm run admin:setup çalıştırın.','ADMIN_NOT_CONFIGURED');
     send(res,headers,200,sessionFields(requireSession(req,{full:false})));return true;
    }
    if(pathname==='/api/admin/password'&&req.method==='POST'){
     const session=requireSession(req,{full:false});csrf(req,session);const data=await jsonBody(req);
     authLimit(source,'password-change');
     if(typeof data.currentPassword!=='string'||typeof data.newPassword!=='string'||data.newPassword.length<12||data.newPassword.length>128)throw new ApiError(400,'Yeni parola 12–128 karakter olmalı.');
     if(data.currentPassword===data.newPassword)throw new ApiError(400,'Yeni parola mevcut paroladan farklı olmalı.');
     if(!await passwordCheck(session.username,data.currentPassword))throw new ApiError(401,'Mevcut parola doğrulanamadı.','INVALID_CREDENTIALS');
     const recheck=()=>{const current=requireSession(req,{full:false});csrf(req,current);ensureVersion(session.authVersion,session.userId);};recheck();
     const changed=await withKdf(()=>store.accounts.changePassword(session.userId,data.newPassword,session.authVersion,recheck));
     if(!changed)throw new ApiError(401,'Hesap güvenlik ayarları değişti. Yeniden giriş yapın.','SESSION_EXPIRED');
     invalidateUser(session.userId);store.resetAuthLimit('password-change:'+source);store.audit('password_changed',source,session.userId);
     const result=newSession(req,session.mfaVerified,session.authVersion+1,session.userId);send(res,headers,200,result.fields,{'Set-Cookie':result.cookie});return true;
    }
    if(pathname==='/api/admin/team'&&req.method==='GET'){
     requireSession(req);send(res,headers,200,{users:store.accounts.list().map(({id,username,displayName,role,disabled})=>({id,username,displayName,role,disabled}))});return true;
    }
    if(pathname==='/api/admin/users'&&req.method==='GET'){
     requireOwner(req);send(res,headers,200,{users:store.accounts.list()});return true;
    }
    if(pathname==='/api/admin/users'&&req.method==='POST'){
     const session=requireOwner(req);csrf(req,session);const data=await jsonBody(req);const recheck=()=>{const current=requireOwner(req);csrf(req,current);};recheck();
     let user;try{user=await withKdf(()=>store.accounts.create(data,recheck));}catch(error){if(error.status)throw error;throw new ApiError(400,error.message);}
     store.audit('team_account_created',source,session.userId);auditMutation(req,'team_account_created','account',user.id);
     send(res,headers,201,{user});return true;
    }
    const userId=pathname.match(/^\/api\/admin\/users\/(owner|[a-f0-9-]{36})$/i)?.[1];
    if(userId&&req.method==='PATCH'){
     const session=requireOwner(req);csrf(req,session);const data=await jsonBody(req);const recheck=()=>{const current=requireOwner(req);csrf(req,current);};recheck();
     let user;try{user=await withKdf(()=>store.accounts.update(userId,data,recheck));}catch(error){if(error.status)throw error;throw new ApiError(400,error.message);}
     if(!user)throw new ApiError(404,'Ekip hesabı bulunamadı.');invalidateUser(userId);
     store.audit('team_account_updated',source,session.userId);auditMutation(req,'team_account_updated','account',userId);
     send(res,headers,200,{user});return true;
    }
    if(pathname==='/api/admin/security'&&req.method==='GET'){
     const session=requireSession(req,{full:false}),admin=store.accounts.state(session.userId);send(res,headers,200,{mfaEnabled:admin.mfaEnabled,recoveryCodesRemaining:admin.recoveryCodesRemaining,events:store.securityEvents(session.userId)});return true;
    }
    if(pathname==='/api/admin/mfa/setup'&&req.method==='POST'){
     const session=requireSession(req,{full:false});csrf(req,session);if(session.mustChangePassword)throw new ApiError(403,'Önce geçici parolanızı değiştirin.','PASSWORD_CHANGE_REQUIRED');const data=await jsonBody(req);await reauthenticate(req,data,session,source);
     const secret=generateSecret();sessions.get(session.key).pendingMfa={secret,expires:Date.now()+300000,version:session.authVersion};
     store.audit('mfa_setup_started',source,session.userId);
     const uri=`otpauth://totp/${encodeURIComponent('Ordvis Creative:'+session.username)}?secret=${secret}&issuer=Ordvis%20Creative&algorithm=SHA1&digits=6&period=30`;
     send(res,headers,200,{secret,otpauthUri:uri});return true;
    }
    if(pathname==='/api/admin/mfa/enable'&&req.method==='POST'){
     const session=requireSession(req,{full:false});csrf(req,session);authLimit(source,'enrollment');const data=await jsonBody(req);requireSession(req,{full:false});const pending=sessions.get(session.key)?.pendingMfa;
     if(!pending||pending.expires<=Date.now())throw new ApiError(400,'Kurulum süresi doldu. Yeni bir anahtar oluşturun.');ensureVersion(pending.version,session.userId);
     if(session.mustChangePassword)throw new ApiError(403,'Önce geçici parolanızı değiştirin.','PASSWORD_CHANGE_REQUIRED');
     factorLimit(session.userId);const counter=verifyTotp(pending.secret,data.code);if(counter===null)throw new ApiError(401,'Authenticator kodu doğrulanamadı. Yeni kodu deneyin.','MFA_INVALID');
     const recoveryCodes=generateRecoveryCodes();if(!store.accounts.enableMfa(pending.secret,{counter,recoveryCodes,expectedVersion:pending.version},session.userId))throw new ApiError(401,'Güvenlik ayarları değişti. Tekrar giriş yapın.');
     invalidateUser(session.userId);store.resetAuthLimit(factorKey(session.userId));store.resetAuthLimit('enrollment:'+source);const result=newSession(req,true,pending.version+1,session.userId);store.audit('mfa_enabled',source,session.userId);
     send(res,headers,200,{...result.fields,recoveryCodes},{'Set-Cookie':result.cookie});return true;
    }
    if(pathname==='/api/admin/mfa/recovery-codes'&&req.method==='POST'){
     const session=requireSession(req);csrf(req,session);const data=await jsonBody(req);await reauthenticate(req,data,session,source);
     const recoveryCodes=generateRecoveryCodes();if(!store.accounts.replaceRecoveryCodes(recoveryCodes,session.authVersion,session.userId))throw new ApiError(401,'Güvenlik ayarları değişti. Tekrar giriş yapın.');
     invalidateUser(session.userId);const result=newSession(req,true,session.authVersion+1,session.userId);store.audit('recovery_codes_rotated',source,session.userId);
     send(res,headers,200,{...result.fields,recoveryCodes},{'Set-Cookie':result.cookie});return true;
    }
    if(pathname==='/api/admin/automation'&&req.method==='GET'){
     requireSession(req);send(res,headers,200,automation.status());return true;
    }
    if(pathname==='/api/admin/automation'&&req.method==='POST'){
     const session=requireOwner(req);csrf(req,session);const data=await jsonBody(req);const current=requireOwner(req);csrf(req,current);
     if(typeof data.enabled!=='boolean')throw new ApiError(400,'Otomasyon tercihini kontrol edin.');
     const result=automation.setEnabled(data.enabled);store.audit(data.enabled?'ai_automation_enabled':'ai_automation_disabled',source,session.userId);send(res,headers,200,result);return true;
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
     let paymentReceivedCents;
     if(data.status==='completed'){
      paymentReceivedCents=parsePaymentReceived(data.paymentReceived);
      if(paymentReceivedCents===null)throw new ApiError(400,'Tamamlamak için alınan ödemeyi TL olarak girin (örnek: 12500,50; en fazla 999999999,99).');
     }
     if(!store.updateLead(leadId,{status:data.status,notes:data.notes.trim(),paymentReceivedCents}))throw new ApiError(404,'Talep bulunamadı.');
     store.audit(data.status==='completed'?'lead_completed':'lead_updated',source,session.userId);auditMutation(req,data.status==='completed'?'lead_completed':'lead_updated','lead',leadId);
     send(res,headers,200,{message:'Talep güncellendi.',lead:store.getLead(leadId)});return true;
    }
    if(leadId&&req.method==='DELETE'){
     const session=requireOwner(req);csrf(req,session);const data=await jsonBody(req);const currentSession=requireOwner(req);csrf(req,currentSession);
     if(data.confirmation!=='SİL')throw new ApiError(400,'Kalıcı silme için SİL onayı gerekiyor.');
     if(!store.deleteLead(leadId))throw new ApiError(404,'Talep bulunamadı.');
     store.audit('lead_deleted',source,session.userId);auditMutation(req,'lead_deleted','lead',leadId);send(res,headers,200,{message:'Talep kalıcı olarak silindi.'});return true;
    }
    if(pathname==='/api/admin/logout'&&req.method==='POST'){
     const session=requireSession(req,{full:false});csrf(req,session);await jsonBody(req);requireSession(req,{full:false});sessions.delete(session.key);store.audit('logout',source,session.userId);send(res,headers,200,{message:'Oturum kapatıldı.'},{'Set-Cookie':cookie('',0)});return true;
    }
    throw new ApiError(404,'İşlem bulunamadı.');
   }catch(error){if(!res.headersSent){send(res,headers,error.status||500,{error:error.status?error.message:'İşlem tamamlanamadı. Lütfen tekrar deneyin.',...(error.code?{code:error.code}:{})},error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});}else res.end();return true;}
  }
 };
}
