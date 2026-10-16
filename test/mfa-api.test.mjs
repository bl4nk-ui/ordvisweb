import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {createServer} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {generateRecoveryCodes, generateSecret, totpCode} from '../lib/mfa.mjs';

const origin = 'http://localhost:3000';
const username = 'mfa-api-admin';
const password = 'A-different-MFA-test-password-2026!';

async function start(dataDir, options = {}) {
 const server = createServer({dataDir, publicOrigin: origin, secureCookies: false, ...options});
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
     ...(cookie ? {'Cookie': cookie} : {}),
     ...(csrf ? {'X-CSRF-Token': csrf} : {}),
     ...headers,
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
   });
  },
 };
}

async function fixture(t, {enabled = false, ...options} = {}) {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-mfa-api-'));
 const store = new Store({dataDir});
 const secret = generateSecret();
 const recoveryCodes = generateRecoveryCodes();
 try {
  await store.initializeAdmin(username, password);
  if (enabled) assert.equal(store.enableMfa(secret, {
   counter: Math.floor(Date.now() / 30_000) - 1,
   recoveryCodes,
   expectedVersion: store.getAdminState().authVersion,
  }), true);
 } finally {
  store.close();
 }
 const app = await start(dataDir, options);
 t.after(async () => {
  if (app.server.listening) await app.close();
  await rm(dataDir, {recursive: true, force: true});
 });
 return {...app, dataDir, secret, recoveryCodes};
}

function session(response, data) {
 const cookie = response.headers.get('set-cookie')?.split(';')[0];
 assert.ok(cookie?.startsWith('ordvis_session='));
 assert.match(response.headers.get('set-cookie'), /HttpOnly/);
 assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
 assert.equal(typeof data.csrfToken, 'string');
 assert.ok(data.csrfToken.length >= 32);
 return {cookie, csrf: data.csrfToken};
}

async function login(app, extra = {}) {
 const response = await app.request('/api/admin/login', {method: 'POST', body: {username, password, ...extra}});
 assert.equal(response.status, 200, await response.clone().text());
 const data = await response.json();
 return {...session(response, data), data};
}

