/**
 * What one logged operation was doing.
 *
 * MongoDB writes the command on a slow operation (statement id 51803, and the applied-op
 * sibling 51801). It also writes it for operations that were not slow: a `system.profile`
 * document, a pre-4.4 text line, or a command log at some other statement id. The literals
 * differ every call, so replacing them with a placeholder puts those calls in one row.
 *
 * Only the predicate is walked. `$db`, `lsid` and `$clusterTime` are connection bookkeeping
 * and would otherwise split one query into thousands of shapes.
 */

import { attrOf } from './parse.js';

/** Heartbeats and handshakes. They dominate a log and are not a query anyone sent. */
const INTERNAL = new Set([
  'hello',
  'ismaster',
  'isMaster',
  'ping',
  'saslStart',
  'saslContinue',
  'replSetHeartbeat',
  'replSetUpdatePosition',
  'endSessions',
  'whatsmyuri',
]);

const EXTENDED = new Set([
  '$oid',
  '$date',
  '$numberLong',
  '$numberInt',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$timestamp',
  '$uuid',
  '$minKey',
  '$maxKey',
  '$undefined',
]);

export interface QueryShape {
  readonly op: string;
  readonly ns: string;
  /** Predicate with literals replaced, so equal shapes compare equal. */
  readonly pattern: string;
  /** `planSummary` as mongod wrote it: `COLLSCAN`, `IXSCAN { n: 1 }`, …. */
  readonly plan: string;
  readonly collscan: boolean;
  /** One sentence: collection, predicate, and how it was executed. */
  readonly doing: string;
  readonly durationMs: number;
  readonly docsExamined: number;
  readonly keysExamined: number;
  readonly returned: number;
  /**
   * False when this operation does not report a document yield (`nreturned`, `nMatched`,
   * `ndeleted`). A count, a distinct, or a delete with no `ndeleted` must not be read as
   * "returned none".
   */
  readonly yields: boolean;
  readonly reslen: number;
  readonly appName: string;
}

