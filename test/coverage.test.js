import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportAnalysis } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, coveragePlan, analyzeCoverage, MAX_COORDINATE, POLICY_HASH, itemsFor, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/plan.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-coverage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later selections; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'inactive'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { q.is_handoff = 'false'; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a selection', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'inactive'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'inactive'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and original creation intent', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'inactive');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'inactive'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'inactive'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing reviewer before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'inactive');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'inactive'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});
test('optional SDK default flags and results may be absent but true/tally flags fail',async t=>{
  const s=await setup(t);await s.run();const q=s.api.questions.get(id(1));delete q.is_handoff;delete q.results;q.options.forEach(option=>{delete option.primary;delete option.destructive;});
  s.api.answer(id(1),'inactive');assert.equal((await s.run()).answers[0].choice,'inactive');
  for(const mutate of [q=>{q.results=[];},q=>{q.results={};},q=>{q.is_handoff=true;},q=>{q.is_handoff=null;},q=>{q.options[0].primary=true;},q=>{q.options[0].destructive='false';}]){
    const other=await setup(t);await other.run();mutate(other.api.questions.get(id(1)));await assert.rejects(other.run());assert.equal((await other.saved()).attempts[0].status,'pending');
  }
});

test('a changed asking registration across sources blocks exact-ID recovery',async t=>{
  const s=await setup(t);await decide(s,['inactive']);s.api.controls.loseNext=true;await s.run();s.api.questions.get(id(2)).asker.id=OTHER;
  s.api.answer(id(2),'active');await assert.rejects(s.run({command:'recover',attachId:id(2)}),/different asking registrations/);assert.equal((await s.saved()).attempts[1].status,'creating');
});

test('identifiers, room and token reject newline suffixes and source/config drift before a request',async t=>{
  assert.equal(isId(`${id(1)}\n`),false);assert.equal(ROOM.test(`${ROOM_CODE}\n`),false);
  assert.throws(()=>validateConnection({token:'token\n',room:ROOM_CODE}));assert.throws(()=>validateConnection({token:'token',room:`${ROOM_CODE}\n`}));
  assert.throws(()=>requestFor(simple(),{participant:{id:`${OTHER}\n`,label:'Owner'}},'east',id(1)));
  const s=await setup(t);await s.run();const calls=s.api.calls.length;
  const input=simple();input.unit='Changed';
  for(const extra of [{input},{token:'changed'},{room:`${ROOM_CODE}\n`},{config:{participant:{id:OTHER,label:'Other'}}}])await assert.rejects(s.run(extra));
  assert.equal(s.api.calls.length,calls);
});

const rowsFor = (input, choices) => validateInput(input).footprints.map((footprint, index) => ({ footprintId: footprint.id, choice: choices[index] }));
const rectangleInput = rectangles => ({ planId: 'oracle', title: 'Small floor', unit: 'cells', workspace: { x0: 0, y0: 0, x1: 3, y1: 3 },
  footprints: rectangles.map((rect, index) => ({ id: `f${index}`, label: `Footprint ${index}`, description: 'Declared footprint.', ...rect })) });

// Independent oracle counts each unit square rather than constructing edge partitions.
function rasterOracle(input, choices) {
  const histogram = Array(input.footprints.length + 1).fill(0), units = [];
  for (let y = input.workspace.y0; y < input.workspace.y1; y++) for (let x = input.workspace.x0; x < input.workspace.x1; x++) {
    const coveringIds = input.footprints.filter(rect => choices[rect.id] === 'active' && x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1).map(rect => rect.id).sort();
    histogram[coveringIds.length]++; units.push({ x, y, coveringIds });
  }
  return { histogram, units };
}

test('independent unit-cell oracle agrees on 2,736 rectangle and activity combinations', () => {
  const rects = [];
  for (let x0 = 0; x0 < 3; x0++) for (let x1 = x0 + 1; x1 <= 3; x1++) for (let y0 = 0; y0 < 3; y0++) for (let y1 = y0 + 1; y1 <= 3; y1++) rects.push({ x0, y0, x1, y1 });
  const sets = rects.map(rect => [rect]);
  for (let i = 0; i < rects.length; i++) for (let j = i; j < rects.length; j++) sets.push([rects[i], rects[j]]);
  let count = 0;
  for (const set of sets) for (let mask = 0; mask < 2 ** set.length; mask++) {
    const input = rectangleInput(set), choices = Object.fromEntries(input.footprints.map((rect, index) => [rect.id, mask & 1 << index ? 'active' : 'inactive']));
    const result = analyzeCoverage(input, choices), oracle = rasterOracle(input, choices);
    for (const row of result.depthHistogram) assert.equal(row.area, oracle.histogram[row.depth]);
    assert.equal(result.coveredArea, 9 - oracle.histogram[0]); assert.equal(result.uncoveredArea, oracle.histogram[0]);
    assert.equal(result.overlapArea, oracle.histogram.slice(2).reduce((a, b) => a + b, 0));
    assert.equal(result.depthWeightedArea, oracle.histogram.reduce((sum, area, depth) => sum + area * depth, 0));
    for (const unit of oracle.units) {
      const cells = result.cells.filter(cell => cell.x0 <= unit.x && cell.x1 > unit.x && cell.y0 <= unit.y && cell.y1 > unit.y);
      assert.equal(cells.length, 1); assert.deepEqual(cells[0].coveringIds, unit.coveringIds);
    }
    count++;
  }
  assert.equal(count, 2736);
});

