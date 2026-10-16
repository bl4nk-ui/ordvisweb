import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {generateSecret,generateRecoveryCodes} from '../lib/mfa.mjs';
const fixtureRecoveryCodes=generateRecoveryCodes();

const origin = 'http://localhost:3000';
const username = 'ordvis-admin';
const password = 'Ordvis-test-password-2026!';
const lead = {
 brand: 'Örnek Marka',
 name: 'Çağrı Yılmaz',
 email: 'cagri@example.com',
 phone: '05307168808',
 plan: 'Birlikte karar verelim',
 brief: 'Yeni ürünümüz için drone çekimi ve bir lansman filmi istiyoruz.',
 consent: true,
 website: '',
};

async function start(dataDir, options = {}) {
 const requestOrigin = options.publicOrigin ?? origin;
 const server = createServer({dataDir, publicOrigin: origin, secureCookies: false, ...options});
 await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
 });
 const base = `http://127.0.0.1:${server.address().port}`;
 return {
  server,
  async close() {
   await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  },
  request(path, {method = 'GET', body, rawBody, cookie, csrf, headers = {}} = {}) {
   return fetch(base + path, {
    method,
    headers: {
     ...(method !== 'GET' ? {'Origin': requestOrigin, 'Content-Type': 'application/json'} : {}),
     ...(cookie ? {'Cookie': cookie} : {}),
     ...(csrf ? {'X-CSRF-Token': csrf} : {}),
     ...headers,
    },
    ...(rawBody !== undefined ? {body: rawBody} : body !== undefined ? {body: JSON.stringify(body)} : {}),
   });
  },
 };
}

async function fixture(t, options = {}) {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-inbox-test-'));
 const store = new Store({dataDir});
 try {
  await store.initializeAdmin(username, password);
  store.enableMfa(generateSecret(),{counter:-1,recoveryCodes:fixtureRecoveryCodes,expectedVersion:store.getAdminState().authVersion});
 } finally {
  await store.close();
 }
 const app = await start(dataDir, options);
 t.after(async () => {
  if (app.server.listening) await app.close();
  await rm(dataDir, {recursive: true, force: true});
 });
 return {...app, dataDir};
}

async function login(app) {
 const response = await app.request('/api/admin/login', {method: 'POST', body: {username, password,code:fixtureRecoveryCodes[0]}});
 assert.equal(response.status, 200, await response.clone().text());
 const setCookie = response.headers.get('set-cookie');
 assert.match(setCookie,/^(?:__Host-)?ordvis_session=/,'login sets the session cookie');
 assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
 assert.match(setCookie, /;\s*SameSite=(?:Strict|Lax)(?:;|$)/i);
 assert.match(setCookie, /;\s*Path=\/(?:;|$)/i);
 const cookie = setCookie.split(';')[0];
 const sessionResponse = await app.request('/api/admin/session', {cookie});
 assert.equal(sessionResponse.status, 200);
 assert.match(sessionResponse.headers.get('cache-control'), /no-store/);
 const session = await sessionResponse.json();
 assert.equal(session.username, username);
 assert.equal(typeof session.csrfToken, 'string');
 assert.ok(session.csrfToken.length >= 32, 'session has an unpredictable CSRF token');
 return {cookie, csrf: session.csrfToken};
}

async function submit(app, details = lead) {
 const response = await app.request('/api/leads', {method: 'POST', body: details});
 assert.equal(response.status, 201, await response.clone().text());
 const result = await response.json();
 assert.ok(result.id, 'submission returns a lead ID');
 assert.equal(typeof result.message, 'string');
 return result.id;
}

async function filesUnder(dir) {
 const files = [];
 for (const entry of await readdir(dir, {withFileTypes: true})) {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) files.push(...await filesUnder(path));
  else if (entry.isFile()) files.push(path);
 }
 return files;
}

test('contact requests survive a server restart and remain private', async t => {
 const app = await fixture(t);
 const id = await submit(app);
 assert.equal((await app.request('/api/admin/leads')).status, 401);
 assert.equal((await app.request('/api/admin/session')).status, 401);
 await app.close();
 const reopened = await start(app.dataDir);
 try {
  const auth = await login(reopened);
  const response = await reopened.request('/api/admin/leads', auth);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const {leads, counts} = await response.json();
  assert.equal(leads.length, 1);
  assert.equal(String(leads[0].id), String(id));
  for (const field of ['brand', 'name', 'email', 'phone', 'plan', 'brief']) {
   assert.equal(leads[0][field], lead[field], `${field} survives restart`);
  }
  assert.equal(leads[0].status, 'new');
  assert.equal(typeof counts, 'object');
 } finally {
  await reopened.close();
 }
});

