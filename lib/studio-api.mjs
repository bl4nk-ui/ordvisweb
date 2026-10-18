import {randomBytes} from 'node:crypto';
import {createStudioStore} from './studio-store.mjs';
import {uploadMedia,serveMedia,removeMedia,mediaPath} from './media-files.mjs';
import {parsePaymentReceived} from './lead-payment.mjs';

const categories=new Set(['production','drone','editing','digital']);
const stages=new Set(['inquiry','proposal','waiting','scheduled','production','review','delivered']);
const imageTypes=['image/jpeg','image/png','image/webp'],videoTypes=['video/mp4','video/webm'];
const uuid='([a-f0-9-]{36})';
const projectKeys=new Set(['slug','title','category','summary','challenge','approach','result','clientName','published']);
const trackingKeys=new Set(['stage','nextActionAt','nextActionNote','agreedAmount','receivedAmount','paymentDueDate']);
export function createStudioApi({store,requireSession,csrf,jsonBody,send,ApiError,checkLimit}){
 const studio=createStudioStore(store);let closed=false;const uploads=new Map();
 function reject(message){throw new ApiError(400,message);}
 function bounded(value,name,max,{empty=false}={}){if(typeof value!=='string'||value.trim().length>max||(!empty&&!value.trim())||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value))reject(`${name} alanını kontrol edin (en fazla ${max} karakter).`);return value.trim();}
 function strictKeys(data,allowed){if(Object.keys(data).some(key=>!allowed.has(key)))reject('Desteklenmeyen bir alan gönderildi.');}
 function slugify(value){return value.toLocaleLowerCase('tr').replaceAll('ı','i').replaceAll('ş','s').replaceAll('ğ','g').replaceAll('ü','u').replaceAll('ö','o').replaceAll('ç','c').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').slice(0,75).replace(/^-|-$/g,'')||'proje';}
 function projectData(data,existing){
  strictKeys(data,projectKeys);const base=existing||{challenge:'',approach:'',result:'',clientName:'',published:false};
  const result={...base};
  for(const [key,label,max] of [['title','Başlık',160],['summary','Özet',600],['challenge','Amaç',4000],['approach','Yaklaşım',4000],['result','Sonuç',4000],['clientName','Müşteri adı',120]])if(Object.hasOwn(data,key))result[key]=bounded(data[key],label,max,{empty:!['title','summary'].includes(key)});
  if(!result.title||!result.summary)reject('Projenin başlığı ve özeti gerekiyor.');
  if(Object.hasOwn(data,'category'))result.category=data.category;
  if(!categories.has(result.category))reject('Geçerli bir proje kategorisi seçin.');
  if(Object.hasOwn(data,'published')){if(typeof data.published!=='boolean')reject('Yayın tercihini kontrol edin.');result.published=data.published;}
  if(Object.hasOwn(data,'slug')){if(typeof data.slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)||data.slug.length>100)reject('Proje bağlantısında küçük harf, rakam ve tire kullanın.');result.slug=data.slug;}
  else if(!existing){result.slug=slugify(result.title);if(studio.slugExists(result.slug))result.slug+='-'+randomBytes(4).toString('hex');}
  if(studio.slugExists(result.slug,existing?.id))throw new ApiError(409,'Bu proje bağlantısı zaten kullanılıyor.');
  return result;
 }
 function present(project,{publicView=false}={}){
  const media=Object.fromEntries(Object.entries(studio.allMedia(project.id)).map(([role,file])=>[role,{id:file.id,url:(publicView?`/media/projects/${project.slug}/${role}`:`/api/admin/projects/${project.id}/media/${role}`)+'?v='+file.id,mimeType:file.mimeType,size:file.size}]));
  const result={id:project.id,slug:project.slug,title:project.title,category:project.category,summary:project.summary,challenge:project.challenge,approach:project.approach,result:project.result,clientName:project.clientName,createdAt:project.createdAt,updatedAt:project.updatedAt,media};
  return publicView?result:{...result,published:project.published};
 }
 function authorize(req){const session=requireSession(req);csrf(req,session);return session;}
 function assertOpen(){if(closed)throw new ApiError(503,'Sunucu kapanıyor. Lütfen yeniden deneyin.');}
 function getProject(id){const project=studio.project(id);if(!project)throw new ApiError(404,'Proje bulunamadı.');return project;}
 function cents(value,{allowNull=false}={}){if(allowNull&&value===null)return null;if(typeof value==='string'&&/^(?:0|0[.,]0{1,2})$/.test(value.trim()))return 0;const parsed=parsePaymentReceived(value);if(parsed===null)reject('Tutarı TL olarak girin (örnek: 12500,50).');return parsed;}
 function iso(value){if(value===null)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19))reject('Geçerli bir takip tarihi girin.');return new Date(value).toISOString();}
 function date(value){if(value===null)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)reject('Geçerli bir ödeme tarihi girin.');return value;}
 return {
  close(){closed=true;for(const controller of uploads.keys())controller.abort();},
  async handle(req,res,pathname,headers,{source,ip}){
   if(pathname==='/api/projects'&&req.method==='GET'){send(res,headers,200,{projects:studio.list({published:true}).map(project=>present(project,{publicView:true}))});return true;}
   const publicProject=pathname.match(/^\/api\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
   if(publicProject&&req.method==='GET'){const project=studio.bySlug(publicProject[1]);if(!project)throw new ApiError(404,'Proje bulunamadı.');send(res,headers,200,{project:present(project,{publicView:true})});return true;}
   const publicMedia=pathname.match(/^\/media\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(cover|before|after|video)$/);
   if(publicMedia&&['GET','HEAD'].includes(req.method)){const project=studio.bySlug(publicMedia[1]),file=project&&studio.media(project.id,publicMedia[2]);if(!file)throw new ApiError(404,'Dosya bulunamadı.');await serveMedia(req,res,{filePath:mediaPath(store.dataDir,file.storageName),mimeType:file.mimeType,size:file.size,privateCache:true,headers});return true;}
   if(pathname==='/api/admin/projects'){
    if(req.method==='GET'){requireSession(req);send(res,headers,200,{projects:studio.list().map(project=>present(project))});return true;}
    if(req.method==='POST'){authorize(req);const data=await jsonBody(req,{maxBytes:65536});assertOpen();authorize(req);checkLimit('project-create:'+ip,30,60000,true);const project=studio.create(projectData(data));store.audit('project_created',source);send(res,headers,201,{project:present(project)});return true;}
   }
   const id=pathname.match(new RegExp('^/api/admin/projects/'+uuid+'$','i'))?.[1];
   if(id&&['PATCH','DELETE'].includes(req.method)){
    authorize(req);const data=await jsonBody(req,{maxBytes:65536});assertOpen();authorize(req);const existing=getProject(id);
    if(req.method==='PATCH'){const project=studio.update(id,projectData(data,existing));store.audit('project_updated',source);send(res,headers,200,{project:present(project)});return true;}
    if(data.confirmation!=='SİL')reject('Kalıcı silme için SİL onayı gerekiyor.');const files=studio.remove(id);for(const [controller,owner] of uploads)if(owner===id)controller.abort();store.audit('project_deleted',source);await Promise.all(files.map(name=>removeMedia(store.dataDir,name).catch(()=>{})));send(res,headers,200,{message:'Proje kalıcı olarak silindi.'});return true;
   }
   const projectMedia=pathname.match(new RegExp('^/api/admin/projects/'+uuid+'/media/(cover|before|after|video)$','i'));
   if(projectMedia){
    const [,id,role]=projectMedia;
    if(['GET','HEAD'].includes(req.method)){requireSession(req);getProject(id);const file=studio.media(id,role);if(!file)throw new ApiError(404,'Dosya bulunamadı.');await serveMedia(req,res,{filePath:mediaPath(store.dataDir,file.storageName),mimeType:file.mimeType,size:file.size,headers});return true;}
    if(req.method==='POST'){
     authorize(req);assertOpen();getProject(id);checkLimit('project-upload:'+ip,30,60000,true);if(uploads.size>=2)throw new ApiError(503,'Aynı anda en fazla iki dosya yüklenebilir.');
     const allowedTypes=role==='cover'?imageTypes:role==='video'?videoTypes:[...imageTypes,...videoTypes];
     const controller=new AbortController();uploads.set(controller,id);let file;
     try{file=await uploadMedia(req,{dataDir:store.dataDir,allowedTypes,maxBytes:role==='cover'?8*1024*1024:100*1024*1024,signal:controller.signal,afterBody:()=>{assertOpen();authorize(req);getProject(id);}});}finally{uploads.delete(controller);}
     let previous;
     try{assertOpen();authorize(req);getProject(id);const replacement=studio.setMedia(id,role,file);if(!replacement)throw new ApiError(404,'Proje bulunamadı.');previous=replacement.previous;}catch(error){await removeMedia(store.dataDir,file.storageName).catch(()=>{});throw error;}
     const result={project:present(studio.project(id))};store.audit('project_media_uploaded',source);
     if(previous)await removeMedia(store.dataDir,previous.storageName).catch(()=>{});
     send(res,headers,200,result);return true;
    }
    if(req.method==='DELETE'){authorize(req);const data=await jsonBody(req);assertOpen();authorize(req);getProject(id);if(data.confirmation!=='SİL')reject('Dosya silmek için SİL onayı gerekiyor.');const file=studio.removeMedia(id,role),result={project:present(studio.project(id))};store.audit('project_media_deleted',source);if(file)await removeMedia(store.dataDir,file.storageName).catch(()=>{});send(res,headers,200,result);return true;}
   }
   if(pathname==='/api/admin/tracking'&&req.method==='GET'){requireSession(req);send(res,headers,200,{leads:store.listLeads()});return true;}
   const trackingId=pathname.match(new RegExp('^/api/admin/leads/'+uuid+'/tracking$','i'))?.[1];
   if(trackingId&&req.method==='PATCH'){
    authorize(req);const data=await jsonBody(req);assertOpen();authorize(req);strictKeys(data,trackingKeys);const lead=store.getLead(trackingId);if(!lead)throw new ApiError(404,'Talep bulunamadı.');
    const patch={...lead.tracking};
    if(Object.hasOwn(data,'stage')){if(!stages.has(data.stage))reject('Geçerli bir iş aşaması seçin.');patch.stage=data.stage;}
    if(Object.hasOwn(data,'nextActionAt'))patch.nextActionAt=iso(data.nextActionAt);
    if(Object.hasOwn(data,'nextActionNote'))patch.nextActionNote=bounded(data.nextActionNote,'Takip notu',1000,{empty:true});
    if(Object.hasOwn(data,'agreedAmount'))patch.agreedAmountCents=cents(data.agreedAmount,{allowNull:true});
    if(Object.hasOwn(data,'receivedAmount')){patch.receivedAmountCents=cents(data.receivedAmount);if(lead.status==='completed'&&patch.receivedAmountCents===0)reject('Tamamlanan işin alınan ödemesi sıfırlanamaz.');}
    else delete patch.receivedAmountCents;
    if(Object.hasOwn(data,'paymentDueDate'))patch.paymentDueDate=date(data.paymentDueDate);
    const updated=studio.saveTracking(trackingId,patch);store.audit('lead_tracking_updated',source);send(res,headers,200,{lead:updated,tracking:updated.tracking});return true;
   }
   return false;
  }
 };
}
