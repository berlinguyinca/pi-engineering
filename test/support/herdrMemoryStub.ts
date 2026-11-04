/**
 * A stub `herdr-memory` client for tests: a real executable that speaks the real
 * client contract (herdr-memory 0.1.1: global `--config`/`--project`/`--harness`,
 * the `status|sync|doctor|recall|retain|remember|summary|correct|get|forget`
 * actions, one JSON object on stdout, exit 1 + `{"error": ...}` on failure),
 * backed by a JSON file instead of the Hindsight service.
 *
 * Tests point PI_HINDSIGHT_ENABLED/PI_HINDSIGHT_CLI at it, so the provider under
 * test runs its real argv building, timeout, JSON parsing, record normalization and
 * error mapping — only the service is replaced. Behavior comes from a state file,
 * so one test can turn a working client into a broken one mid-session.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HerdrStubMode = "ok" | "fail" | "leaky" | "offline" | "unhealthy" | "slow" | "hang" | "garbage";

export interface HerdrStubRecord {
  document_id: string;
  text: string;
  scope?: string;
  revision?: number;
  status?: string;
  provenance?: Record<string, unknown>;
  evidence?: string[];
}

export interface HerdrStub {
  /** Executable to put in PI_HINDSIGHT_CLI. */
  cli: string;
  /** State file `{mode, records, revision}` — flip `mode` to simulate outages. */
  stateFile: string;
  /** One JSON line per invocation (`{argv, mode}`), to assert what the client was asked. */
  callsFile: string;
  setMode(mode: HerdrStubMode): void;
  setRecords(records: HerdrStubRecord[]): void;
  records(): HerdrStubRecord[];
  calls(): Array<{ argv: string[]; mode: string }>;
}

