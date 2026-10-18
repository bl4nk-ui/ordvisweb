import {createDeliveryStore} from './delivery-store.mjs';
import {uploadMedia,serveMedia,removeMedia,mediaPath} from './media-files.mjs';
const id='([a-f0-9-]{36})';
const adminLeadPattern=new RegExp('^/api/admin/leads/'+id+'/deliveries$','i');
const adminActionPattern=new RegExp('^/api/admin/deliveries/'+id+'/(revoke|files)$','i');
const adminFilePattern=new RegExp('^/api/admin/deliveries/'+id+'/files/'+id+'$','i');
const clientFilePattern=new RegExp('^/api/delivery/media/'+id+'/'+id+'$','i');
const allTypes=['image/jpeg','image/png','image/webp','video/mp4','video/webm','application/pdf'];
export function createDeliveryApi({store,requireSession,csrf,jsonBody,send,ApiError,secureCookies=false}={}){
 const deliveries=createDeliveryStore(store),controllers=new Set();let closed=false;
 const fail=(status,message)=>{throw new ApiError(status,message);};
 function field(value,name,max,{required=true}={}){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail(400,`${name} alanını kontrol edin (en fazla ${max} karakter).`);return value.trim();}
 function admin(req){const session=requireSession(req);if(!['GET','HEAD'].includes(req.method))csrf(req,session);return session;}
 const cookieName=deliveryId=>'ordvis_delivery_'+deliveryId.replaceAll('-','');
 function readCookie(req,deliveryId){const name=cookieName(deliveryId)+'=';return req.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(name))?.slice(name.length)||'';}
 function tokenDelivery(req){const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];const delivery=deliveries.findToken(token);if(!delivery)fail(404,'Teslim bağlantısı bulunamadı veya süresi doldu.');return delivery;}
 function limit(key,max,windowMs){const retry=store.checkAuthLimit(key,max,windowMs,{consume:true});if(retry){const error=new ApiError(429,'Çok fazla deneme yapıldı. Lütfen daha sonra tekrar deneyin.');error.retryAfter=retry;throw error;}}
 function audit(event,source){store.audit(event,source||'');}
 return {
  close(){closed=true;for(const controller of controllers)controller.abort();controllers.clear();},
  async handle(req,res,pathname,headers,{source='',ip=''}={}){
   if(closed)fail(503,'Sunucu kapanıyor. Lütfen tekrar deneyin.');
   const leadMatch=adminLeadPattern.exec(pathname),actionMatch=adminActionPattern.exec(pathname),adminFile=adminFilePattern.exec(pathname),clientFile=clientFilePattern.exec(pathname);
   if(leadMatch&&req.method==='GET'){admin(req);if(!store.getLead(leadMatch[1]))fail(404,'Talep bulunamadı.');send(res,headers,200,{deliveries:deliveries.list(leadMatch[1])});return true;}
   if(leadMatch&&req.method==='POST'){
    admin(req);const body=await jsonBody(req);admin(req);const title=field(body.title,'Başlık',150),description=field(body.description??'','Açıklama',2000,{required:false}),expiresInDays=body.expiresInDays??7;
    if(!Number.isInteger(expiresInDays)||expiresInDays<1||expiresInDays>30)fail(400,'Bağlantı süresini 1–30 gün arasında seçin.');
    const result=deliveries.create(leadMatch[1],{title,description,expiresInDays});audit('delivery_link_created',source);send(res,headers,201,result);return true;
   }
   if(actionMatch&&actionMatch[2]==='revoke'&&req.method==='POST'){
    admin(req);await jsonBody(req);admin(req);if(!deliveries.revoke(actionMatch[1]))fail(404,'Teslim bulunamadı.');audit('delivery_link_revoked',source);send(res,headers,200,{message:'Teslim bağlantısı iptal edildi.'});return true;
   }
   if(actionMatch&&actionMatch[2]==='files'&&req.method==='POST'){
    admin(req);if(controllers.size>=2)fail(429,'Aynı anda en fazla iki dosya yükleyebilirsiniz. Diğer yüklemelerin tamamlanmasını bekleyin.');const delivery=deliveries.get(actionMatch[1]);if(!deliveries.active(delivery))fail(404,'Etkin teslim bulunamadı.');if(deliveries.assets(delivery.id).length>=20)fail(409,'Bir teslimde en fazla 20 dosya bulunabilir.');
    const controller=new AbortController();controllers.add(controller);let file,attached=false;
    try{
     file=await uploadMedia(req,{dataDir:store.dataDir,allowedTypes:allTypes,signal:controller.signal,afterBody(){if(closed)fail(503,'Sunucu kapanıyor.');admin(req);if(!deliveries.active(deliveries.get(delivery.id)))fail(409,'Teslim bağlantısı artık etkin değil.');}});
     if(closed)fail(503,'Sunucu kapanıyor.');admin(req);const result=deliveries.addAsset(delivery.id,file);attached=true;audit('delivery_file_added',source);send(res,headers,201,{delivery:result});return true;
    }catch(error){if(file&&!attached)await removeMedia(store.dataDir,file.storageName).catch(()=>{});throw error;}finally{controllers.delete(controller);}
   }
   if(adminFile&&['GET','HEAD'].includes(req.method)){
    admin(req);const delivery=deliveries.get(adminFile[1]);if(!delivery||!store.getLead(delivery.leadId))fail(404,'Dosya bulunamadı.');const file=deliveries.assets(delivery.id).find(item=>item.id===adminFile[2]);if(!file)fail(404,'Dosya bulunamadı.');
    await serveMedia(req,res,{filePath:mediaPath(store.dataDir,file.storageName),mimeType:file.mimeType,size:file.size,downloadName:'ordvis-'+file.storageName,headers});return true;
   }
   if(adminFile&&req.method==='DELETE'){
    admin(req);await jsonBody(req);admin(req);const result=deliveries.deleteAsset(adminFile[1],adminFile[2]);audit('delivery_file_deleted',source);await removeMedia(store.dataDir,result.storageName).catch(()=>{});send(res,headers,200,{delivery:result.delivery});return true;
   }
   if(pathname==='/api/delivery'&&req.method==='GET'){const delivery=tokenDelivery(req);send(res,headers,200,{delivery:deliveries.payload(delivery)});return true;}
   if(pathname==='/api/delivery/session'&&req.method==='POST'){
    const before=tokenDelivery(req);limit('delivery-session:'+before.id+':'+source,30,3600000);limit('delivery-session-total:'+before.id,100,3600000);await jsonBody(req);const delivery=tokenDelivery(req),session=deliveries.newMediaSession(delivery);
    const cookie=`${cookieName(delivery.id)}=${session.token}; HttpOnly; SameSite=Strict; Path=/api/delivery/media/${delivery.id}/; Max-Age=${session.maxAge}${secureCookies?'; Secure':''}`;
    send(res,headers,200,{delivery:deliveries.payload(delivery)},{'Set-Cookie':cookie});return true;
   }
   if(pathname==='/api/delivery/feedback'&&req.method==='POST'){
    const before=tokenDelivery(req);limit('delivery-feedback:'+before.id+':'+source,20,3600000);limit('delivery-feedback-total:'+before.id,100,3600000);const body=await jsonBody(req),delivery=tokenDelivery(req);
    if(!['revision','approve'].includes(body.action)||!Number.isSafeInteger(body.version)||body.version<1)fail(400,'Geri bildirim türünü ve sürümünü kontrol edin.');
    const message=field(body.message??'','Revizyon notu',2000,{required:body.action==='revision'});
    const result=deliveries.feedback(delivery,{action:body.action,message,version:body.version,confirmation:body.confirmation});audit(body.action==='approve'?'delivery_approved':'delivery_revision_requested',source);send(res,headers,200,{delivery:result});return true;
   }
   if(clientFile&&['GET','HEAD'].includes(req.method)){
    const file=deliveries.mediaAsset(clientFile[1],clientFile[2],readCookie(req,clientFile[1]));if(!file)fail(404,'Dosya bulunamadı veya görüntüleme oturumu sona erdi.');
    await serveMedia(req,res,{filePath:mediaPath(store.dataDir,file.storageName),mimeType:file.mimeType,size:file.size,downloadName:'ordvis-'+file.storageName,headers});return true;
   }
   return false;
  }
 };
}
