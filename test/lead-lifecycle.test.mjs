import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {createAutomation} from '../lib/automation.mjs';
import {generateSecret, generateRecoveryCodes} from '../lib/mfa.mjs';

const origin = 'http://localhost:3000';
const username = 'lifecycle-test-admin';
const password = 'Private-lifecycle-test-password-2026!';
const details = {
 brand: 'Yaşam Döngüsü Testi', name: 'Deniz Örnek', email: 'deniz@example.invalid',
 phone: '', plan: 'Tek seferlik proje', brief: 'Yeni ürünümüz için kısa bir tanıtım filmi istiyoruz.',
};
const aiResult = {summary: 'Ürün tanıtımı talebi.', needs: ['Çekim tarihi'], nextStep: 'Tarihi netleştirin.'};

async function start(dataDir) {
 const server = createServer({dataDir, publicOrigin: origin, secureCookies: false, aiConfig: () => ({apiKey: ''})});
 await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
 });
 const base = `http://127.0.0.1:${server.address().port}`;
 return {
  server,
  close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  request(path, {method = 'GET', body, cookie, csrf, headers = {}} = {}) {
   return fetch(base + path, {
    method,
    headers: {
     ...(method === 'GET' ? {} : {'Origin': origin, 'Content-Type': 'application/json'}),
     ...(cookie ? {'Cookie': cookie} : {}), ...(csrf ? {'X-CSRF-Token': csrf} : {}), ...headers,
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
   });
  },
 };
}

async function fixture(t, {mfa = true} = {}) {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-lifecycle-'));
 const recoveryCodes = generateRecoveryCodes();
 const store = new Store({dataDir});
 try {
  await store.initializeAdmin(username, password);
  if (mfa) assert.equal(store.enableMfa(generateSecret(), {
   counter: -1, recoveryCodes, expectedVersion: store.getAdminState().authVersion,
  }), true);
 } finally { store.close(); }
 const app = await start(dataDir);
 t.after(async () => {
  if (app.server.listening) await app.close();
  await rm(dataDir, {recursive: true, force: true});
 });
 return {...app, dataDir, recoveryCodes};
}

async function login(app, code = app.recoveryCodes[0]) {
 const response = await app.request('/api/admin/login', {method: 'POST', body: {username, password, code}});
 assert.equal(response.status, 200, await response.clone().text());
 const session = await response.json();
 return {cookie: response.headers.get('set-cookie').split(';')[0], csrf: session.csrfToken, session};
}

async function submit(app) {
 const response = await app.request('/api/leads', {method: 'POST', body: {...details, consent: true, website: ''}});
 assert.equal(response.status, 201, await response.clone().text());
 return (await response.json()).id;
}

async function inbox(app, auth) {
 const response = await app.request('/api/admin/leads', auth);
 assert.equal(response.status, 200, await response.clone().text());
 return response.json();
}

const leadPath = id => `/api/admin/leads/${id}`;
const complete = (amount = '12500,50') => ({status: 'completed', notes: 'Ödeme alındı; teslim edildi.', paymentReceived: amount});

test('completed projects persist exact kuruş and completion time across restart and reopening', async t => {
 const app = await fixture(t);
 const id = await submit(app);
 const auth = await login(app);
 const first = (await inbox(app, auth)).leads[0];
 assert.equal(first.paymentReceivedCents, null);
 assert.equal(first.completedAt, null);
 const response = await app.request(leadPath(id), {method: 'PATCH', ...auth, body: complete()});
 assert.equal(response.status, 200, await response.clone().text());
 const saved = await inbox(app, auth);
 assert.equal(saved.counts.new, 0);
 assert.equal(saved.counts.completed, 1);
 assert.equal(saved.counts.total, 1);
 const completed = saved.leads[0];
 assert.equal(completed.status, 'completed');
 assert.equal(completed.paymentReceivedCents, 1_250_050);
 assert.equal(completed.notes, complete().notes);
 assert.equal(new Date(completed.completedAt).toISOString(), completed.completedAt);
 await app.close();
 const reopened = await start(app.dataDir);
 try {
  const fresh = await login({...reopened, recoveryCodes: app.recoveryCodes}, app.recoveryCodes[1]);
  const persisted = (await inbox(reopened, fresh)).leads[0];
  assert.equal(persisted.paymentReceivedCents, completed.paymentReceivedCents);
  assert.equal(persisted.completedAt, completed.completedAt);
  const move = await reopened.request(leadPath(id), {method: 'PATCH', ...fresh, body: {status: 'contacted', notes: 'Ek iş için yeniden açıldı.'}});
  assert.equal(move.status, 200, await move.clone().text());
  const active = await inbox(reopened, fresh);
  assert.equal(active.counts.completed, 0);
  assert.equal(active.counts.contacted, 1);
  assert.equal(active.leads[0].paymentReceivedCents, completed.paymentReceivedCents, 'reopening retains the historical received amount');
  assert.equal(active.leads[0].completedAt, completed.completedAt, 'reopening retains the historical completion time');
 } finally { await reopened.close(); }
});

