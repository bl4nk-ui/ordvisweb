import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {generateSecret, generateRecoveryCodes} from '../lib/mfa.mjs';

const origin = 'http://localhost:3000';
const username = 'automation-test-admin';
const password = 'Ordvis-private-automation-password-2026!';
const apiKey = 'gsk_test_automation_private_api_key';
const endpoint = '/api/admin/automation';

async function fixture(t, {mfaEnabled = true} = {}) {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-automation-api-'));
 const store = new Store({dataDir});
 const recoveryCodes = generateRecoveryCodes();
 try {
  await store.initializeAdmin(username, password);
  if (mfaEnabled) assert.equal(store.enableMfa(generateSecret(), {
   counter: -1, recoveryCodes, expectedVersion: store.getAdminState().authVersion,
  }), true);
  store.createLead({
   name: 'PRIVATE_NAME', brand: 'PRIVATE_BRAND', email: 'private@example.invalid',
   phone: '05001234567', plan: 'Vitrin', brief: 'Yeni ürünümüz için bir tanıtım filmi istiyoruz.',
  });
 } finally { store.close(); }
 let now = Date.parse('2026-10-17T09:00:00.000Z');
 let calls = 0;
 const timers = new Map();
 const config = {apiKey, model: 'llama-3.3-70b-versatile'};
 const options = {
  dataDir, publicOrigin: origin, secureCookies: false,
  aiConfig: () => config,
  aiSummarize: async () => {
   calls++;
   return {summary: 'Tanıtım filmi talebi.', needs: ['Çekim tarihi'], nextStep: 'Tarihi netleştirin.'};
  },
  automationOptions: {
   now: () => now,
   setTimer(callback, delay) {
    const handle = {unref() { return handle; }};
    timers.set(handle, {callback, delay});
    return handle;
   },
   clearTimer: handle => timers.delete(handle),
  },
 };
 let server;
 let base;
 async function start() {
  server = createServer(options);
  await new Promise((resolve, reject) => {
   server.once('error', reject);
   server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
 }
 const close = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
 await start();
 t.after(async () => {
  if (server.listening) await close();
  await rm(dataDir, {recursive: true, force: true});
 });
 return {
  config, recoveryCodes, timers,
  now: () => now,
  advance: milliseconds => { now += milliseconds; },
  get calls() { return calls; },
  async restart() { await close(); await start(); },
  request(path, {method = 'GET', body, cookie, csrf, headers = {}} = {}) {
   return fetch(base + path, {
    method,
    headers: {
     ...(method === 'GET' ? {} : {'Origin': origin, 'Content-Type': 'application/json'}),
     ...(cookie ? {'Cookie': cookie} : {}),
     ...(csrf ? {'X-CSRF-Token': csrf} : {}),
     ...headers,
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
   });
  },
 };
}

async function login(app, code = app.recoveryCodes[0]) {
 const response = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password, code},
 });
 assert.equal(response.status, 200, await response.clone().text());
 const session = await response.json();
 return {cookie: response.headers.get('set-cookie').split(';')[0], csrf: session.csrfToken, session};
}

test('automation APIs require authentication and fully verified MFA sessions', async t => {
 const app = await fixture(t, {mfaEnabled: false});
 for (const method of ['GET', 'POST']) {
  const response = await app.request(endpoint, {method, ...(method === 'POST' ? {body: {enabled: true}} : {})});
  assert.equal(response.status, 401, method);
  assert.match(response.headers.get('cache-control'), /no-store/);
 }
 const auth = await login(app);
 assert.equal(auth.session.mfaRequired, true);
 for (const method of ['GET', 'POST']) {
  const response = await app.request(endpoint, {...auth, method, ...(method === 'POST' ? {body: {enabled: true}} : {})});
  assert.equal(response.status, 403, method);
  assert.equal((await response.json()).code, 'MFA_SETUP_REQUIRED');
 }
 assert.equal(app.calls, 0);
});

test('automation preference changes enforce CSRF, origin, and boolean validation', async t => {
 const app = await fixture(t);
 const auth = await login(app);
 const read = await app.request(endpoint, auth);
 assert.equal(read.status, 200);
 assert.match(read.headers.get('cache-control'), /no-store/);
 const initial = await read.json();
 assert.equal(initial.enabled, false);
 assert.equal(initial.configured, true);
 assert.equal(initial.provider, 'groq');
 assert.equal(initial.model, app.config.model);
 assert.equal(initial.intervalMinutes, 60);
 assert.equal(initial.pendingCount, 1);
 assert.deepEqual(initial.summaries, []);
 assert.equal(Object.hasOwn(initial, 'apiKey'), false);
 const serialized = JSON.stringify(initial);
 for (const secret of [apiKey, password, 'PRIVATE_NAME', 'PRIVATE_BRAND', 'private@example.invalid', '05001234567']) {
  assert.equal(serialized.includes(secret), false, secret);
 }
 for (const request of [
  {cookie: auth.cookie},
  {...auth, csrf: 'incorrect-token'},
  {...auth, headers: {'Origin': 'https://untrusted.example'}},
  {...auth, headers: {'Origin': ''}},
  {...auth, headers: {'Sec-Fetch-Site': 'cross-site'}},
 ]) {
  const response = await app.request(endpoint, {...request, method: 'POST', body: {enabled: true}});
  assert.equal(response.status, 403);
 }
 for (const enabled of ['true', 1, null, {}, []]) {
  const response = await app.request(endpoint, {...auth, method: 'POST', body: {enabled}});
  assert.equal(response.status, 400);
 }
 assert.equal((await (await app.request(endpoint, auth)).json()).enabled, false);
 assert.equal(app.calls, 0);
});

test('enabling via the API only schedules a future run and its preference survives restart', async t => {
 const app = await fixture(t);
 let auth = await login(app);
 const enable = await app.request(endpoint, {...auth, method: 'POST', body: {enabled: true}});
 assert.equal(enable.status, 200);
 const enabled = await enable.json();
 const due = new Date(app.now() + 3_600_000).toISOString();
 assert.equal(enabled.enabled, true);
 assert.equal(enabled.nextRunAt, due);
 assert.equal(enabled.lastRunAt, null);
 assert.equal(app.calls, 0, 'enabling alone must not send an existing inbox to Groq');
 app.advance(10 * 60_000);
 const repeated = await app.request(endpoint, {...auth, method: 'POST', body: {enabled: true}});
 assert.equal(repeated.status, 200);
 assert.equal((await repeated.json()).nextRunAt, due, 'repeated enable does not postpone the existing schedule');
 await app.restart();
 auth = await login(app, app.recoveryCodes[1]);
 const saved = await app.request(endpoint, auth);
 assert.equal(saved.status, 200);
 const status = await saved.json();
 assert.equal(status.enabled, true);
 assert.equal(status.nextRunAt, due);
 assert.equal(app.calls, 0);
 const disable = await app.request(endpoint, {...auth, method: 'POST', body: {enabled: false}});
 assert.equal(disable.status, 200);
 const disabled = await disable.json();
 assert.equal(disabled.enabled, false);
 assert.equal(disabled.nextRunAt, null);
 assert.equal(app.timers.size, 0);
});
