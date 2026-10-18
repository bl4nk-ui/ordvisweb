import {randomUUID} from 'node:crypto';
import {mkdir,open,rename,unlink,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
const IMAGE_LIMIT=8*1024*1024,FILE_LIMIT=100*1024*1024;
const types=new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['video/mp4','mp4'],['video/webm','webm'],['application/pdf','pdf']]);
function failure(status,message){const error=new Error(message);error.status=status;return error;}
export function mediaPath(dataDir,storageName){if(typeof storageName!=='string'||!/^[-a-f0-9]{36}\.(?:jpg|png|webp|mp4|webm|pdf)$/.test(storageName))throw failure(404,'Dosya bulunamadı.');return join(resolve(dataDir),'studio-media',storageName);}
function signatureMatches(bytes,type){
 if(type==='image/jpeg')return bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(type==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(type==='image/webp')return bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
 if(type==='video/mp4'){if(bytes.length<12||bytes.toString('ascii',4,8)!=='ftyp')return false;const size=bytes.readUInt32BE(0);return size>=16&&size<=4096&&bytes.length>=16;}
 if(type==='video/webm')return bytes.length>=4&&bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
 return type==='application/pdf'&&bytes.toString('ascii',0,5)==='%PDF-';
}
export async function uploadMedia(req,{dataDir,allowedTypes=[...types.keys()],maxBytes=FILE_LIMIT,signal,afterBody=()=>{},timeoutMs=120000}={}){
 // Attach the paused reader before any filesystem await. Other request
 // observers must not consume the first chunk while the temporary file opens.
 req.pause();
 const mimeType=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
 if(!types.has(mimeType)||!allowedTypes.includes(mimeType))throw failure(415,'Bu dosya türü desteklenmiyor. JPG, PNG, WebP, MP4, WebM veya PDF kullanın.');
 const limit=Math.min(maxBytes,mimeType.startsWith('image/')?IMAGE_LIMIT:FILE_LIMIT);
 const declared=req.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))))throw failure(400,'Dosya boyutu geçersiz.');
 if(Number(declared)>limit)throw failure(413,'Dosya boyutu izin verilen sınırı aşıyor.');
 const id=randomUUID(),storageName=id+'.'+types.get(mimeType),path=mediaPath(dataDir,storageName),temp=path+'.upload';
 await mkdir(join(resolve(dataDir),'studio-media'),{recursive:true,mode:0o700});
 const file=await open(temp,'wx',0o600);let size=0,prefix=Buffer.alloc(0),complete=false,timedOut=false;
 const abortController=new AbortController();const timer=setTimeout(()=>{timedOut=true;abortController.abort();req.destroy();},timeoutMs);timer.unref?.();
 const abort=()=>{abortController.abort();req.destroy();};signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)throw failure(409,'Dosya yükleme iptal edildi.');
  for await(const chunk of req.iterator({destroyOnReturn:false})){
   if(abortController.signal.aborted)throw failure(timedOut?408:409,'Dosya yükleme tamamlanamadı.');
   size+=chunk.length;if(size>limit){req.resume();throw failure(413,'Dosya boyutu izin verilen sınırı aşıyor.');}
   if(prefix.length<4096)prefix=Buffer.concat([prefix,chunk.subarray(0,4096-prefix.length)]);
   let offset=0;while(offset<chunk.length){const written=await file.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)throw failure(500,'Dosya kaydedilemedi.');offset+=written.bytesWritten;}
  }
  if(req.aborted||timedOut||signal?.aborted)throw failure(timedOut?408:409,'Dosya yükleme tamamlanamadı.');
  if(!size||(declared!==undefined&&Number(declared)!==size)||!signatureMatches(prefix,mimeType))throw failure(415,'Dosya içeriği seçilen dosya türüyle eşleşmiyor.');
  await afterBody();await file.sync();await file.close();await rename(temp,path);complete=true;
  return {id,storageName,mimeType,size};
 }catch(error){if(error.status)throw error;throw failure(timedOut?408:400,'Dosya yükleme tamamlanamadı.');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await file.close().catch(()=>{});if(!complete)await unlink(temp).catch(()=>{});}
}
export async function removeMedia(dataDir,storageName){try{await unlink(mediaPath(dataDir,storageName));}catch(error){if(error.code!=='ENOENT')throw error;}}
export async function serveMedia(req,res,{filePath,mimeType,size,downloadName,privateCache=true,headers={}}={}){
 let actual;try{actual=await stat(filePath);}catch{throw failure(404,'Dosya bulunamadı.');}if(!actual.isFile())throw failure(404,'Dosya bulunamadı.');size=actual.size;
 const safeName=typeof downloadName==='string'&&/^[a-z0-9._-]{1,100}$/i.test(downloadName)?downloadName:'ordvis-dosya.'+(types.get(mimeType)||'bin');
 const base={...headers,'Content-Type':types.has(mimeType)?mimeType:'application/octet-stream','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Cache-Control':privateCache?'private, no-store':'public, max-age=3600','Content-Disposition':`${mimeType==='application/pdf'?'attachment':'inline'}; filename="${safeName}"`,'Cross-Origin-Resource-Policy':'same-origin'};
 let start=0,end=size-1,status=200;
 if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);let valid=Boolean(match&&(match[1]||match[2]));
  if(valid){if(!match[1]){const suffix=Number(match[2]);valid=Number.isSafeInteger(suffix)&&suffix>0;start=Math.max(0,size-suffix);}else{start=Number(match[1]);end=match[2]?Number(match[2]):end;valid=Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end&&start<size;end=Math.min(end,size-1);}}
  if(!valid){res.writeHead(416,{...base,'Content-Range':`bytes */${size}`,'Content-Length':'0'});res.end();return;}status=206;base['Content-Range']=`bytes ${start}-${end}/${size}`;
 }
 res.writeHead(status,{...base,'Content-Length':String(Math.max(0,end-start+1))});if(req.method==='HEAD'||size===0){res.end();return;}
 try{await pipeline(createReadStream(filePath,{start,end}),res);}catch(error){if(!res.destroyed)res.destroy(error);}
}