test('completion requires a positive bounded decimal string and invalid amounts never mutate the lead', async t => {
 const app = await fixture(t);
 const id = await submit(app);
 const auth = await login(app);
 const before = (await inbox(app, auth)).leads[0];
 for (const paymentReceived of [undefined, null, 100, 0, '', '0', '0,00', '-1', '+1', '1e3', '12.345', '12,345', '1.000,00', '1,000.00', 'NaN', 'Infinity', '1000000000', '999999999.999']) {
  const response = await app.request(leadPath(id), {method: 'PATCH', ...auth, body: {...complete(), paymentReceived}});
  assert.equal(response.status, 400, `invalid amount ${String(paymentReceived)}: ${await response.clone().text()}`);
  const current = (await inbox(app, auth)).leads[0];
  for (const field of ['status', 'notes', 'paymentReceivedCents', 'completedAt']) assert.equal(current[field], before[field], `invalid amount must preserve ${field}`);
 }
 for (const [amount, cents] of [['0.01', 1], ['12500.5', 1_250_050], ['999999999,99', 99_999_999_999]]) {
  const response = await app.request(leadPath(id), {method: 'PATCH', ...auth, body: complete(amount)});
  assert.equal(response.status, 200, `${amount}: ${await response.clone().text()}`);
  assert.equal((await inbox(app, auth)).leads[0].paymentReceivedCents, cents);
 }
 const missingOnEdit = await app.request(leadPath(id), {method: 'PATCH', ...auth, body: {status: 'completed', notes: 'Miktarsız düzenleme'}});
 assert.equal(missingOnEdit.status, 400, 'editing a completed project also validates its payment');
 assert.equal((await inbox(app, auth)).leads[0].paymentReceivedCents, 99_999_999_999);
});

test('permanent deletion requires full authorization, CSRF, same origin, and an explicit confirmation', async t => {
 const app = await fixture(t);
 const id = await submit(app);
 const path = leadPath(id);
 assert.equal((await app.request(path, {method: 'DELETE', body: {confirmation: 'SİL'}})).status, 401);
 const auth = await login(app);
 for (const options of [
  {cookie: auth.cookie},
  {...auth, csrf: 'forged-token'},
  {...auth, headers: {'Origin': 'https://untrusted.example'}},
  {...auth, headers: {'Origin': ''}},
 ]) {
  assert.equal((await app.request(path, {method: 'DELETE', ...options, body: {confirmation: 'SİL'}})).status, 403);
 }
 for (const body of [{}, {confirmation: true}, {confirmation: 'sil'}, {confirmation: id}]) {
  assert.equal((await app.request(path, {method: 'DELETE', ...auth, body})).status, 400);
 }
 const store = new Store({dataDir: app.dataDir});
 try {
  store.recordAiSuccess({id}, aiResult);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ai_jobs WHERE lead_id=?').get(id).n, 1);
 } finally { store.close(); }
 const deleted = await app.request(path, {method: 'DELETE', ...auth, body: {confirmation: 'SİL'}});
 assert.equal(deleted.status, 200, await deleted.clone().text());
 assert.match(deleted.headers.get('cache-control'), /no-store/);
 const after = await inbox(app, auth);
 assert.equal(after.leads.length, 0);
 assert.equal(after.counts.total, 0);
 assert.equal((await app.request(path, {method: 'DELETE', ...auth, body: {confirmation: 'SİL'}})).status, 404);
 const persisted = new Store({dataDir: app.dataDir});
 try {
  for (const table of ['leads', 'ai_summaries', 'ai_jobs']) {
   const column = table === 'leads' ? 'id' : 'lead_id';
   assert.equal(persisted.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(id).n, 0, `${table} is cleared atomically`);
  }
 } finally { persisted.close(); }
});

