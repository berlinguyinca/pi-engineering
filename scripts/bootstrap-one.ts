#!/usr/bin/env node
/**
 * B04: single-task bootstrap CLI wrapper. Loads ONE task manifest, verifies the clean baseline commit,
 * validates the declared parent handoff (FIX-2: `--emit-handoff` re-validates it before it writes; FIX-5: only a parent whose `status` is PASS or ALREADY_SATISFIED may be a base), prints a deterministic execution plan and STOPS — no model call
 * and no scheduler/orchestration/planner import (asserted by the unit test). Read-only: it reads files and
 * asks git only for HEAD and porcelain status. Exit codes: 0 plan, 2 manifest invalid, 3 baseline rejected, 4 handoff rejected, 5 gate rejected, 64 usage, 66 unreadable input.
 * FIX-3C: `--emit-handoff` REQUIRES `--handoff-schema <path>` (resolved against `--cwd` exactly like `--proofs`/`--handoff-record`): the record is schema-validated in the CLI, before anything is written.
 * FIX-4A: `--emit-handoff` derives the task authority from the parsed manifest (`taskAuthorityHash`) and blocks a record that names a different one; the accepted run prints `authority=<taskId> <derived hash>`.
 * Usage: node scripts/bootstrap-one.ts --manifest <path> [--parent-handoff <path>] [--cwd <path>] [--proofs <path>] [--handoff-record <path>] [--handoff-schema <path>] [--emit-handoff <dir>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTaskManifest, type TaskManifest } from "../src/bootstrap/taskManifest.ts";
import { evaluateDiffScope } from "../src/bootstrap/diffGuard.ts";
import { canonicalHash, evaluateResultGate, hashArtifact, taskAuthorityHash, type Proof } from "../src/bootstrap/resultGate.ts";
import { validateHandoffSchema, writeHandoff } from "../src/bootstrap/handoffWriter.ts"; // FIX-3C: the CLI stamps through the validating writer, not resultGate's raw one
export { canonicalHash };

export interface Plan { exitCode: number; lines: string[] } export interface Observations { manifestText: string; parentHandoffText: string | null; headSha: string; porcelain: string }

export function executionPlan(manifest: TaskManifest): string[] {
  const { maxProductionFiles: p, maxTestFiles: t, maxChangedLines: l } = manifest.limits;
  return [`task=${manifest.taskId}`, `mode=${manifest.mode}`, `repo=${manifest.repoId}`, `base=${manifest.baseSha}`,
    `allow=${[...manifest.allowPaths].sort().join(",")}`, `deny=${[...manifest.denyPaths].sort().join(",")}`, `limits=${p}/${t}/${l}`,
    ...manifest.commands.map((command) => `command=${command.cwd} :: ${command.argv.join(" ")}`)];
}

/** FIX-2: the declared parent handoff as a pure check, so BOTH the plan path and the stamping path can verify it. Returns blockers ([] means valid; a manifest that declares no parent is valid). FIX-5: a parent whose `status` is not an accepted result (PASS or ALREADY_SATISFIED), or is absent, is a blocker — a failed or blocked unit may never be a base. */
export function validateParentHandoff(manifest: TaskManifest, parentHandoffText: string | null): string[] {
  if (manifest.parentHandoffHash === null) return [];
  if (parentHandoffText === null) return [`manifest declares parentHandoffHash ${manifest.parentHandoffHash} but no parent handoff was supplied`];
  let parent: Record<string, unknown>;
  try { parent = JSON.parse(parentHandoffText) as Record<string, unknown>; } catch { return ["parent handoff is not valid JSON"]; }
  const recomputed = canonicalHash(parent);
  if (parent.handoffHash !== recomputed) return [`stored hash ${String(parent.handoffHash)} != canonical ${recomputed}`];
  if (recomputed !== manifest.parentHandoffHash) return [`canonical hash ${recomputed} != manifest parentHandoffHash ${manifest.parentHandoffHash}`];
  if (parent.nextTaskId !== manifest.taskId) return [`parent nextTaskId ${String(parent.nextTaskId)} != ${manifest.taskId}`];
  if (typeof parent.nextBaseSha === "string" && parent.nextBaseSha !== manifest.baseSha) return [`parent nextBaseSha ${parent.nextBaseSha} != manifest baseSha ${manifest.baseSha}`];
  const status = String(parent.status); // FIX-5: a handoff records its unit's outcome; an absent status reports as "undefined" and is rejected the same way.
  if (status !== "PASS" && status !== "ALREADY_SATISFIED") return [`parent handoff ${String(parent.taskId)} reports status ${status}; only PASS or ALREADY_SATISFIED may be a base`];
  return [];
}

