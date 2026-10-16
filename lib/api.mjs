import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {Store} from './store.mjs';
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
 function clientIP(req){if(trustProxy){const forwarded=req.headers['x-forwarded-for']?.split(',').at(-1)?.trim();if(forwarded&&isIP(forwarded))return forwarded;}return req.socket.remoteAddress||'unknown';}
 function checkLimit(key,max,windowMs,consume=false){const now=Date.now();let entry=limits.get(key);if(!entry||entry.expires<=now){entry={count:0,expires:now+windowMs};limits.set(key,entry);}if(entry.count>=max){const error=new ApiError(429,'Çok fazla deneme yapıldı. Lütfen daha sonra tekrar deneyin.');error.retryAfter=Math.ceil((entry.expires-now)/1000);throw error;}if(consume)entry.count++;}
 const cleanup=setInterval(()=>{const now=Date.now();for(const [key,value] of limits)if(value.expires<=now)limits.delete(key);for(const [key,value] of sessions)if(value.expires<=now||value.lastSeen+1800000<=now)sessions.delete(key);},60000);cleanup.unref();
 function originCheck(req){
  let expected=publicOrigin;
  if(!expected){try{const local=new URL('http://'+req.headers.host);if(!['localhost','127.0.0.1','[::1]'].includes(local.hostname))throw new Error();expected=local.origin;}catch{throw new ApiError(403,'Bu adres için PUBLIC_ORIGIN yapılandırılmalıdır.');}}
  if(req.headers.origin!==expected)throw new ApiError(403,'İsteğin kaynağı doğrulanamadı.');
 }
 function getSession(req){
  const cookie=req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('ordvis_session='))?.slice('ordvis_session='.length);
  if(!cookie||!/^[a-f0-9]{64}$/.test(cookie))return null;
  const key=digest(cookie),session=sessions.get(key),now=Date.now();
  if(!session||session.expires<=now||session.lastSeen+1800000<=now){sessions.delete(key);return null;}
  session.lastSeen=now;return {...session,key};
 }
 const cookie=(value,maxAge)=>`ordvis_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;
 function requireSession(req){const session=getSession(req);if(!session)throw new ApiError(401,'Lütfen yönetici girişi yapın.');return session;}
 function csrf(req,session){if(!sameToken(req.headers['x-csrf-token'],session.csrfToken))throw new ApiError(403,'Oturum doğrulaması başarısız. Sayfayı yenileyin.');}
 function send(res,headers,status,data,extra={}){res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(data));}
 return {
  close(){clearInterval(cleanup);sessions.clear();limits.clear();store.close();},
  async handle(req,res,pathname,headers){
   if(!pathname.startsWith('/api/'))return false;
   try{
    const ip=clientIP(req);if(limits.size>=10000)throw new ApiError(503,'Sunucu şu anda yoğun. Lütfen biraz sonra tekrar deneyin.');
    checkLimit('general:'+ip,120,60000,true);
    if(!['GET','POST','PATCH'].includes(req.method))throw new ApiError(405,'Bu istek yöntemi desteklenmiyor.');
    if(req.method!=='GET')originCheck(req);
    if(pathname==='/api/leads'&&req.method==='POST'){
     const data=await jsonBody(req);
     if(data.website){send(res,headers,201,{message:'Talebiniz alındı.'});return true;}
     const lead={brand:text(data.brand,'Marka',100),name:text(data.name,'Ad soyad',100),email:text(data.email,'E-posta',254),phone:text(data.phone??'','Telefon',40,false),plan:text(data.plan,'Hizmet',60),brief:text(data.brief,'Proje',2000)};
     if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)||!allowedPlans.has(lead.plan)||data.consent!==true)throw new ApiError(400,'E-posta, hizmet seçimi ve aydınlatma onayını kontrol edin.');
     if(data.requestId!==undefined){if(typeof data.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(data.requestId))throw new ApiError(400,'İstek kimliği geçersiz.');lead.requestId=data.requestId;}
     const previous=store.findRequest(lead.requestId);
     if(previous){send(res,headers,201,{id:previous,message:'Talebiniz ekibimize ulaştı. Projenizi inceleyip iletişim bilgilerinizden size dönüş yapacağız.'});return true;}
     checkLimit('leads:'+ip,5,600000);const result=store.createLead(lead);if(!result.duplicate)checkLimit('leads:'+ip,5,600000,true);
     send(res,headers,201,{id:result.id,message:'Talebiniz ekibimize ulaştı. Projenizi inceleyip iletişim bilgilerinizden size dönüş yapacağız.'});return true;
    }
    if(pathname==='/api/admin/login'&&req.method==='POST'){
     if(!store.hasAdmin())throw new ApiError(503,'Yönetici hesabı henüz kurulmadı. Sunucuda npm run admin:setup çalıştırın.','ADMIN_NOT_CONFIGURED');
     checkLimit('login:'+ip,5,900000,true);
     const data=await jsonBody(req);let valid=false;
     if(typeof data.username==='string'&&data.username.length<=80&&typeof data.password==='string'&&data.password.length<=128)valid=await store.verifyAdmin(data.username,data.password);
     if(!valid){throw new ApiError(401,'Kullanıcı adı veya parola hatalı.');}
     limits.delete('login:'+ip);const old=getSession(req);if(old)sessions.delete(old.key);
     if(sessions.size>=1000)throw new ApiError(503,'Çok fazla aktif oturum var. Lütfen daha sonra deneyin.');
     const token=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
     sessions.set(digest(token),{username:data.username,csrfToken,expires:Date.now()+28800000,lastSeen:Date.now()});
     send(res,headers,200,{username:data.username,csrfToken},{'Set-Cookie':cookie(token,28800)});return true;
    }
    if(pathname==='/api/admin/session'&&req.method==='GET'){
     if(!store.hasAdmin())throw new ApiError(503,'Yönetici hesabı henüz kurulmadı. Sunucuda npm run admin:setup çalıştırın.','ADMIN_NOT_CONFIGURED');
     const session=requireSession(req);send(res,headers,200,{authenticated:true,username:session.username,csrfToken:session.csrfToken});return true;
    }
    if(pathname==='/api/admin/leads'&&req.method==='GET'){
     requireSession(req);send(res,headers,200,{leads:store.listLeads(),counts:store.counts()});return true;
    }
    const leadId=pathname.match(/^\/api\/admin\/leads\/([a-f0-9-]{36})$/i)?.[1];
    if(leadId&&req.method==='PATCH'){
     const session=requireSession(req);csrf(req,session);const data=await jsonBody(req);
     if(!statuses.has(data.status)||typeof data.notes!=='string'||data.notes.length>4000)throw new ApiError(400,'Durum ve not alanlarını kontrol edin.');
     if(!store.updateLead(leadId,{status:data.status,notes:data.notes.trim()}))throw new ApiError(404,'Talep bulunamadı.');
     send(res,headers,200,{message:'Talep güncellendi.'});return true;
    }
    if(pathname==='/api/admin/logout'&&req.method==='POST'){
     const session=requireSession(req);csrf(req,session);await jsonBody(req);sessions.delete(session.key);send(res,headers,200,{message:'Oturum kapatıldı.'},{'Set-Cookie':cookie('',0)});return true;
    }
    throw new ApiError(404,'İşlem bulunamadı.');
   }catch(error){if(!res.headersSent){send(res,headers,error.status||500,{error:error.status?error.message:'İşlem tamamlanamadı. Lütfen tekrar deneyin.',...(error.code?{code:error.code}:{})},error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});}else res.end();return true;}
  }
 };
}