// Written as .mjs (always ESM, whatever the nearest package.json says) behind a
// `herdr-memory` shell wrapper naming an absolute interpreter: the provider under
// test sanitizes the child environment, so PATH is not guaranteed to help.
const IMPL = `import * as fs from 'node:fs';

// Paths are baked in at generation time — the provider strips the child env on purpose.
const stateFile = __STATE_FILE__;
const callsFile = __CALLS_FILE__;
const argv = process.argv.slice(2);
const NL = String.fromCharCode(10);
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const write = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
const say = (value) => process.stdout.write(JSON.stringify(value));
const fail = (message, write_action) => {
  say(write_action ? { error: message, outcome: 'rejected' } : { error: message });
  process.exit(1);
};
const GLOBALS = ['--config', '--project', '--harness'];
const VALUE_FLAGS = new Set(GLOBALS.concat(['--kind', '--scope', '--max-results', '--timeout-ms', '--as-of', '--provenance', '--document-id', '--document_id', '--base-revision', '--evidence']));
const positionals = [];
const flags = new Map();
const repeated = new Map();
const scopes = [];
const evidence = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith('--')) { positionals.push(arg); continue; }
  const name = arg.slice(2);
  const value = argv[i + 1];
  if (VALUE_FLAGS.has(arg) && value !== undefined) {
    flags.set(name, value);
    if (name === 'scope') scopes.push(value);
    if (name === 'evidence') evidence.push(value);
    i++;
    continue;
  }
  flags.set(name, true);
}
const action = positionals[0];
const WRITES = ['remember', 'summary', 'retain', 'correct', 'forget'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.appendFileSync(callsFile, JSON.stringify({ argv, mode: read().mode }) + NL);

function record(row) {
  // What client.recall hands the caller: contract-normalized records.
  return {
    memory_id: row.document_id,
    bank_id: 'stub-bank',
    revision: row.revision || 1,
    kind: 'fact',
    status: row.status || 'verified',
    text: row.text,
    provenance: row.provenance || {},
    score: 1,
  };
}

// Enough recall behavior to be a fair stand-in: stopword-insensitive token overlap,
// so a question matches a note the way a semantic index would, not by substring.
const STOPWORDS = new Set(
  'a an the and or but that this these those what which who whom whose with from can could should would may might must shall please how when where why are was were will have has had do does did not no nor of on in at to it its i we you they them he she be been being about into over under using use want need help know remember tell say said very just more most other any all each every some'.split(' '),
);

function terms(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\\p{L}\\p{N}\\s]/gu, ' ')
    .split(/\\s+/)
    .filter((word) => word && !STOPWORDS.has(word));
}

function overlap(wanted, text) {
  const haystack = new Set(terms(text));
  if (wanted.size === 0) return 1;
  let matched = 0;
  for (const word of wanted) if (haystack.has(word)) matched++;
  return matched / wanted.size;
}

async function main() {
  const state = read();
  const mode = state.mode || 'ok';
  if (mode === 'slow') await wait(1500);
  if (mode === 'hang') await wait(10 * 60 * 1000);
  if (mode === 'garbage') return say('<html> is not json');
  if (mode === 'fail') {
    // What the client prints when its profile has no usable key. Never a secret.
    return fail('No credential configured for this project and harness', WRITES.includes(action));
  }
  if (mode === 'leaky') {
    // A client (or a proxy in front of it) that repeats a credential back in its
    // error text. Any surface that echoes this verbatim would leak it.
    return fail('No credential for https://user:s3cr3t-token@memory.example:8443/api', WRITES.includes(action));
  }
  if (action === 'status') {
    const rows = read();
    const healthy = mode !== 'unhealthy';
    return say({
      project: healthy ? 'stub-project' : undefined,
      harness: 'pi',
      pending: rows.pending || 0,
      contract: 1,
      healthy,
      outbox_pending: rows.pending || 0,
      dead_letter: 0,
      server_version: healthy ? '1.0.0' : null,
    });
  }
  if (action === 'recall') {
    const query = positionals[1] || '';
    const max = flags.get('max-results');
    // Live behavior, verified against the real client and service: a query must be
    // nonempty, '*' is not a wildcard (the service answers HTTP 422), and the only
    // scopes a Pi session may name are project|global|infra|mission:ID — naming one
    // the caller cannot read fails the whole recall.
    if (query === '') return fail('Recall requires a nonempty query of at most 16000 characters', false);
    if (query === '*') return fail('Memory service rejected request (HTTP 422)', false);
    const requested = scopes.length ? scopes : ['project'];
    const refused = requested.find((scope) => !/^(project|global|infra|mission:[a-z0-9][a-z0-9_-]{0,63})$/.test(scope));
    if (refused !== undefined) return fail('Memory scope not permitted', false);
    const wanted = new Set(terms(query));
    let rows = (read().records || [])
      .filter((row) => requested.includes(row.scope || 'project'))
      .map((row) => ({ row, score: overlap(wanted, row.text) }))
      .filter((entry) => entry.score > 0.2)
      .sort((a, b) => b.score - a.score || String(a.row.document_id).localeCompare(String(b.row.document_id)))
      .map((entry) => entry.row);
    if (mode === 'offline') return say({ offline: true, cache_age_seconds: 60, data: { results: [] }, results: rows.map(record), degraded: true, timing_ms: 5 });
    if (max !== undefined && max !== true) rows = rows.slice(0, Number(max));
    return say({ offline: false, cache_age_seconds: 0, data: { results: [] }, results: rows.map(record), degraded: false, timing_ms: 5 });
  }
  if (action === 'get') {
    const row = (read().records || []).find((entry) => entry.document_id === positionals[1]);
    if (!row) return fail('Memory not found', false);
    return say(record(row));
  }
  if (action === 'retain' || action === 'remember' || action === 'summary') {
    const text = positionals[1];
    const explicit = flags.get('explicit') === true;
    if (!evidence.length && !explicit) return fail('Durable facts require explicit save intent or evidence references', true);
    const rows = read();
    rows.revision = (rows.revision || 0) + 1;
    const document_id = flags.get('document-id') || 'stub-' + ((rows.records || []).length + 1);
    const existing = (rows.records || []).find((entry) => entry.document_id === document_id);
    const entry = {
      document_id,
      text,
      scope: flags.get('scope') || 'project',
      revision: rows.revision,
      status: 'verified',
      provenance: flags.get('provenance') ? JSON.parse(flags.get('provenance')) : {},
      evidence,
    };
    rows.records = existing ? rows.records.map((row) => (row.document_id === document_id ? entry : row)) : (rows.records || []).concat([entry]);
    write(rows);
    return say({ state: 'delivered', outcome: 'persisted', document_id, memory_id: document_id, bank_id: 'stub-bank' });
  }
  if (action === 'correct') {
    if (!evidence.length) return fail('A correction requires at least one evidence reference', true);
    const rows = read();
    rows.revision = (rows.revision || 0) + 1;
    const document_id = positionals[1];
    const found = (rows.records || []).some((row) => row.document_id === document_id);
    if (!found) return fail('Memory not found', true);
    rows.records = rows.records.map((row) =>
      row.document_id === document_id
        ? { ...row, text: positionals[2], revision: rows.revision, evidence }
        : { ...row, status: row.document_id === document_id ? row.status : row.status },
    );
    write(rows);
    return say({ state: 'delivered', outcome: 'persisted', document_id, memory_id: document_id, bank_id: 'stub-bank' });
  }
  if (action === 'forget') {
    const rows = read();
    rows.records = (rows.records || []).filter((row) => row.document_id !== positionals[1]);
    write(rows);
    return say({ state: 'cancelled', outcome: 'rejected', document_id: positionals[1] });
  }
  if (action === 'sync' || action === 'doctor') return say({ ok: true, delivered: 0, pending: 0 });
  return fail('unknown action: ' + String(action), false);
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write('herdr-memory: ' + String((error && error.message) || error) + NL);
    process.exit(1);
  },
);
`;