export type SlowOpParse =
  | { readonly kind: 'op'; readonly shape: QueryShape }
  | { readonly kind: 'internal' }
  | { readonly kind: 'skip' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Documents this call produced, matched, or deleted.
 *
 * Finds report `nreturned`. Deletes report `ndeleted`. Updates report `nMatched`: an update
 * that finds the document and writes the value it already holds logs `nModified: 0`, and that
 * is not "returned none". `distinct` and `count` log no yield on any version. Missing is not
 * the same as zero.
 */
function yieldOf(op: string, attr: Record<string, unknown>): { returned: number; yields: boolean } {
  if (op === 'count' || op === 'distinct' || op === 'insert' || op === 'createIndexes') {
    return { returned: 0, yields: false };
  }
  if (op === 'delete' || op === 'remove') {
    const deleted = numOrNull(attr['ndeleted']);
    return deleted === null ? { returned: 0, yields: false } : { returned: deleted, yields: true };
  }
  if (op === 'update') {
    const matched = numOrNull(attr['nMatched']) ?? numOrNull(attr['nModified']);
    return matched === null ? { returned: 0, yields: false } : { returned: matched, yields: true };
  }
  if (op === 'findAndModify') {
    // `remove: true` logs `ndeleted`. An update logs `nMatched`, which stays 1 when `nModified` is 0.
    const affected = numOrNull(attr['ndeleted']) ?? numOrNull(attr['nMatched']) ?? numOrNull(attr['nreturned']);
    return affected === null ? { returned: 0, yields: false } : { returned: affected, yields: true };
  }
  const returned = numOrNull(attr['nreturned']) ?? numOrNull(attr['nMatched']);
  return returned === null ? { returned: 0, yields: true } : { returned, yields: true };
}

/**
 * The command name is the first key. Later keys are arguments, so `update` inside a
 * findAndModify is the modification, not the operation.
 */
function opOf(command: Record<string, unknown>): string {
  for (const key of Object.keys(command)) {
    if (key.startsWith('$') || key === 'lsid') continue;
    return key === 'findandmodify' ? 'findAndModify' : key;
  }
  return '';
}

function resolveNs(ns: string, command: Record<string, unknown>, op: string): string {
  if (!ns.endsWith('.$cmd')) return ns;
  const db = ns.slice(0, -5);
  const named = command[op];
  if (typeof named !== 'string' || named.length === 0) return ns;
  return named.includes('.') ? named : `${db}.${named}`;
}

/** Literals become 1. Field names and operators stay, which is the shape. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (!isRecord(value)) return 1;

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] !== undefined && EXTENDED.has(keys[0])) return 1;
  if (keys.length === 1 && keys[0] === '$regularExpression') return '/…/';
  if (typeof value['$regex'] === 'string') return '/…/';

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const child = value[key];
    // Value lists are not part of the shape. `$and` / `$or` / pipelines are, so they stay.
    if ((key === '$in' || key === '$nin') && Array.isArray(child)) {
      out[key] = ['…'];
      continue;
    }
    out[key] = normalize(child);
  }
  return out;
}

function format(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === '…') return '[…]';
    return `[${value.map((item) => format(item)).join(', ')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{ ${keys.map((key) => `${key}: ${format(value[key])}`).join(', ')} }`;
  }
  if (value === '…') return '…';
  if (value === '/…/') return '/…/';
  return '1';
}

function predicate(command: Record<string, unknown>): unknown {
  const direct = command['filter'] ?? command['query'] ?? command['q'];
  if (direct !== undefined) return direct;

  const batch = command['updates'] ?? command['deletes'];
  if (Array.isArray(batch) && isRecord(batch[0])) {
    return batch[0]['q'] ?? batch[0]['filter'] ?? {};
  }
  return {};
}

function stageNames(pipeline: unknown): string[] {
  if (!Array.isArray(pipeline)) return [];
  const names: string[] = [];
  for (const stage of pipeline) {
    if (!isRecord(stage)) continue;
    const name = Object.keys(stage)[0];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function matchOf(pipeline: unknown): unknown {
  if (!Array.isArray(pipeline)) return undefined;
  for (const stage of pipeline) {
    if (isRecord(stage) && '$match' in stage) return stage['$match'];
  }
  return undefined;
}

function writeClause(command: Record<string, unknown>): string {
  const batched = command['updates'];
  const spec = Array.isArray(batched) && isRecord(batched[0]) ? batched[0]['u'] : (command['u'] ?? command['update']);
  if (Array.isArray(spec)) return 'via an update pipeline';
  if (!isRecord(spec)) return '';
  const keys = Object.keys(spec);
  if (keys.length > 0 && keys.every((key) => key.startsWith('$'))) {
    return `via ${keys.slice(0, 4).join(', ')}`;
  }
  return 'by replacing the document';
}

/** Index keys are directions, not query literals — `-1` has to survive. */
function indexPattern(indexes: unknown): string {
  if (!Array.isArray(indexes) || !isRecord(indexes[0])) return '';
  const key = indexes[0]['key'];
  if (!isRecord(key)) return '';
  const body = Object.entries(key)
    .map(([name, dir]) => `${name}: ${dir === -1 ? '-1' : '1'}`)
    .join(', ');
  return `{ ${body} }`;
}

function patternOf(op: string, command: Record<string, unknown>): { pattern: string; stages: string[] } {
  if (op === 'aggregate') {
    const pipeline = command['pipeline'];
    const stages = stageNames(pipeline);
    const match = matchOf(pipeline);
    if (match !== undefined) return { pattern: format(normalize(match)), stages };
    return { pattern: format(normalize(pipeline ?? [])), stages };
  }
  if (op === 'insert') return { pattern: '', stages: [] };
  if (op === 'distinct') {
    const key = command['key'];
    return { pattern: typeof key === 'string' ? key : '', stages: [] };
  }
  if (op === 'createIndexes') return { pattern: indexPattern(command['indexes']), stages: [] };
  return { pattern: format(normalize(predicate(command))), stages: [] };
}

function describe(input: {
  op: string;
  ns: string;
  pattern: string;
  plan: string;
  collscan: boolean;
  stages: readonly string[];
  write: string;
  limit: number | null;
  originating: string;
}): string {
  const filtered =
    input.pattern !== '' && input.pattern !== '{}' ? input.pattern : '';
  const empty =
    filtered === '' && (input.op === 'find' || input.op === 'delete' || input.op === 'remove' || input.op === 'count');
  const where = filtered !== '' ? ` where ${filtered}` : empty ? ' with an empty filter (every document)' : '';
  const limit = input.limit !== null && input.limit > 0 ? `, limit ${input.limit}` : '';
  const plan = input.collscan
    ? ' Collection scan — no index was used.'
    : input.plan !== ''
      ? ` Plan: ${input.plan}.`
      : '';

  if (input.op === 'getMore') {
    const of = input.originating !== '' ? input.originating : 'query';
    return `Fetches the next batch of a ${of} on ${input.ns}${where}.${plan}`;
  }
  if (input.op === 'aggregate') {
    const flow = input.stages.length > 0 ? input.stages.join(' → ') : 'a pipeline';
    const matching = filtered !== '' && input.stages.includes('$match') ? `, matching ${filtered}` : '';
    const shown = matching === '' && filtered !== '' ? `: ${filtered}` : '';
    return `Aggregation on ${input.ns}: ${flow}${matching}${shown}.${plan}`;
  }
  if (input.op === 'insert') return `Inserts documents into ${input.ns}.`;
  if (input.op === 'createIndexes') {
    return `Creates an index on ${input.ns}${filtered !== '' ? `: ${filtered}` : ''}.`;
  }
  if (input.op === 'distinct') {
    return `Distinct values of ${filtered || 'a field'} in ${input.ns}.${plan}`;
  }

  const verb: Record<string, string> = {
    find: 'Finds documents',
    update: 'Updates documents',
    delete: 'Deletes documents',
    remove: 'Deletes documents',
    count: 'Counts documents',
    findAndModify: 'Modifies and returns a document',
  };
  const lead = verb[input.op] ?? `Runs ${input.op}`;
  const write = input.write !== '' ? `, ${input.write}` : '';
  return `${lead} in ${input.ns}${where}${limit}${write}.${plan}`;
}

function asCommand(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/**
 * Read a slow-query `attr` into a shape, or say why it was not one.
 *
 * `internal` is a handshake or heartbeat — counted, not shown. `skip` is a line that claimed
 * to be a slow operation but carried nothing we can describe.
 */
export function parseSlowOp(attr: Record<string, unknown>): SlowOpParse {
  let command = asCommand(attr['command']);
  const originating = asCommand(attr['originatingCommand']);
  if (command === null) return { kind: 'skip' };

  let op = typeof attr['type'] === 'string' ? attr['type'] : '';
  if (op === 'query') op = 'find';
  if (op === 'getmore') op = 'getMore';
  if (op === '' || op === 'command' || op === 'none' || op === 'op') op = opOf(command);

  let originatingOp = '';
  if (op === 'getMore' && originating !== null) {
    originatingOp = opOf(originating);
    command = originating;
  }

  if (op === '' || INTERNAL.has(op)) return { kind: 'internal' };

  const rawNs = typeof attr['ns'] === 'string' ? attr['ns'] : '';
  const ns = resolveNs(rawNs, command, op === 'getMore' ? originatingOp : op);
  if (ns === '') return { kind: 'skip' };

  const plan = typeof attr['planSummary'] === 'string' ? attr['planSummary'] : '';
  const { pattern, stages } = patternOf(op === 'getMore' ? originatingOp || op : op, command);
  const limit = num(command['limit']);
  const doing = describe({
    op,
    ns,
    pattern,
    plan,
    collscan: plan.split(/[\s,]+/).includes('COLLSCAN'),
    stages,
    write: op === 'update' || op === 'findAndModify' ? writeClause(command) : '',
    limit: limit > 0 ? limit : null,
    originating: originatingOp,
  });

  const yieldCount = yieldOf(op, attr);

  return {
    kind: 'op',
    shape: {
      op,
      ns,
      pattern,
      plan,
      collscan: plan.split(/[\s,]+/).includes('COLLSCAN'),
      doing,
      durationMs: num(attr['durationMillis']),
      docsExamined: num(attr['docsExamined']),
      keysExamined: num(attr['keysExamined']),
      returned: yieldCount.returned,
      yields: yieldCount.yields,
      reslen: num(attr['reslen']),
      appName: typeof attr['appName'] === 'string' ? attr['appName'] : '',
    },
  };
}

/**
 * The command attributes of a line, whatever format it was logged in.
 *
 * Logv2 keeps them under `attr`. A profiler document is the attributes. A pre-4.4 text line
 * carries the command JSON after `command:`.
 */
export function commandAttr(raw: string): Record<string, unknown> | undefined {
  const fromLog = attrOf(raw);
  if (fromLog !== undefined && (isRecord(fromLog['command']) || isRecord(fromLog['originatingCommand']))) {
    return fromLog;
  }
  return profileAttr(raw) ?? legacyAttr(raw);
}

function profileAttr(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{');
  if (start < 0 || !raw.includes('"millis"') || !raw.includes('"ns"')) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw.slice(start)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof doc['ns'] !== 'string' || typeof doc['millis'] !== 'number') return undefined;

  let command = isRecord(doc['command']) ? doc['command'] : undefined;
  if (command === undefined && isRecord(doc['query'])) {
    const coll = doc['ns'].split('.').slice(1).join('.') || doc['ns'];
    command = { find: coll, filter: doc['query'] };
  }
  if (command === undefined) return undefined;

  const op = typeof doc['op'] === 'string' ? doc['op'] : 'command';
  return {
    type: op === 'query' ? 'find' : op === 'getmore' ? 'getMore' : op === 'command' ? 'command' : op,
    ns: doc['ns'],
    command,
    ...(isRecord(doc['originatingCommand']) ? { originatingCommand: doc['originatingCommand'] } : {}),
    ...(typeof doc['planSummary'] === 'string' ? { planSummary: doc['planSummary'] } : {}),
    durationMillis: doc['millis'],
    ...(typeof doc['docsExamined'] === 'number' ? { docsExamined: doc['docsExamined'] } : {}),
    ...(typeof doc['keysExamined'] === 'number' ? { keysExamined: doc['keysExamined'] } : {}),
    ...(typeof doc['nreturned'] === 'number' ? { nreturned: doc['nreturned'] } : {}),
    ...(typeof doc['nMatched'] === 'number' ? { nMatched: doc['nMatched'] } : {}),
    ...(typeof doc['nModified'] === 'number' ? { nModified: doc['nModified'] } : {}),
    ...(typeof doc['ndeleted'] === 'number' ? { ndeleted: doc['ndeleted'] } : {}),
    ...(typeof doc['responseLength'] === 'number' ? { reslen: doc['responseLength'] } : {}),
    ...(typeof doc['appName'] === 'string' ? { appName: doc['appName'] } : {}),
  };
}

/** Brace-matched JSON object starting at `from`, or null. */
function jsonObjectAt(text: string, from: number): string | null {
  if (text[from] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** Pre-4.4 text logs print the command in shell syntax, with unquoted keys. */
function shellToJson(body: string): string {
  const stripped = body.replace(
    /\b(?:UUID|ObjectId|BinData|Timestamp|NumberLong|NumberInt|NumberDecimal|ISODate|Date|DBRef)\([^)]*\)/g,
    '1',
  );
  return stripped.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
}

function legacyAttr(raw: string): Record<string, unknown> | undefined {
  const at = raw.search(/\b(?:command|query):\s*(?:[A-Za-z]+\s+)?\{/);
  if (at < 0) return undefined;
  const brace = raw.indexOf('{', at);
  const body = jsonObjectAt(raw, brace);
  if (body === null) return undefined;
  let command: Record<string, unknown>;
  try {
    command = JSON.parse(body) as Record<string, unknown>;
  } catch {
    try {
      command = JSON.parse(shellToJson(body)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  // 4.0 and 4.2 write `update t.c ... command: { q, u }` and `remove t.c ... command: { q }`.
  // The namespace is the word after that verb, not after `command`.
  const nsMatch = /\b(update|remove|command|query)\s+([\w.$]+)\s/.exec(raw);
  const verb = nsMatch?.[1];
  const ns = nsMatch?.[2];
  const plan = /planSummary:\s*(\S+(?:\s+\{[^}]*\})?)/.exec(raw);
  const millis = /(\d+)ms\s*$/.exec(raw.trim()) ?? /durationMillis[:=]\s*(\d+)/.exec(raw);
  const app = /appName:\s*"([^"]*)"/.exec(raw);
  // Counters sit after the command object. Reading them from the whole line would also
  // match a field of the same name inside the predicate.
  const tail = raw.slice(brace + body.length);
  const counted = (name: string): number | undefined => {
    const match = new RegExp(`(?:^|\\s)${name}:(\\d+)`).exec(tail);
    return match === null ? undefined : Number(match[1]);
  };
  const docs = counted('docsExamined') ?? counted('nscannedObjects');
  const keys = counted('keysExamined') ?? counted('nscanned');
  const returned = counted('nreturned');
  const matched = counted('nMatched');
  const modified = counted('nModified');
  const deleted = counted('ndeleted');
  return {
    type: verb === 'update' || verb === 'remove' ? verb : 'command',
    ...(ns !== undefined ? { ns } : {}),
    command,
    ...(plan !== null ? { planSummary: plan[1]!.trim() } : {}),
    ...(millis !== null ? { durationMillis: Number(millis[1]) } : {}),
    ...(docs !== undefined ? { docsExamined: docs } : {}),
    ...(keys !== undefined ? { keysExamined: keys } : {}),
    ...(returned !== undefined ? { nreturned: returned } : {}),
    ...(matched !== undefined ? { nMatched: matched } : {}),
    ...(modified !== undefined ? { nModified: modified } : {}),
    ...(deleted !== undefined ? { ndeleted: deleted } : {}),
    ...(app !== null ? { appName: app[1]! } : {}),
  };
}

/**
 * Whether this line is worth reading for its command.
 *
 * Slow-query ids are the common case. Anything else logged with a command — a profiler
 * document, a text log, a command line that never crossed `slowms` — is included too.
 * Heartbeats are declined later, once the command is known.
 */
export function shouldReadQuery(line: { id: number; c: string; msg: string }, raw: string): boolean {
  if (line.id === 51803 || line.id === 51801) return true;
  if (line.msg.startsWith('profile ')) return true;
  if (
    (line.c === 'COMMAND' || line.c === 'QUERY' || line.c === 'WRITE') &&
    (/"command"\s*:/.test(raw) || /"originatingCommand"\s*:/.test(raw) || /\bcommand:\s/.test(raw))
  ) {
    return true;
  }
  return false;
}
