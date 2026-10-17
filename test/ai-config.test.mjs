import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/store.mjs';
test('Groq credential is encrypted with a separate purpose and settings never expose it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ordvis-ai-config-'));let store;
 const key='gsk_only_a_test_fixture_secret_not_a_real_key';
 try{store=new Store({dataDir:dir});store.setAiKey(key);assert.equal(store.getAiCredentials().apiKey,key);assert.equal(JSON.stringify(store.getAutomationSettings()).includes(key),false);assert.equal(store.getAutomationSettings().enabled,false);const encrypted=store.db.prepare('SELECT api_key_encrypted FROM automation_settings').get().api_key_encrypted;assert.ok(!encrypted.includes(key));assert.throws(()=>store.decryptSecret(encrypted));store.close();store=null;const bytes=await readFile(join(dir,'ordvis.sqlite'));assert.equal(bytes.includes(Buffer.from(key)),false);store=new Store({dataDir:dir});assert.equal(store.getAiCredentials().apiKey,key);}finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
test('missing encryption key fails closed even when only Groq, not MFA, was configured',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ordvis-ai-missing-key-'));try{const store=new Store({dataDir:dir});store.setAiKey('gsk_test_fixture_with_no_mfa_owner');store.close();await unlink(join(dir,'mfa.key'));assert.throws(()=>new Store({dataDir:dir}),/anahtar dosyası eksik/);await assert.rejects(readFile(join(dir,'mfa.key')),{code:'ENOENT'});}finally{await rm(dir,{recursive:true,force:true});}
});
