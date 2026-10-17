import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/store.mjs';
import {createAutomation} from '../lib/automation.mjs';

const hour = 60 * 60 * 1000;
const apiKey = 'gsk_test_private_key_not_for_status_or_storage';
const result = {
 summary: 'Müşteri ürün tanıtımı için drone çekimi istiyor.',
 needs: ['Drone çekimi', 'Ürün tanıtımı'],
 nextStep: 'Çekim yeri ve tarihini netleştirin.',
};
const lead = (overrides = {}) => ({
 brand: 'PRIVATE_BRAND', name: 'Deniz Örnek', email: 'PRIVATE_EMAIL@example.invalid',
 phone: '05001112233', plan: 'Drone', brief: 'Yeni ürünümüz için drone çekimi istiyoruz.',
 notes: 'PRIVATE_INTERNAL_NOTE', ...overrides,
});

function fakeClock() {
 let value = Date.parse('2026-10-17T09:00:00.000Z');
 const timers = new Map();
 return {
  now: () => value,
  advance: milliseconds => { value += milliseconds; },
  setTimer(callback, delay) {
   const handle = {unref() { return handle; }};
   timers.set(handle, {callback, delay});
   return handle;
  },
  clearTimer: handle => timers.delete(handle),
  timers,
 };
}

async function fixture(t, {summarize = async () => result, config = {apiKey, model: 'llama-3.3-70b-versatile'}} = {}) {
 const dataDir = await mkdtemp(join(tmpdir(), 'ordvis-automation-'));
 const clock = fakeClock();
 let store = new Store({dataDir});
 const workers = new Set();
 const makeWorker = () => {
  const worker = createAutomation({
   store, getConfig: () => config, summarize,
   now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  workers.add(worker);
  return worker;
 };
 let automation = makeWorker();
 t.after(async () => {
  for (const worker of workers) await worker.close();
  store.close();
  await rm(dataDir, {recursive: true, force: true});
 });
 return {
  clock, config, dataDir, makeWorker,
  get store() { return store; },
  get automation() { return automation; },
  seed(count = 1) {
   return Array.from({length: count}, (_, index) => store.createLead(lead({name: `Deniz ${index}`})).id);
  },
  async restart() {
   for (const worker of workers) await worker.close();
   workers.clear();
   store.close();
   store = new Store({dataDir});
   automation = makeWorker();
   return automation;
  },
 };
}

test('automation defaults off and enabling schedules the first run exactly one hour later', async t => {
 let calls = 0;
 const app = await fixture(t, {summarize: async () => { calls++; return result; }});
 app.seed();
 const original = app.automation.status();
 assert.equal(original.enabled, false);
 assert.equal(original.configured, true);
 assert.equal(original.provider, 'groq');
 assert.equal(original.intervalMinutes, 60);
 assert.equal(original.nextRunAt, null);
 assert.equal(original.lastRunAt, null);
 assert.equal(original.pendingCount, 1);
 const enabled = app.automation.setEnabled(true);
 assert.equal(enabled.enabled, true);
 assert.equal(enabled.nextRunAt, new Date(app.clock.now() + hour).toISOString());
 await app.automation.tick();
 app.clock.advance(hour - 1);
 await app.automation.tick();
 assert.equal(calls, 0);
 app.clock.advance(1);
 await app.automation.tick();
 assert.equal(calls, 1);
 assert.equal(app.automation.status().lastRunAt, new Date(app.clock.now()).toISOString());
});

test('missing API credentials preserve enabled preference without contacting the provider', async t => {
 let calls = 0;
 const app = await fixture(t, {
  config: {apiKey: '', model: 'llama-3.3-70b-versatile'},
  summarize: async () => { calls++; return result; },
 });
 app.seed();
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 await app.automation.tick();
 assert.equal(calls, 0);
 assert.equal(app.automation.status().enabled, true);
 assert.equal(app.automation.status().configured, false);
 assert.equal(app.automation.status().status, 'needs_key');
 assert.equal(app.automation.status().pendingCount, 1);
 await app.restart();
 assert.equal(app.automation.status().enabled, true);
 assert.equal(app.automation.status().status, 'needs_key');
});

test('only name and brief cross the provider boundary, and successful summaries survive restart', async t => {
 const calls = [];
 const app = await fixture(t, {summarize: async (payload, options) => {
  calls.push({payload, options});
  return result;
 }});
 const ids = app.seed();
 app.store.updateLead(ids[0], {status: 'new', notes: 'PRIVATE_INTERNAL_NOTE'});
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 await app.automation.tick();
 assert.equal(calls.length, 1);
 assert.deepEqual(calls[0].payload, {name: 'Deniz 0', brief: lead().brief});
 assert.equal(calls[0].options.apiKey, apiKey);
 assert.equal(calls[0].options.model, app.config.model);
 assert.ok(calls[0].options.signal instanceof AbortSignal);
 const serialized = JSON.stringify(calls[0].payload);
 for (const excluded of ['PRIVATE_BRAND', 'PRIVATE_EMAIL', '05001112233', 'PRIVATE_INTERNAL_NOTE', 'plan']) {
  assert.equal(serialized.includes(excluded), false, excluded);
 }
 assert.equal(app.automation.status().pendingCount, 0);
 const summaries = app.automation.status().summaries;
 assert.equal(summaries.length, 1);
 assert.equal(summaries[0].summary, result.summary);
 assert.deepEqual(summaries[0].needs, result.needs);
 assert.equal(summaries[0].nextStep, result.nextStep);
 assert.equal(JSON.stringify(app.automation.status()).includes(apiKey), false);
 await app.restart();
 assert.equal(app.automation.status().summaries.length, 1);
 app.clock.advance(hour);
 await app.automation.tick();
 assert.equal(calls.length, 1, 'a stored success is never summarized a second time');
 for (const filename of await readdir(app.dataDir)) {
  const path = join(app.dataDir, filename);
  if ((await stat(path)).isFile()) {
   assert.equal((await readFile(path)).includes(Buffer.from(apiKey)), false, `API key absent from ${filename}`);
   if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o077, 0, `${filename} is private`);
  }
 }
});

test('hourly five-attempt budget persists across restart and leaves the remaining queue untouched', async t => {
 let calls = 0;
 const app = await fixture(t, {summarize: async () => { calls++; return result; }});
 app.seed(7);
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 await app.automation.tick();
 assert.equal(calls, 5);
 assert.equal(app.automation.status().pendingCount, 2);
 assert.equal(app.automation.status().summaries.length, 5);
 await app.restart();
 app.store.updateAutomationSettings({nextRunAt: app.clock.now()});
 await app.automation.tick();
 assert.equal(calls, 5, 'restarting cannot bypass the persisted provider budget');
 app.clock.advance(hour - 1);
 app.store.updateAutomationSettings({nextRunAt: app.clock.now()});
 await app.automation.tick();
 assert.equal(calls, 5);
 app.clock.advance(2);
 app.store.updateAutomationSettings({nextRunAt: app.clock.now()});
 await app.automation.tick();
 assert.equal(calls, 7);
 assert.equal(app.automation.status().pendingCount, 0);
});

test('provider rate limits respect retry time and never expose raw provider errors or credentials', async t => {
 let calls = 0;
 const app = await fixture(t, {summarize: async () => {
  calls++;
  const error = new Error(`Private provider body with ${apiKey} and PRIVATE_EMAIL@example.invalid`);
  error.code = 'RATE_LIMIT';
  error.retryAfterSeconds = 120;
  throw error;
 }});
 app.seed(2);
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 await app.automation.tick();
 assert.equal(calls, 1, 'a provider rate limit stops the batch');
 const status = app.automation.status();
 assert.equal(status.pendingCount, 2);
 assert.equal(status.summaries.length, 0);
 assert.ok(Date.parse(status.retryAt) >= app.clock.now() + 120_000);
 for (const secret of [apiKey, 'PRIVATE_EMAIL', 'Private provider body']) {
  assert.equal(JSON.stringify(status).includes(secret), false, secret);
 }
 app.clock.advance(119_999);
 await app.automation.tick();
 assert.equal(calls, 1);
 await app.restart();
 await app.automation.tick();
 assert.equal(calls, 1, 'retry delay survives a restart');
});

test('failed provider attempts consume the same persisted hourly budget as successful attempts', async t => {
 let calls = 0;
 const app = await fixture(t, {summarize: async () => {
  calls++;
  const error = new Error('Untrusted provider response');
  error.code = 'INVALID_OUTPUT';
  throw error;
 }});
 app.seed(4);
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 for (let attempt = 0; attempt < 7; attempt++) {
  // Simulate a due retry while keeping every attempt inside the same hour.
  app.store.updateAutomationSettings({nextRunAt: app.clock.now(), retryAt: null});
  await app.automation.tick();
  app.clock.advance(61_000);
 }
 assert.equal(calls, 5);
 assert.equal(app.automation.status().summaries.length, 0);
 await app.restart();
 app.store.updateAutomationSettings({nextRunAt: app.clock.now(), retryAt: null});
 await app.automation.tick();
 assert.equal(calls, 5, 'failed attempts cannot be reset by restarting the process');
});

test('staggered failures and successes share a true rolling-hour budget', async t => {
 let calls = 0;
 const app = await fixture(t, {summarize: async () => {
  calls++;
  if (calls === 1) {
   const error = new Error('Rate limited');
   error.code = 'RATE_LIMIT';
   error.retryAfterSeconds = 120;
   throw error;
  }
  return result;
 }});
 app.seed(10);
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 await app.automation.tick();
 assert.equal(calls, 1);
 app.clock.advance(50 * 60_000);
 app.store.updateAutomationSettings({nextRunAt: app.clock.now(), retryAt: null});
 await app.automation.tick();
 assert.equal(calls, 5);
 await app.restart();
 app.clock.advance(11 * 60_000);
 app.store.updateAutomationSettings({nextRunAt: app.clock.now(), retryAt: null});
 await app.automation.tick();
 assert.equal(calls, 6, 'only the first expired attempt is replaced; the four recent attempts still count');
 assert.equal(app.automation.status().summaries.length, 5);
});

test('disabling during a provider request aborts it and prevents commits or further requests', async t => {
 let started;
 const didStart = new Promise(resolve => { started = resolve; });
 let release;
 let signal;
 let calls = 0;
 const app = await fixture(t, {summarize: async (_payload, options) => {
  calls++;
  signal = options.signal;
  started();
  return new Promise(resolve => { release = resolve; });
 }});
 app.seed(2);
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 const running = app.automation.tick();
 await didStart;
 app.automation.setEnabled(false);
 assert.equal(signal.aborted, true);
 release(result);
 await running;
 assert.equal(calls, 1);
 assert.equal(app.automation.status().enabled, false);
 assert.equal(app.automation.status().summaries.length, 0);
 assert.equal(app.automation.status().pendingCount, 2);
});

test('overlapping ticks share a single running job, including workers for the same store', async t => {
 let started;
 const didStart = new Promise(resolve => { started = resolve; });
 let release;
 let calls = 0;
 const app = await fixture(t, {summarize: async () => {
  calls++;
  started();
  return new Promise(resolve => { release = resolve; });
 }});
 app.seed();
 app.automation.setEnabled(true);
 app.clock.advance(hour);
 const first = app.automation.tick();
 await didStart;
 const second = app.automation.tick();
 const sibling = app.makeWorker();
 const third = sibling.tick();
 assert.equal(calls, 1);
 release(result);
 await Promise.all([first, second, third]);
 assert.equal(calls, 1);
 assert.equal(app.automation.status().summaries.length, 1);
});