test('admin credentials are hashed in persistent storage and wrong credentials cannot enter', async t => {
 const app = await fixture(t);
 const rejected = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password: 'wrong-password'},
 });
 assert.equal(rejected.status, 401);
 assert.ok(!rejected.headers.get('set-cookie'), 'failed login grants no session');
 await login(app);
 await app.close();
 const files = await filesUnder(app.dataDir);
 assert.ok(files.length > 0, 'the account was persisted');
 for (const path of files) {
  const contents = await readFile(path);
  assert.equal(contents.includes(Buffer.from(password)), false, 'the plaintext password is never persisted');
 }
});

test('contact submissions require a valid same-origin JSON request and consent', async t => {
 const app = await fixture(t);
 const foreign = await app.request('/api/leads', {
  method: 'POST', body: lead, headers: {'Origin': 'https://untrusted.example'},
 });
 assert.equal(foreign.status, 403);
 const noOrigin = await app.request('/api/leads', {
  method: 'POST', body: lead, headers: {'Origin': ''},
 });
 assert.equal(noOrigin.status, 403);
 const nonJson = await app.request('/api/leads', {
  method: 'POST', body: lead, headers: {'Content-Type': 'text/plain'},
 });
 assert.equal(nonJson.status, 415);
 const malformed = await app.request('/api/leads', {method: 'POST', rawBody: '{invalid'});
 assert.equal(malformed.status, 400);
 for (const invalid of [
  {...lead, brand: ''},
  {...lead, name: ''},
  {...lead, email: 'not-an-email'},
  {...lead, consent: false},
  {...lead, consent: 'true'},
  {...lead, brief: ''},
  {...lead, plan: 'unknown-plan'},
 ]) {
  const response = await app.request('/api/leads', {method: 'POST', body: invalid});
  assert.equal(response.status, 400, JSON.stringify(invalid));
 }
 const auth = await login(app);
 const result = await app.request('/api/admin/leads', auth);
 assert.equal((await result.json()).leads.length, 0, 'invalid requests create no inbox entries');
 const honeypot = await app.request('/api/leads', {method: 'POST', body: {...lead, website: 'https://spam.example'}});
 assert.equal(honeypot.status, 201, 'honeypot does not reveal bot filtering');
 const filtered = await app.request('/api/admin/leads', auth);
 assert.equal((await filtered.json()).leads.length, 0, 'honeypot submissions never reach the inbox');
});

test('admin updates require authentication, a valid CSRF token, and a same-origin request', async t => {
 const app = await fixture(t);
 const scriptText = '<img src=x onerror=alert(document.cookie)>';
 const id = await submit(app, {...lead, brief: scriptText});
 const path = `/api/admin/leads/${id}`;
 const change = {status: 'contacted', notes: '<script>alert("admin")</script>'};
 assert.equal((await app.request(path, {method: 'PATCH', body: change})).status, 401);
 const auth = await login(app);
 assert.equal((await app.request(path, {method: 'PATCH', cookie: auth.cookie, body: change})).status, 403);
 assert.equal((await app.request(path, {method: 'PATCH', ...auth, csrf: 'invalid-token', body: change})).status, 403);
 assert.equal((await app.request(path, {
  method: 'PATCH', ...auth, body: change, headers: {'Origin': 'https://untrusted.example'},
 })).status, 403);
 const changed = await app.request(path, {method: 'PATCH', ...auth, body: change});
 assert.equal(changed.status, 200, await changed.clone().text());
 const response = await app.request('/api/admin/leads', auth);
 assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
 const {leads} = await response.json();
 assert.equal(leads[0].status, 'contacted');
 assert.equal(leads[0].brief, scriptText, 'user content stays JSON text');
 assert.equal(leads[0].notes, change.notes, 'notes stay JSON text');
 const invalid = await app.request(path, {method: 'PATCH', ...auth, body: {status: 'unexpected'}});
 assert.equal(invalid.status, 400);
});

test('logout revokes the session and prevents cookie replay', async t => {
 const app = await fixture(t);
 const auth = await login(app);
 const missingToken = await app.request('/api/admin/logout', {method: 'POST', cookie: auth.cookie, body: {}});
 assert.equal(missingToken.status, 403);
 const response = await app.request('/api/admin/logout', {method: 'POST', ...auth, body: {}});
 assert.equal(response.status, 200);
 assert.match(response.headers.get('set-cookie'), /Max-Age=0/i);
 assert.equal((await app.request('/api/admin/session', auth)).status, 401);
 assert.equal((await app.request('/api/admin/leads', auth)).status, 401);
});


test('public inbox limits repeated submissions without dropping accepted requests', async t => {
 const app = await fixture(t);
 for (let index = 0; index < 5; index++) await submit(app, {...lead, brand: `Marka ${index}`});
 const limited = await app.request('/api/leads', {method: 'POST', body: lead});
 assert.equal(limited.status, 429);
 assert.ok(Number(limited.headers.get('retry-after')) > 0, 'the sender knows when to retry');
 const auth = await login(app);
 const response = await app.request('/api/admin/leads', auth);
 assert.equal((await response.json()).leads.length, 5);
});