interface StubState {
  mode: HerdrStubMode;
  records: HerdrStubRecord[];
  revision?: number;
  pending?: number;
}

function readState(stateFile: string): StubState {
  return JSON.parse(readFileSync(stateFile, "utf8")) as StubState;
}

export function makeHerdrStub(dir: string, mode: HerdrStubMode = "ok"): HerdrStub {
  mkdirSync(dir, { recursive: true });
  const cli = join(dir, "herdr-memory");
  const impl = join(dir, "herdr-memory.mjs");
  const stateFile = join(dir, "state.json");
  const callsFile = join(dir, "calls.jsonl");
  writeFileSync(
    impl,
    IMPL.replace("__STATE_FILE__", JSON.stringify(stateFile)).replace("__CALLS_FILE__", JSON.stringify(callsFile)),
    { mode: 0o755 },
  );
  writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(impl)} "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(cli, 0o755);
  chmodSync(impl, 0o755);
  writeFileSync(stateFile, JSON.stringify({ mode, records: [] } satisfies StubState));
  writeFileSync(callsFile, "");
  return {
    cli,
    stateFile,
    callsFile,
    setMode: (next) => writeFileSync(stateFile, JSON.stringify({ ...readState(stateFile), mode: next })),
    setRecords: (records) => writeFileSync(stateFile, JSON.stringify({ ...readState(stateFile), records })),
    records: () => readState(stateFile).records ?? [],
    calls: () =>
      readFileSync(callsFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { argv: string[]; mode: string }),
  };
}

/** Env for a session that talks to the stub instead of the service. */
export function herdrStubEnv(stub: HerdrStub, extra: Record<string, string> = {}): Record<string, string> {
  // Only the opt-in and the executable: the stub's own paths are baked into the
  // script, because the provider under test strips the child environment.
  return { PI_HINDSIGHT_ENABLED: "1", PI_HINDSIGHT_CLI: stub.cli, ...extra };
}