test('password-only MFA setup sessions cannot complete or delete customer records', async t => {
 const app = await fixture(t, {mfa: false});
 const id = await submit(app);
 const auth = await login(app);
 assert.equal(auth.session.mfaRequired, true);
 for (const [method, body] of [['PATCH', complete()], ['DELETE', {confirmation: 'SİL'}]]) {
  const response = await app.request(leadPath(id), {method, ...auth, body});
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'MFA_SETUP_REQUIRED');
 }
 const store = new Store({dataDir: app.dataDir});
 try { assert.equal(store.listLeads()[0].status, 'new'); } finally { store.close(); }
});

test('logging out while a delete body arrives revokes the pending deletion', {timeout: 10_000}, async t => {
 const app = await fixture(t);
 const id = await submit(app);
 const auth = await login(app);
 const path = leadPath(id);
 const body = JSON.stringify({confirmation: 'SİL'});
 const split = body.indexOf(':') + 1;
 let observe;
 const receivedPartial = new Promise(resolve => {
  observe = req => {
   if (req.method !== 'DELETE' || req.url !== path) return;
   app.server.off('request', observe);
   req.once('data', () => setImmediate(resolve));
  };
  app.server.on('request', observe);
 });
 let pending;
 const responsePromise = new Promise((resolve, reject) => {
  pending = httpRequest({hostname: '127.0.0.1', port: app.server.address().port, path, method: 'DELETE', headers: {
   'Origin': origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
   'Cookie': auth.cookie, 'X-CSRF-Token': auth.csrf,
  }}, response => {
   const chunks = [];
   response.on('data', chunk => chunks.push(chunk));
   response.on('error', reject);
   response.on('end', () => resolve({status: response.statusCode, text: Buffer.concat(chunks).toString('utf8')}));
  });
  pending.on('error', reject);
 });
 responsePromise.catch(() => {});
 try {
  pending.write(body.slice(0, split));
  await receivedPartial;
  assert.equal((await app.request('/api/admin/logout', {method: 'POST', ...auth, body: {}})).status, 200);
  pending.end(body.slice(split));
  const response = await responsePromise;
  assert.equal(response.status, 401, response.text);
  const fresh = await login(app, app.recoveryCodes[1]);
  assert.equal((await inbox(app, fresh)).leads[0].id, id);
 } finally {
  app.server.off('request', observe);
  pending.destroy();
 }
});

test('legacy archived records migrate idempotently without losing requests, notes, MFA, or AI data', async t => {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-legacy-lifecycle-'));
 t.after(() => rm(dataDir, {recursive: true, force: true}));
 const recoveryCodes = generateRecoveryCodes();
 let store = new Store({dataDir});
 await store.initializeAdmin(username, password);
 store.enableMfa(generateSecret(), {counter: -1, recoveryCodes, expectedVersion: store.getAdminState().authVersion});
 const requestId = 'e84155e3-4f85-4b61-bd75-49e33193d722';
 const id = store.createLead({...details, requestId}).id;
 store.updateLead(id, {status: 'archived', notes: 'Arşivdeki eski işin özgün notu.'});
 store.recordAiSuccess({id: store.createLead({...details, name: 'Aktif müşteri'}).id}, aiResult);
 store.setAiKey('gsk_legacy_fixture_not_a_real_secret');
 const admin = store.getAdminState();
 const expectedLead = store.listLeads().find(item => item.id === id);
 const expectedSummaries = store.listAiSummaries();
 store.close();
 // Recreate the previous released schema, which could not store completed jobs.
 const legacy = new DatabaseSync(join(dataDir, 'ordvis.sqlite'));
 try {
  legacy.exec(`BEGIN IMMEDIATE;
   ALTER TABLE leads RENAME TO fixture_leads;
   DROP INDEX leads_created_at;
   CREATE TABLE leads (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,brand TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,plan TEXT NOT NULL,brief TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','archived')),notes TEXT NOT NULL DEFAULT '',consent_at TEXT NOT NULL,request_id TEXT UNIQUE);
   INSERT INTO leads SELECT id,created_at,brand,name,email,phone,plan,brief,status,notes,consent_at,request_id FROM fixture_leads;
   DROP TABLE fixture_leads;
   CREATE INDEX leads_created_at ON leads(created_at DESC);
   COMMIT;`);
 } finally { legacy.close(); }
 for (let attempt = 0; attempt < 2; attempt++) {
  store = new Store({dataDir});
  try {
   const actual = store.listLeads().find(item => item.id === id);
   for (const field of ['id', 'createdAt', 'brand', 'name', 'email', 'phone', 'plan', 'brief', 'status', 'notes', 'consentAt']) assert.equal(actual[field], expectedLead[field], `migration preserves ${field}`);
   assert.equal(actual.paymentReceivedCents, null, 'migration does not invent old payment amounts');
   assert.equal(actual.completedAt, null);
   assert.equal(store.findRequest(requestId), id);
   assert.equal(store.getAdminState().authVersion, admin.authVersion);
   assert.equal(store.getAdminState().mfaEnabled, true);
   assert.equal(await store.verifyAdmin(username, password), true);
   assert.equal(store.getAiCredentials().apiKey, 'gsk_legacy_fixture_not_a_real_secret');
   assert.deepEqual(store.listAiSummaries(), expectedSummaries);
   assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
   if (attempt === 1) {
    assert.equal(store.verifyMfa(recoveryCodes[0]), true, 'existing recovery hashes remain usable');
    assert.equal(store.updateLead(id, {status: 'completed', notes: actual.notes, paymentReceivedCents: 100}), true, 'migrated CHECK accepts completion');
   }
  } finally { store.close(); }
 }
});

