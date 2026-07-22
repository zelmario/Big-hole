/**
 * Reader for the oracle dumps produced by `tools/oracle`.
 *
 * The oracle decodes a fixture with MongoDB's own Go implementation
 * (github.com/mongodb/ftdc, via ReadMetrics) and emits JSONL:
 *
 *   {"t":"schema","i":0,"keys":[...],"types":[...]}
 *   {"t":"sample","v":[...]}
 *   {"t":"summary","samples":N,"schemas":M,"file":"..."}
 *
 * Sample values are positionally aligned with the most recent schema line.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/** Non-finite doubles cannot be represented in JSON, so the oracle encodes them as strings. */
function decodeValue(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v === 'NaN') return NaN;
  if (v === 'Inf') return Infinity;
  if (v === '-Inf') return -Infinity;
  if (v === null) return NaN; // a type the oracle does not model; treated as a gap
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new Error(`oracle: unexpected value in dump: ${JSON.stringify(v)}`);
}

export interface OracleSample {
  /** Index of the sample within the whole file, 0-based. */
  readonly index: number;
  /** Metric paths in flatten order, from the schema line in effect for this sample. */
  readonly keys: readonly string[];
  readonly types: readonly string[];
  readonly values: readonly number[];
  /** True when this sample is the first under a new schema (i.e. schema drift occurred). */
  readonly schemaChanged: boolean;
}

export async function* readOracle(path: string): AsyncGenerator<OracleSample> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let keys: readonly string[] = [];
  let types: readonly string[] = [];
  let index = 0;
  let pendingSchemaChange = false;

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      const rec = JSON.parse(line) as Record<string, unknown>;

      switch (rec['t']) {
        case 'schema':
          keys = rec['keys'] as string[];
          types = rec['types'] as string[];
          pendingSchemaChange = true;
          break;

        case 'sample': {
          const raw = rec['v'] as unknown[];
          if (raw.length !== keys.length) {
            throw new Error(
              `oracle: sample ${index} has ${raw.length} values but schema has ${keys.length} keys`,
            );
          }
          yield {
            index,
            keys,
            types,
            values: raw.map(decodeValue),
            schemaChanged: pendingSchemaChange,
          };
          pendingSchemaChange = false;
          index++;
          break;
        }

        case 'summary':
          return;

        default:
          throw new Error(`oracle: unknown record type ${JSON.stringify(rec['t'])}`);
      }
    }
  } finally {
    rl.close();
  }
}

export interface Fixture {
  readonly name: string;
  /** Path to the raw `metrics.*` file. */
  readonly ftdc: string;
  /** Path to the oracle JSONL dump. */
  readonly oracle: string;
  readonly bytes: number;
}

/**
 * Discover fixtures under sample-data/.
 *
 * Expected layout, produced by `npm run fixtures`:
 *
 *   sample-data/<name>/metrics.<timestamp>
 *   sample-data/<name>/metrics.<timestamp>.oracle.jsonl
 */
export function discoverFixtures(root = 'sample-data'): Fixture[] {
  if (!existsSync(root)) return [];

  const out: Fixture[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;

    for (const file of readdirSync(dir)) {
      if (!file.startsWith('metrics.') || file.endsWith('.oracle.jsonl')) continue;
      const ftdc = join(dir, file);
      const oracle = `${ftdc}.oracle.jsonl`;
      if (!existsSync(oracle)) continue;
      out.push({ name: `${name}/${file}`, ftdc, oracle, bytes: statSync(ftdc).size });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