test('example separates union, overlap and repeatedly counted footprint area', () => {
  const result = analyzeCoverage(simple(), { east: 'active', west: 'active' });
  assert.equal(result.workspaceArea, 80); assert.equal(result.coveredArea, 64); assert.equal(result.uncoveredArea, 16);
  assert.equal(result.overlapArea, 8); assert.equal(result.activeFootprintArea, 72); assert.equal(result.depthWeightedArea, 72);
  assert.deepEqual(result.depthHistogram, [{ depth: 0, area: 16 }, { depth: 1, area: 56 }, { depth: 2, area: 8 }]);
  assert.equal(result.areaConserved, true); assert.equal(result.physicalCoverageVerified, false);
});

test('edge contact has no overlap; duplicate and nested footprints retain separate IDs', () => {
  let input = rectangleInput([{ x0: 0, y0: 0, x1: 1, y1: 3 }, { x0: 1, y0: 0, x1: 3, y1: 3 }]);
  let result = analyzeCoverage(input, { f0: 'active', f1: 'active' }); assert.equal(result.coveredArea, 9); assert.equal(result.overlapArea, 0);
  input = rectangleInput([{ x0: 0, y0: 0, x1: 3, y1: 3 }, { x0: 0, y0: 0, x1: 3, y1: 3 }]);
  result = analyzeCoverage(input, { f0: 'active', f1: 'active' }); assert.equal(result.cells.length, 1); assert.deepEqual(result.cells[0].coveringIds, ['f0', 'f1']); assert.equal(result.overlapArea, 9); assert.equal(result.activeFootprintArea, 18);
  input.footprints[1] = { ...input.footprints[1], x0: 1, y0: 1, x1: 2, y1: 2 };
  result = analyzeCoverage(input, { f0: 'active', f1: 'active' }); assert.equal(result.coveredArea, 9); assert.equal(result.overlapArea, 1); assert.equal(result.cells.length, 9);
});

test('all inactive is complete and inactive edges keep the grid stable', () => {
  const inactive = analyzeCoverage(simple(), { east: 'inactive', west: 'inactive' }), active = analyzeCoverage(simple(), { east: 'active', west: 'active' });
  assert.equal(inactive.allInactive, true); assert.equal(inactive.coveredArea, 0); assert.equal(inactive.uncoveredArea, 80);
  assert.equal(inactive.overlapArea, 0); assert.deepEqual(inactive.depthHistogram, [{ depth: 0, area: 80 }]);
  assert.deepEqual(inactive.xEdges, active.xEdges); assert.deepEqual(inactive.yEdges, active.yEdges);
  assert.ok(inactive.cells.every(cell => cell.depth === 0 && cell.coveringIds.length === 0));
});

test('Unknown and missing activity withhold the complete geometry', () => {
  for (let index = 0; index < 2; index++) for (const choice of [null, 'unknown']) {
    const choices = ['active', 'inactive']; choices[index] = choice;
    const result = coveragePlan(simple(), rowsFor(simple(), choices)); assert.equal(result.status, choice === null ? 'incomplete' : 'unknown'); assert.equal(result.analysis, null);
  }
});

test('footprint order canonicalizes while geometry, unit and descriptions remain bound', () => {
  const input = simple(), reversed = structuredClone(input); reversed.footprints.reverse();
  assert.deepEqual(validateInput(input), validateInput(reversed)); assert.deepEqual(analyzeCoverage(input, { east: 'active', west: 'inactive' }), analyzeCoverage(reversed, { east: 'active', west: 'inactive' }));
  for (const mutate of [x => { x.unit = 'feet'; }, x => { x.footprints[0].description = 'Changed'; }, x => { x.workspace.x1++; }, x => { x.footprints[0].x0++; }]) {
    const changed = simple(); mutate(changed); assert.notEqual(hash(validateInput(input)), hash(validateInput(changed)));
  }
  assert.throws(() => coveragePlan(input, rowsFor(input, ['active', 'inactive']).toReversed()));
});

