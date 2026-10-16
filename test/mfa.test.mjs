import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {scryptSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
 encodeBase32, decodeBase32, totpCode, verifyTotp, generateSecret,
 generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode,
} from '../lib/mfa.mjs';
import {Store} from '../lib/store.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const username = 'mfa-test-admin';
const password = 'A-unique-test-password-2026!';
const now = 2_000_000_000_000;
const counter = Math.floor(now / 30_000);

test('TOTP matches published RFC 6238 SHA-1 vectors truncated to six digits', () => {
 assert.equal(encodeBase32(Buffer.from('12345678901234567890')), secret);
 assert.deepEqual(decodeBase32(secret), Buffer.from('12345678901234567890'));
 for (const [seconds, expected] of [
  [59, '287082'], [1_111_111_109, '081804'], [1_111_111_111, '050471'],
  [1_234_567_890, '005924'], [2_000_000_000, '279037'], [20_000_000_000, '353130'],
 ]) {
  assert.equal(totpCode(secret, seconds * 1000), expected, `RFC timestamp ${seconds}`);
  assert.equal(verifyTotp(secret, expected, {now: seconds * 1000}), Math.floor(seconds / 30));
 }
});

test('TOTP accepts only one step of clock drift and rejects reused counters', () => {
 for (const offset of [-1, 0, 1]) {
  const code = totpCode(secret, now + offset * 30_000);
  assert.equal(verifyTotp(secret, code, {now}), counter + offset);
  assert.equal(verifyTotp(secret, code, {now, lastCounter: counter + offset}), null);
  assert.equal(verifyTotp(secret, code, {now, lastCounter: counter + offset + 1}), null);
 }
 for (const offset of [-2, 2]) {
  assert.equal(verifyTotp(secret, totpCode(secret, now + offset * 30_000), {now}), null);
 }
});

test('malformed OTPs and Base32 secrets fail closed', () => {
 for (const invalid of ['', '12345', '1234567', ' 279037', '279037 ', '27 9037', '１２３４５６', 'abcdef', 279037, null, {}, []]) {
  assert.equal(verifyTotp(secret, invalid, {now}), null, `reject ${JSON.stringify(invalid)}`);
 }
 for (const invalid of ['', '!!!!', '0123456789', 'GEZD GNBV', '===']) {
  assert.throws(() => decodeBase32(invalid), `malformed Base32 ${JSON.stringify(invalid)}`);
 }
});

test('generated secrets and recovery codes have independent entropy and canonical hashing', () => {
 const secrets = new Set(Array.from({length: 20}, () => generateSecret()));
 assert.equal(secrets.size, 20);
 for (const value of secrets) {
  assert.match(value, /^[A-Z2-7]+$/);
  assert.ok(decodeBase32(value).length >= 20);
 }
 const codes = generateRecoveryCodes();
 assert.equal(codes.length, 10);
 assert.equal(new Set(codes).size, 10);
 for (const code of codes) {
  assert.match(code, /^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/);
  const canonical = normalizeRecoveryCode(code);
  assert.match(canonical, /^[A-F0-9]{24}$/);
  assert.equal(normalizeRecoveryCode(code.toLowerCase()), canonical);
  assert.match(hashRecoveryCode(code), /^[a-f0-9]{64}$/);
  assert.equal(hashRecoveryCode(code), hashRecoveryCode(code.toLowerCase()));
  assert.notEqual(hashRecoveryCode(code), canonical);
 }
});

async function fixture(t) {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-mfa-test-'));
 t.after(() => rm(dataDir, {recursive: true, force: true}));
 const store = new Store({dataDir});
 await store.initializeAdmin(username, password);
 return {store, dataDir};
}

function enable(store, recoveryCodes = generateRecoveryCodes()) {
 const state = store.getAdminState();
 assert.equal(store.enableMfa(secret, {counter: counter - 1, recoveryCodes, expectedVersion: state.authVersion}), true);
 return recoveryCodes;
}

async function filesUnder(dir) {
 const paths = [];
 for (const entry of await readdir(dir, {withFileTypes: true})) {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) paths.push(...await filesUnder(path));
  else if (entry.isFile()) paths.push(path);
 }
 return paths;
}

test('TOTP replay protection persists across connections and a complete restart', async t => {
 const {store, dataDir} = await fixture(t);
 enable(store);
 const other = new Store({dataDir});
 try {
  assert.equal(store.verifyMfa(totpCode(secret, now), {now}), true);
  assert.equal(other.verifyMfa(totpCode(secret, now), {now}), false, 'a second connection cannot consume the same OTP');
 } finally {
  other.close();
  store.close();
 }
 const restarted = new Store({dataDir});
 try {
  assert.equal(restarted.verifyMfa(totpCode(secret, now), {now}), false, 'restart does not reset replay protection');
  assert.equal(restarted.verifyMfa(totpCode(secret, now + 30_000), {now: now + 30_000}), true);
 } finally {
  restarted.close();
 }
});