test('repeated failed logins are rate limited before brute force can continue', async t => {
 const app = await fixture(t);
 for (let index = 0; index < 5; index++) {
  const response = await app.request('/api/admin/login', {
   method: 'POST', body: {username, password: `wrong-password-${index}`},
  });
  assert.equal(response.status, 401);
 }
 const limited = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password: 'another-wrong-password'},
 });
 assert.equal(limited.status, 429);
 assert.ok(Number(limited.headers.get('retry-after')) > 0);
 assert.equal(limited.headers.get('set-cookie'), null, 'a limited login cannot establish a session');
});


test('request IDs deduplicate retries, including retries after the submission quota is reached', async t => {
 const app = await fixture(t);
 const requestId = randomUUID();
 const first = await submit(app, {...lead, requestId});
 const retries = await Promise.all([
  submit(app, {...lead, requestId}),
  submit(app, {...lead, requestId, brand: 'Tekrar gönderilen farklı marka'}),
 ]);
 assert.deepEqual(retries, [first, first], 'retries return the original lead ID');
 for (let index = 0; index < 4; index++) await submit(app, {...lead, requestId: randomUUID()});
 const afterQuota = await submit(app, {...lead, requestId});
 assert.equal(afterQuota, first, 'an accepted request can be retried after the quota is filled');
 const limited = await app.request('/api/leads', {method: 'POST', body: {...lead, requestId: randomUUID()}});
 assert.equal(limited.status, 429, 'deduplication does not increase the submission quota');
 const auth = await login(app);
 const response = await app.request('/api/admin/leads', auth);
 const {leads, counts} = await response.json();
 assert.equal(leads.length, 5);
 assert.equal(counts.total, 5);
 assert.equal(leads.find(item => item.id === first).brand, lead.brand, 'a replay does not overwrite stored contact details');
});

test('bodies larger than 16 KiB are rejected without crashing the server or creating a lead', async t => {
 const app = await fixture(t);
 const oversized = await app.request('/api/leads', {
  method: 'POST', body: {...lead, brief: 'A'.repeat(17 * 1024)},
 });
 assert.equal(oversized.status, 413);
 assert.match(oversized.headers.get('content-type'), /application\/json/);
 await submit(app);
 const auth = await login(app);
 const response = await app.request('/api/admin/leads', auth);
 assert.equal((await response.json()).leads.length, 1);
});

test('HTTPS configuration makes admin session and logout cookies Secure', async t => {
 const app = await fixture(t, {publicOrigin: 'https://ordvis.example', secureCookies: undefined});
 const response = await app.request('/api/admin/login', {method: 'POST', body: {username, password,code:fixtureRecoveryCodes[0]}});
 assert.equal(response.status, 200);
 const setCookie = response.headers.get('set-cookie');
 assert.match(setCookie, /;\s*Secure(?:;|$)/i);
 assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
 const cookie = setCookie.split(';')[0];
 const session = await app.request('/api/admin/session', {cookie});
 const {csrfToken} = await session.json();
 const logout = await app.request('/api/admin/logout', {method: 'POST', body: {}, cookie, csrf: csrfToken});
 assert.equal(logout.status, 200);
 assert.match(logout.headers.get('set-cookie'), /;\s*Secure(?:;|$)/i);
 assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);
});

test('concurrent failed logins cannot bypass the five-attempt rate limit', async t => {
 const app = await fixture(t);
 const responses = await Promise.all(Array.from({length: 12}, (_, index) => app.request('/api/admin/login', {
  method: 'POST', body: {username, password: `concurrent-wrong-${index}`},
 })));
 assert.equal(responses.filter(response => [401,503].includes(response.status)).length, 5);
 assert.ok(responses.filter(response => response.status === 401).length<=2,'concurrent scrypt work is bounded');
 assert.ok(responses.some(response=>response.status===503),'excess concurrent hashing is refused');
 assert.equal(responses.filter(response => response.status === 429).length, 7);
 for (const response of responses) assert.equal(response.headers.get('set-cookie'), null);
 const followup = await app.request('/api/admin/login', {method: 'POST', body: {username, password: 'wrong-again'}});
 assert.equal(followup.status, 429);
});

test('database files and backend source are never exposed as public assets', async t => {
 const app = await fixture(t);
 for (const path of [
  '/.data/mfa.key', '/.data/ordvis.sqlite', '/.data/ordvis.sqlite-wal', '/.data/ordvis.sqlite-shm',
  '/lib/store.mjs', '/lib/api.mjs', '/test/inbox.test.mjs',
 ]) {
  const response = await app.request(path);
  assert.equal(response.status, 404, path);
  assert.doesNotMatch(await response.text(), /SQLite format|password_hash|DatabaseSync/);
 }
});
