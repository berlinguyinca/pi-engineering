// D06: the entry shim registers /diagnose-errors as a thin read-only adapter over D05 — exact clustered totals through injected deps, the exit class visible, --export refused for want of a writer, exit 3 for a refused namespace, and nothing ever written.
import assert from "node:assert/strict"; import { test } from "node:test"; import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { aggregateErrorOccurrences } from "../../src/incidents/errorAggregate.ts"; import { ERROR_OCCURRENCE_VERSION, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts"; import { type ErrorIndex, readHostErrorOccurrences } from "../../src/incidents/errorReader.ts";
import { type DiagnoseHooks, installPiEngineering, registerDiagnoseErrors } from "../../src/runtime/host/entry.ts";
type Ctx = { cwd: string; ui: { notify: (m: string, l?: string) => void } }; type Cmd = { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> }; type Reader = (ns: string) => ErrorIndex;
const fake = () => { const commands = new Map<string, Cmd>(); const notes: [string, string | undefined][] = []; const ctx: Ctx = { cwd: "/repo", ui: { notify: (m, l) => { notes.push([m, l]); } } }; return { commands, notes, ctx, pi: { registerCommand: (n: string, o: Cmd) => { commands.set(n, o); }, on: () => () => {} } as unknown as ExtensionAPI }; };
const occ = (over: Partial<ErrorOccurrence> = {}): ErrorOccurrence => ({ version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-01T00:00:00Z", host: "host-a", sessionId: "sess-a", runtime: "pi@aaa1111", layer: "gateway", code: "gateway.429.rate_limited", severity: "warning", summary: "upstream rate limit: 429", runId: null, taskId: null, model: "gemma-2b", quantization: null, correlationIds: [], artifactRefs: [], ...over });
const INDEX = (dir: string, rows: number[]): ErrorIndex => ({ namespaceDir: dir, refused: null, scannedStreams: 1, scannedEvents: rows.length, skipped: { foreignType: 0, corrupt: 0, unparsable: 0 }, truncated: false, occurrences: rows.map((i) => ({ eventId: `evt-${i}`, stream: "errors.jsonl", occurrence: rows.length > 3 || i >= 2 ? occ({ layer: "host", code: `host.e${i}`, summary: `disk full ${i}` }) : occ() })) }); // 3 rows -> 2 clusters
let reads = 0; const three: Reader = (ns) => { reads++; return INDEX(ns, [0, 1, 2]); }; const seven: Reader = (ns) => { reads++; return INDEX(ns, [0, 1, 2, 3, 4, 5, 6]); }; // 7 rows -> 7 clusters
const DEPS = (read: Reader = three): DiagnoseHooks["deps"] => ({ read, aggregate: aggregateErrorOccurrences, evidence: () => null, hostname: () => "host-a", exists: () => false }); // never a writeFile: that is the whole point
const at = (dir: string, read: Reader = three): DiagnoseHooks => ({ namespace: async () => dir, deps: DEPS(read) }); const realD01: DiagnoseHooks["deps"] = { read: readHostErrorOccurrences, exists: () => false, hostname: () => "host-a" }; // no injected read: this row reports what disk state does
const invoke = async (f: ReturnType<typeof fake>, load: () => Promise<DiagnoseHooks>, args = ""): Promise<void> => { registerDiagnoseErrors(f.pi, load); await f.commands.get("diagnose-errors")?.handler(args, f.ctx); };

test("registration: the shim registers /diagnose-errors with a description, whether the Host installs or fails", async () => {
  const f = fake(); await invoke(f, () => Promise.resolve(at("/ns")));
  const cmd = f.commands.get("diagnose-errors"); assert.ok(cmd !== undefined && typeof cmd.handler === "function", "registered through pi.registerCommand"); assert.match(String(cmd?.description), /read-only/i); assert.match(String(cmd?.description), /never writes/i);
  for (const host of [() => Promise.resolve({ default: () => {} }), () => Promise.reject(new Error("host is broken"))]) {
    const g = fake(); await installPiEngineering(g.pi, { host, legacy: () => Promise.resolve({ default: () => {} }) });
    assert.ok(g.commands.has("diagnose-errors"), "the diagnosis survives a Host that cannot install");
  }
});
test("read-only diagnose through injected deps: exact clustered totals, one read, the discovered namespace, no writer in scope", async () => {
  const f = fake(); const before = reads; let cwd = "";
  await invoke(f, () => Promise.resolve({ namespace: async (dir: string) => { cwd = dir; return "/ns"; }, deps: DEPS() }));
  assert.deepEqual([reads - before, cwd, f.notes.length], [1, "/repo", 1], "exactly one read through the injected reader, over what namespace discovery derived from ctx.cwd");
  const [msg, lvl] = f.notes[0]!; assert.equal(lvl, "info"); assert.match(msg, /namespace=\/ns/); assert.match(msg, /read scannedStreams=1 scannedEvents=3 skipped=0\/0\/0 truncated=false refused=none/);
  assert.match(msg, /occurrences=3 clusters=2 recovered=0 unresolved=3 duplicateEvents=0 rejected=0/, "the exact human totals line D05 prints");
  assert.equal(msg.split("\n").filter((l) => l.startsWith("cluster=")).length, 2); assert.match(msg, /exit=0 ok/, "the exit-code class is visible in the message"); assert.deepEqual(Object.keys(DEPS()).sort(), ["aggregate", "evidence", "exists", "hostname", "read"], "the injected scope is read, aggregate, evidence, hostname, exists — and no writer");
});
test("--export is refused with the exit-4 class for want of a writer, and the namespace stays byte-identical", async () => {
  const parent = mkdtempSync(join(tmpdir(), "d06-")); const dir = join(parent, "ns"); mkdirSync(dir); writeFileSync(join(dir, "errors.jsonl"), '{"event_id":"evt-0"}\n');
  const before: [string, number] = [readdirSync(dir).sort().join(","), readFileSync(join(dir, "errors.jsonl")).length]; const out = join(parent, "d06-export.json");
  const f = fake(); await invoke(f, () => Promise.resolve(at(dir, (ns) => ({ ...INDEX(ns, []), scannedEvents: 1 }))), `--export ${out}`);
  const [msg, lvl] = f.notes[0]!; const after: [string, number] = [readdirSync(dir).sort().join(","), readFileSync(join(dir, "errors.jsonl")).length]; rmSync(parent, { recursive: true, force: true });
  assert.deepEqual([f.notes.length, lvl, before, after], [1, "warning", ["errors.jsonl", 21], ["errors.jsonl", 21]], "one warning, and the namespace still holds exactly the one file with its bytes unchanged");
  assert.match(msg, /export failed: no export writer injected/); assert.match(msg, /exit=4 read or export failed/); assert.equal(existsSync(out), false, "no export file was created anywhere");
});
test("exit 3: a refused namespace is reported through the real D01 reader and never created; an explicit --namespace wins over discovery", async () => {
  const missing = join(tmpdir(), "d06-no-such-namespace"); const f = fake();
  await invoke(f, () => Promise.resolve({ namespace: async () => { throw new Error("discovery must not run when --namespace is given"); }, deps: realD01 }), `--namespace ${missing}`);
  const [msg, lvl] = f.notes[0]!; assert.match(msg, new RegExp(`namespace refused \\(missing\\): ${missing}`), "the class came from disk, not from a fake"); assert.match(msg, /exit=3 namespace refused/); assert.equal(lvl, "warning"); assert.equal(existsSync(missing), false, "a diagnosis never creates the namespace it reports on");
});
test("bounded and refused before reading: top five clusters then the counted remainder; a bad flag reads nothing", async () => {
  const f = fake(); await invoke(f, () => Promise.resolve(at("/ns", seven))); const msg = f.notes[0]![0];
  assert.match(msg, /occurrences=7 clusters=7/); assert.equal(msg.split("\n").filter((l) => l.startsWith("cluster=")).length, 5, "top clusters only"); assert.match(msg, /… 2 more clusters/);
  const g = fake(); const before = reads; await invoke(g, () => Promise.resolve(at("/ns")), "--bogus"); assert.deepEqual([g.notes.length, g.notes[0]![0], g.notes[0]![1], reads - before], [1, "unknown argument: --bogus", "warning", 0], "D05 refuses argv before anything is read");
});