test('AI queue contains active customers and late provider results cannot resurrect closed or deleted leads', async t => {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-lifecycle-ai-'));
 const store = new Store({dataDir});
 t.after(async () => { store.close(); await rm(dataDir, {recursive: true, force: true}); });
 const ids = Array.from({length: 4}, (_, index) => store.createLead({...details, name: `Müşteri ${index}`}).id);
 store.updateLead(ids[1], {status: 'contacted', notes: ''});
 store.updateLead(ids[2], {status: 'archived', notes: ''});
 store.updateLead(ids[3], {status: 'completed', notes: '', paymentReceivedCents: 100});
 assert.deepEqual(new Set(store.pendingAiLeads(10).map(item => item.id)), new Set(ids.slice(0, 2)));
 assert.equal(store.aiPendingCount(), 2);
 store.deleteLead(ids[0]);
 for (const id of [ids[0], ids[2], ids[3]]) {
  store.recordAiSuccess({id}, aiResult);
  store.recordAiFailure({id}, 'INVALID_OUTPUT');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ai_summaries WHERE lead_id=?').get(id).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ai_jobs WHERE lead_id=?').get(id).n, 0);
 }
});

test('an AI batch rechecks each selected lead and discards an in-flight completion result', async t => {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-lifecycle-worker-'));
 const store = new Store({dataDir});
 let now = Date.parse('2026-10-17T09:00:00.000Z');
 let release;
 let started;
 let calls = 0;
 const didStart = new Promise(resolve => { started = resolve; });
 const worker = createAutomation({
  store, getConfig: () => ({apiKey: 'gsk_fixture_only_not_a_real_secret'}), now: () => now,
  setTimer: () => ({unref() {}}), clearTimer: () => {},
  summarize: async () => { calls++; started(); return new Promise(resolve => { release = resolve; }); },
 });
 t.after(async () => { worker.close(); store.close(); await rm(dataDir, {recursive: true, force: true}); });
 // Distinct creation timestamps make the selected batch order deterministic.
 const first = store.createLead({...details, name: 'İlk müşteri'}).id;
 const second = store.createLead({...details, name: 'İkinci müşteri'}).id;
 const third = store.createLead({...details, name: 'Üçüncü müşteri'}).id;
 store.db.prepare('UPDATE leads SET created_at=? WHERE id=?').run('2026-10-17T07:00:00.000Z', first);
 store.db.prepare('UPDATE leads SET created_at=? WHERE id=?').run('2026-10-17T08:00:00.000Z', second);
 store.db.prepare('UPDATE leads SET created_at=? WHERE id=?').run('2026-10-17T08:30:00.000Z', third);
 worker.setEnabled(true);
 now += 3_600_000;
 const running = worker.tick();
 await didStart;
 store.updateLead(first, {status: 'completed', notes: 'İş bitti.', paymentReceivedCents: 100});
 store.updateLead(second, {status: 'archived', notes: 'Bu müşteri kapatıldı.'});
 store.deleteLead(third);
 release(aiResult);
 await running;
 assert.equal(calls, 1, 'queued customers archived or deleted during an earlier request are not sent to the provider');
 assert.equal(store.listAiSummaries().length, 0, 'the in-flight completed customer is not committed');
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get().n, 0);
 assert.equal(worker.status().pendingCount, 0);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ai_attempts').get().n, 1, 'skipped leads do not consume provider quota');
});
