import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const MAX_COORDINATE = 1000000;
const coordinate = value => Number.isSafeInteger(value) && !Object.is(value, -0) && Math.abs(value) <= MAX_COORDINATE;
const geometryKeys = ['x0', 'y0', 'x1', 'y1'];
const rectangle = value => record(value) && geometryKeys.every(key => coordinate(value[key])) && value.x0 < value.x1 && value.y0 < value.y1;
const area = rect => (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
export const POLICY = Object.freeze({ name: 'declared-rectangle-coverage-v1', geometry: 'integer axis-aligned half-open rectangles [x0,x1) by [y0,y1)', grid: 'all declared footprint edges and workspace edges, including inactive footprints', inclusion: 'only Active footprints contribute', union: 'cells with depth at least one', overlap: 'cells with depth at least two', unknown: 'withhold all analysis', scope: 'declared geometry only' });
export const POLICY_HASH = hash(POLICY);
const bounds = rect => `[${rect.x0},${rect.x1}) x [${rect.y0},${rect.y1})`;
const promptFor = (input, footprint) => `${input.title}\nUnit: ${input.unit}; workspace ${bounds(input.workspace)}\nFootprint ${footprint.id}: ${footprint.label}\n${footprint.description}\nBounds: ${bounds(footprint)}\nActive includes this rectangle; Inactive excludes it. Unknown withholds the coverage report. This records declared activity, not measured physical coverage.`;

export function validateInput(input) {
  if (!keys(input, ['planId', 'title', 'unit', 'workspace', 'footprints']) || !word(input.planId) || !line(input.title, 40) || !line(input.unit, 12)
    || !keys(input.workspace, geometryKeys) || !rectangle(input.workspace) || !Array.isArray(input.footprints) || input.footprints.length < 1 || input.footprints.length > 8) throw new Error('Supply a plan ID, title, unit, positive-area integer workspace and one to eight footprints.');
  const ids = new Set();
  const footprints = Array.from(input.footprints, footprint => {
    if (!keys(footprint, ['id', 'label', 'description', ...geometryKeys]) || !safeId(footprint.id) || ids.has(footprint.id) || !line(footprint.label, 32) || !line(footprint.description, 80) || !rectangle(footprint)
      || footprint.x0 < input.workspace.x0 || footprint.x1 > input.workspace.x1 || footprint.y0 < input.workspace.y0 || footprint.y1 > input.workspace.y1) throw new Error('Footprints need unique safe IDs, labels, descriptions and positive-area integer rectangles fully inside the workspace.');
    ids.add(footprint.id); return { ...footprint };
  }).sort((a, b) => order(a.id, b.id));
  const result = { planId: input.planId, title: input.title, unit: input.unit, workspace: { ...input.workspace }, footprints };
  if (footprints.some(footprint => promptFor(result, footprint).length > 500)) throw new Error('Footprint prompt exceeds 500 UTF-16 units.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact coverage owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => validateInput(input).footprints;
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config); const footprint = input.footprints.find(footprint => footprint.id === itemId);
  if (!footprint || !isId(attemptId)) throw new Error('Invalid footprint or attempt.');
  const key = `coverage-${attemptId}`;
  return { prompt: promptFor(input, footprint), context: `To ${config.participant.id}`,
    options: [{ value: 'active', label: 'Active', style: 'default' }, { value: 'inactive', label: 'Inactive', style: 'default' }, { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), footprint_hash: hash(footprint), policy_hash: POLICY_HASH, item_id: footprint.id, attempt_id: attemptId }, idempotencyKey: key };
}

/** Exact coordinate-compressed geometry. CLI exports also require verified owner evidence. */
export function analyzeCoverage(rawInput, selections) {
  const input = validateInput(rawInput), ids = input.footprints.map(footprint => footprint.id);
  if (!keys(selections, ids) || ids.some(id => !['active', 'inactive'].includes(selections[id]))) throw new Error('Every footprint needs exactly one known Active or Inactive choice.');
  const active = input.footprints.filter(footprint => selections[footprint.id] === 'active');
  const rectangles = [input.workspace, ...input.footprints];
  const xEdges = [...new Set(rectangles.flatMap(rect => [rect.x0, rect.x1]))].sort((a, b) => a - b);
  const yEdges = [...new Set(rectangles.flatMap(rect => [rect.y0, rect.y1]))].sort((a, b) => a - b);
  const depthHistogram = Array.from({ length: active.length + 1 }, (_, depth) => ({ depth, area: 0 }));
  const cells = [];
  for (let y = 0; y < yEdges.length - 1; y++) for (let x = 0; x < xEdges.length - 1; x++) {
    const cell = { x0: xEdges[x], y0: yEdges[y], x1: xEdges[x + 1], y1: yEdges[y + 1] };
    const coveringIds = active.filter(rect => rect.x0 <= cell.x0 && rect.x1 >= cell.x1 && rect.y0 <= cell.y0 && rect.y1 >= cell.y1).map(rect => rect.id);
    const cellArea = area(cell), depth = coveringIds.length;
    depthHistogram[depth].area += cellArea;
    cells.push({ ...cell, area: cellArea, depth, coveringIds });
  }
  const workspaceArea = area(input.workspace), uncoveredArea = depthHistogram[0].area, coveredArea = workspaceArea - uncoveredArea;
  const overlapArea = depthHistogram.filter(row => row.depth >= 2).reduce((sum, row) => sum + row.area, 0);
  const activeFootprintArea = active.reduce((sum, rect) => sum + area(rect), 0);
  const depthWeightedArea = depthHistogram.reduce((sum, row) => sum + row.depth * row.area, 0);
  if (depthHistogram.reduce((sum, row) => sum + row.area, 0) !== workspaceArea || depthWeightedArea !== activeFootprintArea
    || ![workspaceArea, uncoveredArea, coveredArea, overlapArea, activeFootprintArea, depthWeightedArea].every(Number.isSafeInteger)) throw new Error('Internal coverage conservation failure.');
  return { activeIds: active.map(rect => rect.id), inactiveIds: ids.filter(id => selections[id] === 'inactive'), allInactive: active.length === 0,
    workspaceArea, coveredArea, uncoveredArea, overlapArea, activeFootprintArea, depthWeightedArea, depthHistogram, xEdges, yEdges, cells,
    sourceHash: hash(input), policyHash: POLICY_HASH, areaConserved: true, physicalCoverageVerified: false };
}
export function coveragePlan(rawInput, answers) {
  const input = validateInput(rawInput);
  if (!Array.isArray(answers) || answers.length !== input.footprints.length || Array.from(answers).some((row, index) => !keys(row, ['footprintId', 'choice']) || row.footprintId !== input.footprints[index].id || ![null, 'active', 'inactive', 'unknown'].includes(row.choice))) throw new Error('Supply one ordered Active, Inactive, Unknown or null choice per footprint.');
  const missingFootprintIds = answers.filter(row => row.choice === null).map(row => row.footprintId), unknownFootprintIds = answers.filter(row => row.choice === 'unknown').map(row => row.footprintId);
  const status = missingFootprintIds.length ? 'incomplete' : unknownFootprintIds.length ? 'unknown' : 'complete';
  return { status, missingFootprintIds, unknownFootprintIds, analysis: status === 'complete' ? analyzeCoverage(input, Object.fromEntries(answers.map(row => [row.footprintId, row.choice]))) : null };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed coverage input. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved footprint choice or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}



export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = input.footprints.map(footprint => {
    const attempt = state.attempts.find(row => row.itemId === footprint.id), answer = attempt?.observation?.answer;
    return { footprintId: footprint.id, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = coveragePlan(input, answers.map(({ footprintId, choice }) => ({ footprintId, choice })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  return { version: 1, planId: input.planId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved footprint choice evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered footprint choices must not contain footprint choice evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