async function enroll(app, auth) {
 const setup = await app.request('/api/admin/mfa/setup', {method: 'POST', ...auth, body: {password}});
 assert.equal(setup.status, 200, await setup.clone().text());
 const details = await setup.json();
 assert.match(details.secret, /^[A-Z2-7]{32}$/);
 assert.match(JSON.stringify(details), /otpauth:\/\/totp\//);
 const response = await app.request('/api/admin/mfa/enable', {
  method: 'POST', ...auth, body: {code: totpCode(details.secret)},
 });
 assert.equal(response.status, 200, await response.clone().text());
 const data = await response.json();
 assert.equal(data.recoveryCodes.length, 10);
 return {...session(response, data), secret: details.secret, recoveryCodes: data.recoveryCodes, data};
}

test('password-only sessions can configure security but cannot read private leads or export them', async t => {
 const app = await fixture(t);
 assert.equal((await app.request('/api/admin/security')).status, 401);
 assert.equal((await app.request('/api/admin/assistant-export')).status, 401);
 const auth = await login(app);
 assert.equal(auth.data.mfaEnabled, false);
 assert.equal(auth.data.mfaRequired, true);
 for (const path of ['/api/admin/leads', '/api/admin/assistant-export']) {
  const response = await app.request(path, auth);
  assert.equal(response.status, 403, path);
  assert.equal((await response.json()).code, 'MFA_SETUP_REQUIRED');
 }
 const security = await app.request('/api/admin/security', auth);
 assert.equal(security.status, 200);
 assert.match(security.headers.get('cache-control'), /no-store/);
 assert.doesNotMatch(await security.text(), /otpauth:|password_hash|mfa_secret|recovery_hashes/);
});

test('MFA enrollment requires password reauthentication, CSRF, origin, and a valid current OTP', async t => {
 const app = await fixture(t);
 const auth = await login(app);
 const missingCsrf = await app.request('/api/admin/mfa/setup', {method: 'POST', cookie: auth.cookie, body: {password}});
 assert.equal(missingCsrf.status, 403);
 const foreignOrigin = await app.request('/api/admin/mfa/setup', {
  method: 'POST', ...auth, body: {password}, headers: {'Origin': 'https://untrusted.example'},
 });
 assert.equal(foreignOrigin.status, 403);
 const wrongPassword = await app.request('/api/admin/mfa/setup', {method: 'POST', ...auth, body: {password: 'wrong-password'}});
 assert.equal(wrongPassword.status, 401);
 const noChallenge = await app.request('/api/admin/mfa/enable', {method: 'POST', ...auth, body: {code: '123456'}});
 assert.ok([400, 409].includes(noChallenge.status), await noChallenge.text());
 const setup = await app.request('/api/admin/mfa/setup', {method: 'POST', ...auth, body: {password}});
 assert.equal(setup.status, 200);
 const {secret} = await setup.json();
 const malformed = await app.request('/api/admin/mfa/enable', {method: 'POST', ...auth, body: {code: '12345'}});
 assert.ok([400, 401].includes(malformed.status), await malformed.text());
 const stillRestricted = await app.request('/api/admin/leads', auth);
 assert.equal(stillRestricted.status, 403, 'unverified setup never grants inbox access');
 const enabled = await app.request('/api/admin/mfa/enable', {method: 'POST', ...auth, body: {code: totpCode(secret)}});
 assert.equal(enabled.status, 200, await enabled.clone().text());
});

test('successful enrollment rotates sessions, invalidates all old cookies, and never repeats recovery codes', async t => {
 const app = await fixture(t);
 const first = await login(app);
 const second = await login(app);
 const full = await enroll(app, first);
 assert.notEqual(full.cookie, first.cookie);
 assert.notEqual(full.csrf, first.csrf);
 assert.equal((await app.request('/api/admin/session', first)).status, 401);
 assert.equal((await app.request('/api/admin/session', second)).status, 401);
 const current = await app.request('/api/admin/session', full);
 assert.equal(current.status, 200);
 const data = await current.json();
 assert.equal(data.mfaEnabled, true);
 assert.equal(data.mfaRequired, false);
 assert.equal((await app.request('/api/admin/leads', full)).status, 200);
 for (const path of ['/api/admin/security', '/api/admin/session', '/api/admin/assistant-export']) {
  const response = await app.request(path, full);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const text = await response.text();
  assert.ok(!text.includes(full.secret), 'setup secret is never returned again');
  for (const code of full.recoveryCodes) assert.ok(!text.includes(code), 'recovery codes are shown once');
 }
});

test('enabled accounts need a second factor and consumed TOTP and recovery codes cannot be replayed', async t => {
 const app = await fixture(t, {enabled: true});
 const missing = await app.request('/api/admin/login', {method: 'POST', body: {username, password}});
 assert.equal(missing.status, 401);
 assert.equal((await missing.json()).code, 'MFA_CODE_REQUIRED');
 assert.equal(missing.headers.get('set-cookie'), null);
 const invalid = await app.request('/api/admin/login', {method: 'POST', body: {username, password, code: 'invalid'}});
 assert.equal(invalid.status, 401);
 assert.equal((await invalid.json()).code, 'MFA_INVALID');
 const code = totpCode(app.secret);
 const auth = await login(app, {code});
 assert.equal(auth.data.mfaEnabled, true);
 assert.equal(auth.data.mfaRequired, false);
 const replay = await app.request('/api/admin/login', {method: 'POST', body: {username, password, code}});
 assert.equal(replay.status, 401);
 const recovered = await login(app, {code: app.recoveryCodes[0].toLowerCase()});
 assert.equal((await app.request('/api/admin/leads', recovered)).status, 200);
 const recoveryReplay = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password, code: app.recoveryCodes[0]},
 });
 assert.equal(recoveryReplay.status, 401);
 assert.equal(recoveryReplay.headers.get('set-cookie'), null);
});