test('schema rejects degenerate, outside, fractional, sparse and ambiguous input', () => {
  for (const mutate of [
    x => { x.extra = 1; }, x => { x.planId += '\n'; }, x => { x.title = '\ud800'; }, x => { x.unit = ' '; }, x => { x.unit = 'x'.repeat(13); },
    x => { x.workspace.extra = 1; }, x => { x.workspace.x0 = x.workspace.x1; }, x => { x.workspace.y0 = x.workspace.y1 + 1; }, x => { x.workspace = null; },
    x => { x.footprints = []; }, x => { x.footprints = Array(2); }, x => { x.footprints.push(x.footprints[0]); }, x => { x.footprints[0].id = 'constructor'; }, x => { x.footprints[0].label = 'x'.repeat(33); }, x => { x.footprints[0].description = 'x\u200b'; }, x => { x.footprints[0].extra = 1; },
    x => { x.footprints[0].x0 = -1; }, x => { x.footprints[0].x1 = 11; }, x => { x.footprints[0].y0 = -1; }, x => { x.footprints[0].y1 = 9; }, x => { x.footprints[0].x1 = x.footprints[0].x0; }, x => { x.footprints[0].y1 = x.footprints[0].y0 - 1; },
    x => { x.footprints[0].x0 = -0; }, x => { x.footprints[0].x0 = 1.5; }, x => { x.footprints[0].x0 = '1'; }, x => { x.workspace.x0 = -Infinity; }, x => { x.workspace.x0 = -MAX_COORDINATE - 1; },
  ]) { const input = simple(); mutate(input); assert.throws(() => validateInput(input)); }
  assert.throws(() => analyzeCoverage(simple(), { east: 'active' })); assert.throws(() => analyzeCoverage(simple(), { east: 'unknown', west: 'active' })); assert.throws(() => coveragePlan(simple(), Array(2)));
});

test('negative coordinates and maximum area/depth sums remain exact', () => {
  const workspace = { x0: -MAX_COORDINATE, y0: -MAX_COORDINATE, x1: MAX_COORDINATE, y1: MAX_COORDINATE };
  const input = { planId: 'max', title: 'Maximum area', unit: 'ticks', workspace, footprints: Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, label: 'Same bounds', description: 'Separate declared footprint.', ...workspace })) };
  const result = analyzeCoverage(input, Object.fromEntries(input.footprints.map(f => [f.id, 'active'])));
  assert.equal(result.workspaceArea, 4000000000000); assert.equal(result.coveredArea, 4000000000000); assert.equal(result.overlapArea, 4000000000000);
  assert.equal(result.activeFootprintArea, 32000000000000); assert.equal(result.depthWeightedArea, 32000000000000); assert.equal(result.cells.length, 1); assert.equal(result.cells[0].depth, 8);
});

test('maximum 289-cell grid and eight Questions fit private input/output bounds', async t => {
  const workspace = { x0: -MAX_COORDINATE, y0: -MAX_COORDINATE, x1: MAX_COORDINATE, y1: MAX_COORDINATE };
  const input = { planId: 'p'.repeat(40), title: 'T'.repeat(40), unit: 'U'.repeat(12), workspace,
    footprints: Array.from({ length: 8 }, (_, i) => ({ id: `foot${String(i).padStart(8, '0')}`, label: 'L'.repeat(32), description: 'D'.repeat(80), x0: -900000 + i * 100000, y0: -900000 + i * 100000, x1: 900000 - i * 100000, y1: 900000 - i * 100000 })) };
  const normalized = validateInput(input); for (const item of itemsFor(normalized)) { const request = requestFor(input, CONFIG, item.id, id(30)); assert.ok(request.prompt.length <= 500); assert.equal(request.options.length, 3); assert.equal(request.data.policy_hash, POLICY_HASH); }
  assert.ok(Buffer.byteLength(JSON.stringify(normalized)) < 65536);
  const s = await setup(t, input), result = await decide(s, Array(8).fill('active'));
  assert.equal(result.analysis.cells.length, 289); assert.equal(result.analysis.depthHistogram.reduce((sum, row) => sum + row.area, 0), result.analysis.workspaceArea);
  await exportAnalysis(s.directory, input); assert.ok((await stat(join(s.directory, 'analysis.json'))).size < 1024 * 1024); assert.equal(sends(s.api), 8);
});

test('complete coverage exports locally; Unknown and tampered evidence cannot export', async t => {
  const s = await setup(t), result = await decide(s, ['active', 'inactive']), calls = s.api.calls.length;
  assert.deepEqual((await exportAnalysis(s.directory, s.options.input)).analysis, result.analysis); assert.equal(s.api.calls.length, calls); assert.equal((await stat(join(s.directory, 'analysis.json'))).mode & 0o777, 0o600);
  const saved = await s.saved(); saved.attempts[0].observation.answer.label = 'Wrong'; await atomicJson(s.directory, 'state.json', saved); await assert.rejects(exportAnalysis(s.directory, s.options.input));
  const other = await setup(t); await decide(other, ['inactive', 'unknown']); await assert.rejects(exportAnalysis(other.directory, other.options.input));
});
