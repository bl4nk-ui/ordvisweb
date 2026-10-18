import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../server.mjs';

function assertSecurityHeaders(response) {
 assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
 assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
 assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
 assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
 assert.equal(response.headers.get('x-frame-options'), 'DENY');
 assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
 assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
 assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
}

test('every public page opens directly with distinct content and accepts query parameters', async()=>{
 const server = createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const titles = new Set();
  const bodies = new Set();
  for (const route of ['/', '/produksiyon', '/drone', '/kurgu', '/dijital', '/paketler', '/iletisim', '/isler', '/teslim']) {
   const response = await fetch(base + route);
   assert.equal(response.status, 200, route);
   assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', route);
   assertSecurityHeaders(response);
   const body = await response.text();
   assert.match(body, /<html[^>]*lang="tr"/i, route);
   assert.match(body, /Ordvis Creative/i, route);
   assert.match(body, /<h1\b[^>]*>[\s\S]+?<\/h1>/i, route);
   const title = body.match(/<title>([^<]+)<\/title>/i)?.[1];
   assert.ok(title, `${route} has a page title`);
   assert.ok(!titles.has(title), `${route} has its own page title`);
   titles.add(title);
   assert.ok(!bodies.has(body), `${route} has its own page content`);
   bodies.add(body);
   const query = await fetch(base + route + '?utm_source=test&paket=baslangic');
   assert.equal(query.status, 200, `${route} with query parameters`);
   assert.equal(await query.text(), body, `${route} query preserves page content`);
   assertSecurityHeaders(query);
   if (route !== '/') {
    const redirect = await fetch(base + route + '/?utm_source=test', {redirect: 'manual'});
    assert.equal(redirect.status, 308, `${route} trailing slash`);
    assert.equal(redirect.headers.get('location'), route + '?utm_source=test');
    assertSecurityHeaders(redirect);
   }
   const head = await fetch(base + route, {method: 'HEAD'});
   assert.equal(head.status, 200, `HEAD ${route}`);
   assert.equal(head.headers.get('content-type'), response.headers.get('content-type'));
   assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
   assert.equal(await head.text(), '');
   assertSecurityHeaders(head);
  }
 } finally {
  await new Promise(resolve => server.close(resolve));
 }
});

test('public assets retain their content types and security policy', async()=>{
 const server = createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [route, type] of [
   ['/style.css', 'text/css; charset=utf-8'],
   ['/app.js', 'text/javascript; charset=utf-8'],
   ['/studio.js', 'text/javascript; charset=utf-8'],
   ['/studio.css', 'text/css; charset=utf-8'],
   ['/delivery.js', 'text/javascript; charset=utf-8'],
   ['/delivery.css', 'text/css; charset=utf-8'],
   ['/favicon.png', 'image/png'],
   ['/media/ordvis-logo.png', 'image/png'],
   ['/media/ordvis-mark.png', 'image/png'],
   ['/media/aerial-coast.svg', 'image/svg+xml'],
   ['/media/edit-frame.svg', 'image/svg+xml'],
   ['/media/drone.svg', 'image/svg+xml'],
   ['/ordvis-katalog-2026.pdf', 'application/pdf'],
  ]) {
   const response = await fetch(base + route);
   assert.equal(response.status, 200, route);
   assert.equal(response.headers.get('content-type'), type, route);
   assertSecurityHeaders(response);
   const content = await response.text();
   assert.ok(content.length > 0, `${route} is not empty`);
   if (type === 'application/pdf') assert.equal(content.slice(0, 5), '%PDF-');
   if (type === 'image/svg+xml') assert.match(content, /<svg\b/);
  }
 } finally {
  await new Promise(resolve => server.close(resolve));
 }
});

test('unknown, private and traversal paths stay isolated and writes are rejected', async()=>{
 const server = createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of [
   '/bulunamayan-sayfa', '/package.json', '/package-lock.json', '/server.mjs',
   '/README.md', '/.env', '/.git/config', '/test/server.test.mjs',
   '/public/index.html', '/media/../../server.mjs', '/%2e%2e/server.mjs',
   '/%2e%2e%2fserver.mjs', '/media/%2e%2e%2f%2e%2e%2fserver.mjs',
   '/media/..%5c..%5cserver.mjs', '/drone/anything', '/isler/olmayan-proje', '/proje.html', '/delivery.html',
  ]) {
   const response = await fetch(base + route);
   assert.equal(response.status, 404, route);
   assertSecurityHeaders(response);
   assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
   assert.doesNotMatch(await response.text(), /createServer|"scripts"|\[core\]/);
  }
  for (const route of ['/', '/drone', '/iletisim', '/app.js', '/not-a-route']) {
   const response = await fetch(base + route, {method: 'POST', body: 'secret'});
   assert.equal(response.status, 405, `POST ${route}`);
   assert.equal(response.headers.get('allow'), 'GET, HEAD');
   assertSecurityHeaders(response);
  }
 } finally {
  await new Promise(resolve => server.close(resolve));
 }
});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,cp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('CLI starts from a path containing spaces and Turkish characters', {timeout:10000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ordvis türkçe '));
 let child;
 try{
  await cp(new URL('../server.mjs',import.meta.url),join(dir,'server.mjs'));
  await mkdir(join(dir,'node_modules'),{recursive:true});
  await cp(new URL('../node_modules/undici',import.meta.url),join(dir,'node_modules','undici'),{recursive:true});
  await cp(new URL('../lib',import.meta.url),join(dir,'lib'),{recursive:true});
  await cp(new URL('../public',import.meta.url),join(dir,'public'),{recursive:true});
  child=spawn(process.execPath,[join(dir,'server.mjs')],{cwd:dir,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  const output=await Promise.race([once(child.stdout,'data').then(([data])=>data.toString()),once(child,'exit').then(([code])=>{throw new Error(`CLI exited before listening: ${code}`);})]);
  assert.match(output,/Ordvis Creative listening on 0/);
 }finally{
  if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  await rm(dir,{recursive:true,force:true});
 }
});