test('concurrent recovery logins permit exactly one successful consumption and stay consumed after restart', async t => {
 const app = await fixture(t, {enabled: true});
 const results = await Promise.all(Array.from({length: 2}, () => app.request('/api/admin/login', {
  method: 'POST', body: {username, password, code: app.recoveryCodes[0]},
 })));
 assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
 await app.close();
 const restarted = await start(app.dataDir);
 try {
  const replay = await restarted.request('/api/admin/login', {
   method: 'POST', body: {username, password, code: app.recoveryCodes[0]},
  });
  assert.equal(replay.status, 401);
  await login(restarted, {code: app.recoveryCodes[1]});
 } finally {
  await restarted.close();
 }
});

test('a password change immediately revokes existing sessions while preserving the second factor', async t => {
 const app = await fixture(t, {enabled: true});
 const auth = await login(app, {code: app.recoveryCodes[0]});
 const changedPassword = 'A-changed-secure-password-2026!';
 const store = new Store({dataDir: app.dataDir});
 try {
  await store.initializeAdmin(username, changedPassword);
 } finally {
  store.close();
 }
 assert.equal((await app.request('/api/admin/session', auth)).status, 401);
 assert.equal((await app.request('/api/admin/leads', auth)).status, 401);
 const noFactor = await app.request('/api/admin/login', {method: 'POST', body: {username, password: changedPassword}});
 assert.equal(noFactor.status, 401);
 assert.equal((await noFactor.json()).code, 'MFA_CODE_REQUIRED');
 const response = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password: changedPassword, code: app.recoveryCodes[1]},
 });
 assert.equal(response.status, 200);
});

test('MFA login throttling survives a server restart', async t => {
 const app = await fixture(t, {enabled: true});
 for (let index = 0; index < 5; index++) {
  const response = await app.request('/api/admin/login', {method: 'POST', body: {username, password, code: 'invalid'}});
  assert.equal(response.status, 401);
 }
 await app.close();
 const restarted = await start(app.dataDir);
 try {
  const limited = await restarted.request('/api/admin/login', {
   method: 'POST', body: {username, password, code: app.recoveryCodes[0]},
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(limited.headers.get('set-cookie'), null);
 } finally {
  await restarted.close();
 }
});

test('changing the authenticator requires reauthentication and preserves the old factor until confirmation', async t => {
 const app = await fixture(t, {enabled: true});
 const auth = await login(app, {code: app.recoveryCodes[0]});
 const missingFactor = await app.request('/api/admin/mfa/setup', {method: 'POST', ...auth, body: {password}});
 assert.equal(missingFactor.status, 401, 'a stolen session and password alone cannot replace the device');
 const setup = await app.request('/api/admin/mfa/setup', {
  method: 'POST', ...auth, body: {password, code: app.recoveryCodes[1]},
 });
 assert.equal(setup.status, 200);
 const pending = await setup.json();
 assert.notEqual(pending.secret, app.secret);
 const oldFactorSession = await login(app, {code: totpCode(app.secret)});
 assert.equal((await app.request('/api/admin/leads', oldFactorSession)).status, 200, 'starting replacement does not erase the working factor');
 const enabled = await app.request('/api/admin/mfa/enable', {
  method: 'POST', ...auth, body: {code: totpCode(pending.secret)},
 });
 assert.equal(enabled.status, 200, await enabled.clone().text());
 const data = await enabled.json();
 const updated = session(enabled, data);
 assert.equal((await app.request('/api/admin/session', auth)).status, 401);
 assert.equal((await app.request('/api/admin/session', oldFactorSession)).status, 401);
 assert.equal((await app.request('/api/admin/leads', updated)).status, 200);
 const revokedRecovery = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password, code: app.recoveryCodes[2]},
 });
 assert.equal(revokedRecovery.status, 401, 'device change revokes the entire old recovery set');
 await login(app, {code: data.recoveryCodes[0]});
});