test('recovery codes are single-use, persisted, and never stored as plaintext', async t => {
 const {store, dataDir} = await fixture(t);
 const codes = enable(store);
 assert.equal(store.getAdminState().recoveryCodesRemaining, 10);
 assert.equal(store.verifyMfa(codes[0].toLowerCase(), {now}), true);
 assert.equal(store.verifyMfa(codes[0], {now}), false);
 assert.equal(store.getAdminState().recoveryCodesRemaining, 9);
 store.close();
 const restarted = new Store({dataDir});
 try {
  assert.equal(restarted.verifyMfa(codes[0], {now}), false, 'restart does not revive a consumed recovery code');
  assert.equal(restarted.verifyMfa(codes[1], {now}), true);
  assert.equal(restarted.getAdminState().recoveryCodesRemaining, 8);
 } finally {
  restarted.close();
 }
 for (const path of await filesUnder(dataDir)) {
  const contents = await readFile(path);
  assert.equal(contents.includes(Buffer.from(secret)), false, 'TOTP secret is encrypted in persistent files');
  assert.equal(contents.includes(Buffer.from(password)), false, 'password remains hashed');
  for (const code of codes) {
   assert.equal(contents.includes(Buffer.from(code)), false, 'formatted recovery code is not persisted');
   assert.equal(contents.includes(Buffer.from(normalizeRecoveryCode(code))), false, 'canonical recovery code is not persisted');
  }
 }
});

test('MFA enrollment rejects stale versions so concurrent challenges cannot overwrite each other', async t => {
 const {store} = await fixture(t);
 try {
  const state = store.getAdminState();
  const codes = generateRecoveryCodes();
  assert.equal(store.enableMfa(secret, {counter: counter - 1, recoveryCodes: codes, expectedVersion: state.authVersion + 1}), false);
  assert.equal(store.getAdminState().mfaEnabled, false);
  assert.equal(store.enableMfa(secret, {counter: counter - 1, recoveryCodes: codes, expectedVersion: state.authVersion}), true);
  assert.equal(store.getAdminState().mfaEnabled, true);
  assert.ok(store.getAdminState().authVersion > state.authVersion);
  assert.equal(store.enableMfa(generateSecret(), {
   counter, recoveryCodes: generateRecoveryCodes(), expectedVersion: state.authVersion,
  }), false, 'a stale concurrent challenge cannot overwrite the newly enabled factor');
 } finally {
  store.close();
 }
});

test('password changes preserve MFA and increase the authentication version', async t => {
 const {store} = await fixture(t);
 try {
  const codes = enable(store);
  const before = store.getAdminState();
  const changed = 'Another-unique-password-2026!';
  await store.initializeAdmin(username, changed);
  const after = store.getAdminState();
  assert.ok(after.authVersion > before.authVersion);
  assert.equal(after.mfaEnabled, true);
  assert.equal(await store.verifyAdmin(username, password), false);
  assert.equal(await store.verifyAdmin(username, changed), true);
  assert.equal(store.verifyMfa(codes[0], {now}), true, 'password reset does not bypass or erase MFA');
 } finally {
  store.close();
 }
});

test('an existing pre-MFA database migrates without discarding its administrator', async t => {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-mfa-migration-'));
 t.after(() => rm(dataDir, {recursive: true, force: true}));
 const database = new DatabaseSync(join(dataDir, 'ordvis.sqlite'));
 database.exec('CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL)');
 const legacyHash = scryptSync(password, 'legacy-salt', 64, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
 database.prepare('INSERT INTO admin VALUES(1,?,?,?)').run('existing-admin', 'legacy-salt', legacyHash.toString('hex'));
 database.close();
 const store = new Store({dataDir});
 try {
  assert.equal(store.hasAdmin(), true);
  const state = store.getAdminState();
  assert.equal(state.username, 'existing-admin');
  assert.equal(state.mfaEnabled, false);
  assert.equal(state.recoveryCodesRemaining, 0);
  assert.ok(Number.isInteger(state.authVersion));
  assert.equal(await store.verifyAdmin('existing-admin', password), true, 'the migrated password remains usable');
  assert.equal(store.db.prepare('SELECT password_n FROM admin WHERE id=1').get().password_n,131072,'legacy password hashing is upgraded after valid authentication');
 } finally {
  store.close();
 }
});

test('a missing encryption key fails closed instead of replacing the key or resetting MFA', async t => {
 const {store, dataDir} = await fixture(t);
 const codes = enable(store);
 const state = store.getAdminState();
 store.close();
 const keyPath = join(dataDir, 'mfa.key');
 const backup = await readFile(keyPath);
 await unlink(keyPath);
 const attempted = spawnSync(process.execPath, ['--input-type=module', '-e',
  `import {Store} from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)}; new Store({dataDir: process.argv[1]});`,
  dataDir,
 ], {encoding: 'utf8', timeout: 5000});
 assert.equal(attempted.error, undefined);
 assert.notEqual(attempted.status, 0);
 assert.match(attempted.stderr, /MFA anahtar dosyası eksik/);
 await assert.rejects(readFile(keyPath), {code: 'ENOENT'}, 'a replacement key was not silently generated');
 await writeFile(keyPath, backup, {mode: 0o600});
 const restored = new Store({dataDir});
 try {
  assert.deepEqual(restored.getAdminState(), state, 'the administrator and factor remain unchanged');
  assert.equal(await restored.verifyAdmin(username, password), true);
  assert.equal(restored.verifyMfa(codes[0], {now}), true, 'restoring the key restores the original factor');
 } finally {
  restored.close();
 }
});