/** The `parent=<taskId> accepted <prefix>…` line; only meaningful once validateParentHandoff returned no blocker. FIX-5: it asserts acceptance, so it prints only for a parent whose status IS an accepted result. */
function parentAcceptance(manifest: TaskManifest, parentHandoffText: string | null): string[] {
  if (manifest.parentHandoffHash === null || parentHandoffText === null) return [];
  try { const parent = JSON.parse(parentHandoffText) as Record<string, unknown>; if (parent.status !== "PASS" && parent.status !== "ALREADY_SATISFIED") return []; return [`parent=${String(parent.taskId)} accepted ${canonicalHash(parent).slice(0, 18)}…`]; } catch { return []; }
}

/** FIX-3C: the pre-stamp schema gate, total by construction — an absent, unreadable or non-JSON schema, and an unreadable or non-JSON record, are blockers, never exceptions. A missing `--handoff-record` is left to the existing gate blocker. */
function preStampSchema(cwd: string, schemaPath: string | null, recordPath: string | null): { blockers: string[]; record: Record<string, unknown> | null } {
  const read = (kind: string, path: string): { value?: unknown; blocker?: string } => { let text: string; try { text = readFileSync(resolve(cwd, path), "utf8"); } catch (error) { return { blocker: `${kind} ${path} is unreadable (${(error as Error).message})` }; } try { return { value: JSON.parse(text) }; } catch (error) { return { blocker: `${kind} ${path} is not valid JSON (${(error as Error).message})` }; } };
  if (schemaPath === null) return { blockers: ["--emit-handoff requires --handoff-schema: the gate schema-validates the record before it stamps"], record: null };
  const schema = read("handoff schema", schemaPath); if (schema.blocker !== undefined) return { blockers: [schema.blocker], record: null };
  if (recordPath === null) return { blockers: [], record: null };
  const record = read("handoff record", recordPath); if (record.blocker !== undefined) return { blockers: [record.blocker], record: null };
  return { blockers: validateHandoffSchema(record.value as Record<string, unknown>, schema.value), record: record.value as Record<string, unknown> };
}

/** FIX-4A: derive the authority the manifest carries and check the record's claim against it — a record may not name (or invent) its own task authority. Total: an unparsed manifest or an absent/unreadable record leaves no claim to check, which the existing blockers already report. */
function taskAuthority(manifest: TaskManifest | null, record: Record<string, unknown> | null): { hash: string | null; blockers: string[] } {
  if (manifest === null || record === null) return { hash: null, blockers: [] };
  const hash = taskAuthorityHash(manifest); const claimed = record.taskAuthorityHash;
  return { hash, blockers: claimed === hash ? [] : [`$.taskAuthorityHash: the record says ${String(claimed)} but manifest ${manifest.taskId} derives ${hash}`] };
}

export function bootstrapOne(obs: Observations): Plan {
  let raw: unknown; try { raw = JSON.parse(obs.manifestText); } catch (error) { return { exitCode: 2, lines: [`REJECT manifest: not valid JSON (${(error as Error).message})`] }; }
  const parsed = parseTaskManifest(raw);
  if (!parsed.ok) return { exitCode: 2, lines: ["REJECT manifest: does not conform to the task manifest contract", ...parsed.errors.map((e) => `  ${e}`)] };
  const manifest = parsed.manifest;
  if (obs.headSha !== manifest.baseSha) return { exitCode: 3, lines: [`REJECT baseline: HEAD ${obs.headSha} != manifest baseSha ${manifest.baseSha}`] };
  if (obs.porcelain.trim() !== "") return { exitCode: 3, lines: ["REJECT baseline: worktree is not clean", ...obs.porcelain.trim().split("\n").map((line) => `  ${line}`)] };
  const [blocker] = validateParentHandoff(manifest, obs.parentHandoffText); if (blocker !== undefined) return { exitCode: 4, lines: [`REJECT handoff: ${blocker}`] };
  return { exitCode: 0, lines: [...parentAcceptance(manifest, obs.parentHandoffText), ...executionPlan(manifest)] };
}