test('recovery-code rotation requires a fresh second factor and revokes old codes and sessions', async t => {
 const app = await fixture(t, {enabled: true});
 const auth = await login(app, {code: app.recoveryCodes[0]});
 const noCsrf = await app.request('/api/admin/mfa/recovery-codes', {
  method: 'POST', cookie: auth.cookie, body: {password, code: app.recoveryCodes[1]},
 });
 assert.equal(noCsrf.status, 403);
 const noFactor = await app.request('/api/admin/mfa/recovery-codes', {method: 'POST', ...auth, body: {password}});
 assert.equal(noFactor.status, 401);
 const rotated = await app.request('/api/admin/mfa/recovery-codes', {
  method: 'POST', ...auth, body: {password, code: app.recoveryCodes[1]},
 });
 assert.equal(rotated.status, 200, await rotated.clone().text());
 const data = await rotated.json();
 assert.equal(data.recoveryCodes.length, 10);
 assert.ok(data.recoveryCodes.every(code => !app.recoveryCodes.includes(code)));
 const updated = session(rotated, data);
 assert.notEqual(updated.cookie, auth.cookie);
 assert.notEqual(updated.csrf, auth.csrf);
 assert.equal((await app.request('/api/admin/session', auth)).status, 401);
 const security = await app.request('/api/admin/security', updated);
 assert.equal((await security.json()).recoveryCodesRemaining, 10);
 const revoked = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password, code: app.recoveryCodes[2]},
 });
 assert.equal(revoked.status, 401);
 await login(app, {code: data.recoveryCodes[0]});
});

test('assistant export passes only the redacted report through the protected API boundary', async t => {
 const app = await fixture(t, {enabled: true});
 const submitted = await app.request('/api/leads', {method: 'POST', body: {
  brand: 'Özel Marka', name: 'Ali Test', email: 'ali@example.com', phone: '05307168808',
  plan: 'Tek seferlik proje', brief: 'Drone filmi istiyoruz. ali@example.com ve 05307168808 üzerinden ulaşın.',
  consent: true, website: '',
 }});
 assert.equal(submitted.status, 201);
 const {id} = await submitted.json();
 const auth = await login(app, {code: app.recoveryCodes[0]});
 const updated = await app.request(`/api/admin/leads/${id}`, {
  method: 'PATCH', ...auth, body: {status: 'new', notes: 'private-note-marker'},
 });
 assert.equal(updated.status, 200);
 const response = await app.request('/api/admin/assistant-export', auth);
 assert.equal(response.status, 200);
 assert.match(response.headers.get('cache-control'), /no-store/);
 assert.match(response.headers.get('content-disposition'), /^attachment;/);
 const text = await response.text();
 for (const privateValue of ['Özel Marka', 'Ali Test', 'ali@example.com', '05307168808', 'private-note-marker']) {
  assert.ok(!text.includes(privateValue), `${privateValue} must not cross the report boundary`);
 }
 const report = JSON.parse(text);
 assert.equal(report.summary.total, 1);
 assert.equal(report.actionableQueue[0].id, id);
 assert.match(report.actionableQueue[0].brief, /GİZLENDİ/);
 assert.equal(report.privacy.humanReviewRequired, true);
});

test('cross-site reads and forged forwarding headers do not bypass admin protections', async t => {
 const app = await fixture(t, {enabled: true});
 const auth = await login(app, {code: app.recoveryCodes[0]});
 for (const path of ['/api/admin/leads', '/api/admin/security', '/api/admin/assistant-export']) {
  const response = await app.request(path, {...auth, headers: {'Sec-Fetch-Site': 'cross-site'}});
  assert.equal(response.status, 403, path);
 }
 for (let index = 0; index < 5; index++) {
  const response = await app.request('/api/admin/login', {
   method: 'POST', body: {username, password, code: 'invalid'}, headers: {'X-Forwarded-For': `192.0.2.${index + 1}`},
  });
  assert.equal(response.status, 401);
 }
 const limited = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password, code: app.recoveryCodes[1]}, headers: {'X-Forwarded-For': '198.51.100.1'},
 });
 assert.equal(limited.status, 429, 'untrusted forwarding headers cannot create new rate-limit identities');
});

