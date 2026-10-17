import {pathToFileURL} from 'node:url';
import http from 'node:http';
import {createApi} from './lib/api.mjs';
import {readFile} from 'node:fs/promises';
const files = new Map([
 ['/', ['index.html','text/html; charset=utf-8']],
 ...['produksiyon','drone','kurgu','dijital','paketler','iletisim'].map(name=>['/'+name,[name+'.html','text/html; charset=utf-8']]),
 ['/style.css',['style.css','text/css; charset=utf-8']],
 ['/app.js',['app.js','text/javascript; charset=utf-8']],
 ['/admin',['admin.html','text/html; charset=utf-8']],
 ['/admin.css',['admin.css','text/css; charset=utf-8']],
 ['/admin.js',['admin.js','text/javascript; charset=utf-8']],
 ['/favicon.png',['favicon.png','image/png']],
 ...['ordvis-logo','ordvis-mark'].map(name=>['/media/'+name+'.png',['media/'+name+'.png','image/png']]),
 ...['aerial-coast','edit-frame','drone'].map(name=>['/media/'+name+'.svg',['media/'+name+'.svg','image/svg+xml']]),
 ['/ordvis-katalog-2026.pdf',['ordvis-katalog-2026.pdf','application/pdf']]
]);
export function createServer(options={}){
 const publicOrigin=options.publicOrigin??process.env.PUBLIC_ORIGIN;
 if(publicOrigin){const parsed=new URL(publicOrigin);if(parsed.origin!==publicOrigin||!['http:','https:'].includes(parsed.protocol))throw new Error('PUBLIC_ORIGIN yalnızca alan adı ve protokol içermeli; örnek: https://ajans.example');}
 if(process.env.NODE_ENV==='production'&&!publicOrigin?.startsWith('https://'))throw new Error('Canlı ortamda HTTPS PUBLIC_ORIGIN zorunludur.');
 const api=createApi({...options,publicOrigin,trustProxy:options.trustProxy??process.env.TRUST_PROXY==='1'});
 const server=http.createServer(async(req,res)=>{
 const headers={'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()','X-Frame-Options':'DENY','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin',...(publicOrigin?.startsWith('https://')?{'Strict-Transport-Security':'max-age=31536000'}:{})};
 const pathname=req.url.split('?')[0];
 if(await api.handle(req,res,pathname,headers))return;
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...headers,Allow:'GET, HEAD'});return res.end('Method not allowed');}
 if(pathname.length>1 && pathname.endsWith('/') && files.has(pathname.slice(0,-1))){res.writeHead(308,{...headers,Location:pathname.slice(0,-1)+(req.url.includes('?')?'?'+req.url.split('?').slice(1).join('?'):'')});return res.end();}
 const file=files.get(pathname);
 if(!file){res.writeHead(404,{...headers,'Content-Type':'text/plain; charset=utf-8'});return res.end('Sayfa bulunamadı.');}
 try{const body=await readFile(new URL('./public/'+file[0],import.meta.url));res.writeHead(200,{...headers,'Content-Type':file[1],'Content-Length':body.length,'Cache-Control':pathname==='/admin'?'no-store':'no-cache'});res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(500,headers);res.end('İçerik yüklenemedi.');}
 });
 server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
 server.on('close',()=>api.close());
 return server;
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url){const port=Number(process.env.PORT||3000);createServer().listen(port,process.env.HOST||(process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1'),()=>console.log(`Ordvis Creative listening on ${port}`));}
