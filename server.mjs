import http from 'node:http';
import {readFile} from 'node:fs/promises';
const files = new Map([['/', ['index.html','text/html; charset=utf-8']], ['/style.css',['style.css','text/css; charset=utf-8']], ['/app.js',['app.js','text/javascript; charset=utf-8']], ['/favicon.svg',['favicon.svg','image/svg+xml']], ['/ordvis-katalog-2026.pdf',['ordvis-katalog-2026.pdf','application/pdf']]]);
export function createServer(){return http.createServer(async(req,res)=>{
 const headers={'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()','X-Frame-Options':'DENY','Cross-Origin-Opener-Policy':'same-origin'};
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...headers,Allow:'GET, HEAD'});return res.end('Method not allowed');}
 const pathname=req.url.split('?')[0];const file=files.get(pathname);
 if(!file){res.writeHead(404,{...headers,'Content-Type':'text/plain; charset=utf-8'});return res.end('Sayfa bulunamadı.');}
 try{const body=await readFile(new URL('./public/'+file[0],import.meta.url));res.writeHead(200,{...headers,'Content-Type':file[1],'Content-Length':body.length,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(500,headers);res.end('İçerik yüklenemedi.');}
 });}
if(process.argv[1]===new URL(import.meta.url).pathname){const port=Number(process.env.PORT||3000);createServer().listen(port,'0.0.0.0',()=>console.log(`Ordvis Creative listening on ${port}`));}