test('logging out while an admin update body is still arriving revokes the pending write', {timeout: 10_000}, async t => {
 const app = await fixture(t, {enabled: true});
 const submitted = await app.request('/api/leads', {method: 'POST', body: {
  brand: 'Pending Update', name: 'Test Visitor', email: 'visitor@example.com', phone: '',
  plan: 'Tek seferlik proje', brief: 'A pending update must not survive logout.', consent: true,
 }});
 assert.equal(submitted.status, 201);
 const {id} = await submitted.json();
 const auth = await login(app, {code: app.recoveryCodes[0]});
 const path = `/api/admin/leads/${id}`;
 const body = JSON.stringify({status: 'archived', notes: 'This revoked write must not be stored.'});
 const split = body.indexOf(',') + 1;
 let observe;
 const receivedPartial = new Promise(resolve => {
  observe = req => {
   if (req.method !== 'PATCH' || req.url !== path) return;
   app.server.off('request', observe);
   // The API has already checked the cookie and is reading its JSON stream.
   // Continue only after the first chunk reaches the server, without sleeps.
   req.once('data', () => setImmediate(resolve));
  };
  app.server.on('request', observe);
 });
 let pending;
 const responsePromise = new Promise((resolve, reject) => {
  pending = httpRequest({
   hostname: '127.0.0.1', port: app.server.address().port, path, method: 'PATCH',
   headers: {
    'Origin': origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    'Cookie': auth.cookie, 'X-CSRF-Token': auth.csrf,
   },
  }, response => {
   const chunks = [];
   response.on('data', chunk => chunks.push(chunk));
   response.on('error', reject);
   response.on('end', () => resolve({status: response.statusCode, text: Buffer.concat(chunks).toString('utf8')}));
  });
  pending.on('error', reject);
 });
 // Keep cleanup errors handled if an earlier assertion aborts the test.
 responsePromise.catch(() => {});
 try {
  pending.write(body.slice(0, split));
  await receivedPartial;
  const logout = await app.request('/api/admin/logout', {method: 'POST', ...auth, body: {}});
  assert.equal(logout.status, 200);
  pending.end(body.slice(split));
  const response = await responsePromise;
  assert.equal(response.status, 401, response.text);
  const fresh = await login(app, {code: app.recoveryCodes[1]});
  const inbox = await app.request('/api/admin/leads', fresh);
  assert.equal(inbox.status, 200);
  const lead = (await inbox.json()).leads.find(lead => lead.id === id);
  assert.equal(lead.status, 'new');
  assert.equal(lead.notes, '', 'the rejected in-flight update leaves the lead unchanged');
 } finally {
  app.server.off('request', observe);
  pending.destroy();
 }
});

test('account-wide second-factor throttling survives changing IPs and a server restart', async t => {
 const app = await fixture(t, {enabled: true, trustProxy: true});
 const timestamp = Date.now();
 const acceptedCodes = new Set([-90_000, -60_000, -30_000, 0, 30_000, 60_000, 90_000]
  .map(offset => totpCode(app.secret, timestamp + offset)));
 let invalidCode = '000000';
 while (acceptedCodes.has(invalidCode)) invalidCode = String(Number(invalidCode) + 1).padStart(6, '0');
 for (let index = 1; index <= 10; index++) {
  const response = await app.request('/api/admin/login', {
   method: 'POST', body: {username, password, code: invalidCode},
   headers: {'X-Forwarded-For': `192.0.2.${index}`},
  });
  assert.equal(response.status, 401, `failed factor attempt ${index}: ${await response.clone().text()}`);
  assert.equal(response.headers.get('set-cookie'), null);
 }
 const limited = await app.request('/api/admin/login', {
  method: 'POST', body: {username, password, code: app.recoveryCodes[0]},
  headers: {'X-Forwarded-For': '198.51.100.11'},
 });
 assert.equal(limited.status, 429, 'changing IP cannot continue guessing the same account factor');
 assert.ok(Number(limited.headers.get('retry-after')) > 0);
 assert.equal(limited.headers.get('set-cookie'), null);
 await app.close();
 const restarted = await start(app.dataDir, {trustProxy: true});
 try {
  const stillLimited = await restarted.request('/api/admin/login', {
   method: 'POST', body: {username, password, code: app.recoveryCodes[0]},
   headers: {'X-Forwarded-For': '203.0.113.12'},
  });
  assert.equal(stillLimited.status, 429, 'restart does not reset the account-wide attempt budget');
  assert.ok(Number(stillLimited.headers.get('retry-after')) > 0);
  assert.equal(stillLimited.headers.get('set-cookie'), null);
 } finally {
  await restarted.close();
 }
});
