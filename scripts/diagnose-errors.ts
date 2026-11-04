#!/usr/bin/env node
/** D05 — read-only diagnose-errors CLI: clustered E02/E05 error totals for ONE verified local namespace.
 * Read-only: every read goes through `deps.read` (D01 `readHostErrorOccurrences`, which never opens a writer), and
 * the only write is the explicit `--export <path>`, performed by the injected dependency and by nothing else. No
 * directory is created, nothing is written inside the namespace, no configuration and no environment is read, no
 * process is spawned, and no model, provider or network call is made. `--host` defaults to `os.hostname()` only when
 * that yields a printable id — it is never guessed. `--model` rides in the filter for the injected reader and is
 * applied here too, because D01's own filter has no model dimension.
 * Flags: --namespace <dir> (required) | --last <n, 1..5000> | --all-sessions (default) | --no-all-sessions (needs
 * --session) | --session <id> | --model <id> | --host <id> | --json | --export <path> [--force] | --help.
 * Exit codes: 0 read succeeded (matched or not); 2 argument validation failed or an --export pre-flight refusal, so
 * nothing is read; 3 namespace refused or missing (D01 reported `refused`); 4 unexpected read or export failure. */
import { existsSync } from "node:fs"; import { hostname } from "node:os"; import { isAbsolute, relative, resolve } from "node:path"; import { pathToFileURL } from "node:url";
import { type AggregateResult, type AggregateRow, aggregateErrorOccurrences } from "../src/incidents/errorAggregate.ts";
import { classifyRecoveryOutcome, type RecoveryEvidence } from "../src/incidents/recoveryOutcome.ts";
import { type ErrorIndex, type ErrorIndexFilter, readHostErrorOccurrences } from "../src/incidents/errorReader.ts";
export const MAX_LAST = 5000; const SAFE = /^[\x21-\x7e]+$/; // an identifier with no whitespace and no control character
export const USAGE = "usage: node --experimental-strip-types scripts/diagnose-errors.ts --namespace <dir> [--last <n>] [--all-sessions|--no-all-sessions] [--session <id>] [--model <id>] [--host <id>] [--json] [--export <path> [--force]] [--help]";
export interface DiagnoseOptions { help?: boolean; namespace: string; last?: number; allSessions: boolean; sessionId?: string; model?: string; host?: string; json?: boolean; exportPath?: string; force?: boolean }
export interface ParseResult { ok: boolean; opts?: DiagnoseOptions; errors: string[] } export interface DiagnoseResult { exitCode: number; stdout: string[]; stderr: string[] }
export interface DiagnoseDeps { read: typeof readHostErrorOccurrences; aggregate?: typeof aggregateErrorOccurrences; evidence?: (eventId: string) => RecoveryEvidence | null; hostname?: () => string; exists?: (path: string) => boolean; writeFile?: (path: string, text: string) => void }
export function parseArgs(argv: string[]): ParseResult {
  const errors: string[] = []; const got = new Map<string, string>(); const on = new Set<string>(); let allOff = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === "--help" || tok === "--json" || tok === "--force" || tok === "--all-sessions") { on.add(tok.slice(2)); continue; }
    if (tok === "--no-all-sessions") { allOff = true; continue; }
    if (!["--namespace", "--last", "--session", "--model", "--host", "--export"].includes(tok)) { errors.push(`unknown argument: ${tok}`); continue; }
    const value = argv[++i]; if (value === undefined || value.startsWith("--")) errors.push(`${tok} requires a value`);
    else if (got.has(tok.slice(2))) errors.push(`${tok} given more than once`); else got.set(tok.slice(2), value);
  }
  if (on.has("help")) return { ok: true, opts: { help: true, namespace: "", allSessions: true }, errors: [] };
  const opts: DiagnoseOptions = { namespace: got.get("namespace") ?? "", allSessions: !allOff, json: on.has("json"), force: on.has("force") }; if (opts.namespace === "") errors.push("--namespace <dir> is required");
  const last = got.get("last"); if (last !== undefined) { const n = Number(last); if (!/^\d+$/.test(last) || n < 1 || n > MAX_LAST) errors.push(`--last must be a positive integer no greater than ${MAX_LAST}`); else opts.last = n; if (allOff) errors.push("--last cannot be combined with --no-all-sessions"); }
  if (allOff && got.get("session") === undefined) errors.push("--no-all-sessions requires --session <id>");
  for (const key of ["session", "model", "host"] as const) { const v = got.get(key); if (v === undefined) continue; if (!SAFE.test(v)) errors.push(`--${key} must not contain whitespace or control characters`); else if (key === "session") opts.sessionId = v; else if (key === "model") opts.model = v; else opts.host = v; }
  if (got.has("export")) opts.exportPath = got.get("export"); // the one path this CLI may ever write to
  return errors.length === 0 ? { ok: true, opts, errors: [] } : { ok: false, errors };
}
export function runDiagnoseErrors(opts: DiagnoseOptions, deps: DiagnoseDeps): DiagnoseResult {
  const out: string[] = []; const err: string[] = []; if (opts.help === true) return { exitCode: 0, stdout: [USAGE], stderr: [] }; // --help is a success path, not a usage error
  const ns = resolve(opts.namespace); const filter: ErrorIndexFilter & { model?: string } = {};
  if (opts.last !== undefined) filter.limit = opts.last; if (opts.sessionId !== undefined) filter.sessionId = opts.sessionId; if (opts.model !== undefined) filter.model = opts.model;
  const local = opts.host ?? String(deps.hostname?.() ?? hostname()); if (opts.host !== undefined || SAFE.test(local)) filter.host = local; else return { exitCode: 2, stdout: out, stderr: ["--host omitted and os.hostname() gave no printable id"] };
  if (opts.exportPath !== undefined) { const p = resolve(opts.exportPath); const rel = relative(ns, p); if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { exitCode: 2, stdout: out, stderr: [`refusing --export inside the namespace directory: ${p}`] }; if (opts.force !== true && (deps.exists ?? existsSync)(p)) return { exitCode: 2, stdout: out, stderr: [`refusing to overwrite existing file ${p}; pass --force`] }; }
  let index: ErrorIndex; try { index = deps.read(ns, filter); } catch (e) { return { exitCode: 4, stdout: out, stderr: [`read failed: ${(e as Error).message}`] }; }
  if (index.refused !== null) return { exitCode: 3, stdout: out, stderr: [`namespace refused (${index.refused}): ${index.namespaceDir}`] };
  const resolution = (eventId: string): "recovered" | "unresolved" => { const ev = deps.evidence?.(eventId); return ev !== undefined && ev !== null && classifyRecoveryOutcome(ev).outcome === "recovered" ? "recovered" : "unresolved"; }; // D04 owns recovery: with no durable evidence a row stays unresolved, never a invented one
  const rows: AggregateRow[] = index.occurrences.filter((o) => opts.model === undefined || o.occurrence.model === opts.model).map((o) => ({ eventId: o.eventId, occurrence: o.occurrence, resolution: resolution(o.eventId) }));
  const agg: AggregateResult = (deps.aggregate ?? aggregateErrorOccurrences)(rows); const recovered = rows.filter((r) => r.resolution === "recovered").length;
  const totals = { occurrences: rows.length, clusters: agg.clusters.length, duplicateEvents: agg.duplicateEvents, rejected: agg.rejected, recovered, unresolved: rows.length - recovered };
  const payload = { namespace: index.namespaceDir, read: { scannedStreams: index.scannedStreams, scannedEvents: index.scannedEvents, skipped: index.skipped, truncated: index.truncated, refused: index.refused }, totals, clusters: agg.clusters };
  if (opts.json === true) out.push(JSON.stringify(payload)); else out.push(`namespace=${index.namespaceDir}`, `read scannedStreams=${index.scannedStreams} scannedEvents=${index.scannedEvents} skipped=${index.skipped.foreignType}/${index.skipped.corrupt}/${index.skipped.unparsable} truncated=${index.truncated} refused=${index.refused ?? "none"}`, `occurrences=${totals.occurrences} clusters=${totals.clusters} recovered=${totals.recovered} unresolved=${totals.unresolved} duplicateEvents=${totals.duplicateEvents} rejected=${totals.rejected}`, ...agg.clusters.map((c) => `cluster=${c.fingerprint} count=${c.count} recovered=${c.recovered} unresolved=${c.unresolved} firstSeen=${c.firstSeen} lastSeen=${c.lastSeen} sessions=${c.sessions.join(",")} hosts=${c.hosts.join(",")} models=${c.models.join(",")} codes=${c.codes.join(",")}`));
  if (opts.exportPath !== undefined) { const p = resolve(opts.exportPath); try { (deps.writeFile ?? (() => { throw new Error("no export writer injected"); }))(p, `${JSON.stringify(payload, null, 2)}\n`); out.push(`export=${p}`); } catch (e) { return { exitCode: 4, stdout: out, stderr: [...err, `export failed: ${(e as Error).message}`] }; } }
  return { exitCode: 0, stdout: out, stderr: err };
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) { // main guard
  const parsed = parseArgs(process.argv.slice(2)); if (!parsed.ok || parsed.opts === undefined) { for (const e of parsed.errors) console.error(e); console.error(USAGE); process.exitCode = 2; }
  else { const fs = await import("node:fs"); const r = runDiagnoseErrors(parsed.opts, { read: readHostErrorOccurrences, exists: fs.existsSync, writeFile: (p, s) => { fs.writeFileSync(p, s); } }); for (const line of r.stdout) console.log(line); for (const line of r.stderr) console.error(line); process.exitCode = r.exitCode; }
}