if (process.argv[1]?.endsWith("bootstrap-one.ts")) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | null => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; };
  const cwd = opt("--cwd") ?? process.cwd(); const manifestPath = opt("--manifest");
  if (manifestPath === null) { console.log("usage: node scripts/bootstrap-one.ts --manifest <path> [--parent-handoff <path>] [--cwd <path>]"); process.exitCode = 64; }
  else try {
    const parentPath = opt("--parent-handoff");
    const parentText = parentPath === null ? null : readFileSync(resolve(cwd, parentPath), "utf8"); // FIX-2: read once, verified again at stamp time
    const git = (args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    const porcelain = git(["status", "--porcelain"]);
    const plan = bootstrapOne({ manifestText: readFileSync(resolve(cwd, manifestPath), "utf8"), parentHandoffText: parentText, headSha: git(["rev-parse", "HEAD"]).trim(), porcelain });
    for (const line of plan.lines) console.log(line);
    console.log(`plan exit=${plan.exitCode}; no model invoked (B04 stops here)`); process.exitCode = plan.exitCode;
    const outDir = opt("--emit-handoff"); const proofsPath = opt("--proofs"); const recordPath = opt("--handoff-record"); const schemaPath = opt("--handoff-schema");
    if (outDir !== null) {
      const parsed = parseTaskManifest(JSON.parse(readFileSync(resolve(cwd, manifestPath), "utf8")));
      const proofs = (proofsPath === null ? [] : JSON.parse(readFileSync(resolve(cwd, proofsPath), "utf8"))) as Proof[];
      // FIX-2: the parent chain is verified HERE, unconditionally and whatever plan.exitCode said — at stamp time HEAD != baseSha, so the plan's own check above is unreachable.
      const parentBlockers = parsed.ok ? validateParentHandoff(parsed.manifest, parentText) : [];
      if (parsed.ok && parentBlockers.length === 0 && plan.exitCode !== 0) for (const line of parentAcceptance(parsed.manifest, parentText)) console.log(line); // the plan already printed it when it validated
      const schema = preStampSchema(cwd, schemaPath, recordPath); // FIX-3C: validated HERE, before anything is written, whatever the gate's own verdict is
      const authority = taskAuthority(parsed.ok ? parsed.manifest : null, schema.record); // FIX-4A: the authority is DERIVED from the manifest here, never taken from the record
      const blockers = [...(plan.exitCode === 2 || plan.exitCode === 4 ? [`plan exited ${plan.exitCode}; no handoff written`] : porcelain.trim() !== "" ? ["worktree is not clean: the gate stamps only a committed, clean task commit"] : recordPath === null ? ["--emit-handoff requires --handoff-record: the tool stamps checksums, it never invents handoff content"] : parsed.ok === false ? parsed.errors : evaluateResultGate({ requiredCommands: parsed.manifest.commands.map((command) => command.argv.join(" ")), proofs, artifactSha256: Object.fromEntries(proofs.map((proof) => [proof.outputArtifact, hashArtifact(resolve(cwd, proof.outputArtifact))])), diff: evaluateDiffScope(parsed.manifest, { porcelain, numstat: git(["diff", "--numstat", "HEAD^1", "HEAD"]) }), commitParentSha: git(["rev-parse", "HEAD^1"]).trim(), approvedBaseSha: parsed.manifest.baseSha }).blockers), ...parentBlockers, ...schema.blockers, ...authority.blockers];
      if (blockers.length > 0) { for (const blocker of blockers) console.log(`REJECT gate: ${blocker}`); process.exitCode = porcelain.trim() !== "" ? 3 : parsed.ok === false ? 2 : 5; }
      else if (parsed.ok) { process.exitCode = 0; console.log(`authority=${parsed.manifest.taskId} ${authority.hash}`); console.log(`schema=${parsed.manifest.taskId} conforms ${schemaPath}`); const written = writeHandoff(outDir, parsed.manifest.taskId, schema.record as Record<string, unknown>); console.log(`handoff=${written.path} checksum=${written.handoffHash} gate=accepted (clean tree + proofs + diff scope + HEAD^1 == approved base; the plan baseline line above describes the pre-task state)`); }
    }
  } catch (error) { console.log(`REJECT input: ${(error as Error).message}`); process.exitCode = 66; }
}
