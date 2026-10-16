import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../server.mjs';
test('public content, security policy and route isolation',async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const base=`http://127.0.0.1:${server.address().port}`;const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/Ordvis Creative/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('x-content-type-options'),'nosniff');for(const route of ['/package.json','/server.mjs','/.env','/.git/config','/%2e%2e/server.mjs'])assert.equal((await fetch(base+route)).status,404);assert.equal((await fetch(base,{method:'POST',body:'secret'})).status,405);const pdf=await fetch(base+'/ordvis-katalog-2026.pdf');assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.equal((await pdf.text()).slice(0,5),'%PDF-');const head=await fetch(base,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');}finally{await new Promise(resolve=>server.close(resolve));}});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('CLI starts from a path containing spaces and Turkish characters', {timeout:10000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ordvis türkçe '));
 let child;
 try{
  await cp(new URL('../server.mjs',import.meta.url),join(dir,'server.mjs'));
  await cp(new URL('../public',import.meta.url),join(dir,'public'),{recursive:true});
  child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  const output=await Promise.race([once(child.stdout,'data').then(([data])=>data.toString()),once(child,'exit').then(([code])=>{throw new Error(`CLI exited before listening: ${code}`);})]);
  assert.match(output,/Ordvis Creative listening on 0/);
 }finally{
  if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  await rm(dir,{recursive:true,force:true});
 }
});
