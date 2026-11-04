#!/usr/bin/env node
/**
 * B04: single-task bootstrap CLI wrapper. Loads ONE task manifest, verifies the clean baseline commit,
 * validates the declared parent handoff, prints a deterministic execution plan and STOPS — no model call
 * and no scheduler/orchestration/planner import (asserted by the unit test). Read-only: it reads files and
 * asks git only for HEAD and porcelain status. Exit codes: 0 plan, 2 manifest invalid, 3 baseline rejected, 4 handoff rejected, 5 gate rejected, 64 usage, 66 unreadable input.
 * Usage: node scripts/bootstrap-one.ts --manifest <path> [--parent-handoff <path>] [--cwd <path>] [--proofs <path>] [--handoff-record <path>] [--emit-handoff <dir>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTaskManifest, type TaskManifest } from "../src/bootstrap/taskManifest.ts";
import { evaluateDiffScope } from "../src/bootstrap/diffGuard.ts";
import { canonicalHash, evaluateResultGate, hashArtifact, writeHandoff, type Proof } from "../src/bootstrap/resultGate.ts";
export { canonicalHash };

export interface Plan { exitCode: number; lines: string[] } export interface Observations { manifestText: string; parentHandoffText: string | null; headSha: string; porcelain: string }

export function executionPlan(manifest: TaskManifest): string[] {
  const { maxProductionFiles: p, maxTestFiles: t, maxChangedLines: l } = manifest.limits;
  return [`task=${manifest.taskId}`, `mode=${manifest.mode}`, `repo=${manifest.repoId}`, `base=${manifest.baseSha}`,
    `allow=${[...manifest.allowPaths].sort().join(",")}`, `deny=${[...manifest.denyPaths].sort().join(",")}`, `limits=${p}/${t}/${l}`,
    ...manifest.commands.map((command) => `command=${command.cwd} :: ${command.argv.join(" ")}`)];
}

export function bootstrapOne(obs: Observations): Plan {
  let raw: unknown; try { raw = JSON.parse(obs.manifestText); } catch (error) { return { exitCode: 2, lines: [`REJECT manifest: not valid JSON (${(error as Error).message})`] }; }
  const parsed = parseTaskManifest(raw);
  if (!parsed.ok) return { exitCode: 2, lines: ["REJECT manifest: does not conform to the task manifest contract", ...parsed.errors.map((e) => `  ${e}`)] };
  const manifest = parsed.manifest;
  if (obs.headSha !== manifest.baseSha) return { exitCode: 3, lines: [`REJECT baseline: HEAD ${obs.headSha} != manifest baseSha ${manifest.baseSha}`] };
  if (obs.porcelain.trim() !== "") return { exitCode: 3, lines: ["REJECT baseline: worktree is not clean", ...obs.porcelain.trim().split("\n").map((line) => `  ${line}`)] };
  const reject = (reason: string): Plan => ({ exitCode: 4, lines: [`REJECT handoff: ${reason}`] }); const accepted: string[] = [];
  if (manifest.parentHandoffHash !== null) {
    if (obs.parentHandoffText === null) return reject(`manifest declares parentHandoffHash ${manifest.parentHandoffHash} but no parent handoff was supplied`);
    let parent: Record<string, unknown>;
    try { parent = JSON.parse(obs.parentHandoffText) as Record<string, unknown>; } catch { return reject("parent handoff is not valid JSON"); }
    const recomputed = canonicalHash(parent);
    if (parent.handoffHash !== recomputed) return reject(`stored hash ${String(parent.handoffHash)} != canonical ${recomputed}`);
    if (recomputed !== manifest.parentHandoffHash) return reject(`canonical hash ${recomputed} != manifest parentHandoffHash ${manifest.parentHandoffHash}`);
    if (parent.nextTaskId !== manifest.taskId) return reject(`parent nextTaskId ${String(parent.nextTaskId)} != ${manifest.taskId}`);
    if (typeof parent.nextBaseSha === "string" && parent.nextBaseSha !== manifest.baseSha) return reject(`parent nextBaseSha ${parent.nextBaseSha} != manifest baseSha ${manifest.baseSha}`);
    accepted.push(`parent=${String(parent.taskId)} accepted ${recomputed.slice(0, 18)}…`);
  }
  return { exitCode: 0, lines: [...accepted, ...executionPlan(manifest)] };
}

if (process.argv[1]?.endsWith("bootstrap-one.ts")) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | null => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; };
  const cwd = opt("--cwd") ?? process.cwd(); const manifestPath = opt("--manifest");
  if (manifestPath === null) { console.log("usage: node scripts/bootstrap-one.ts --manifest <path> [--parent-handoff <path>] [--cwd <path>]"); process.exitCode = 64; }
  else try {
    const parentPath = opt("--parent-handoff");
    const git = (args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    const porcelain = git(["status", "--porcelain"]);
    const plan = bootstrapOne({ manifestText: readFileSync(resolve(cwd, manifestPath), "utf8"), parentHandoffText: parentPath === null ? null : readFileSync(resolve(cwd, parentPath), "utf8"), headSha: git(["rev-parse", "HEAD"]).trim(), porcelain });
    for (const line of plan.lines) console.log(line);
    console.log(`plan exit=${plan.exitCode}; no model invoked (B04 stops here)`); process.exitCode = plan.exitCode;
    const outDir = opt("--emit-handoff"); const proofsPath = opt("--proofs"); const recordPath = opt("--handoff-record");
    if (outDir !== null) {
      const parsed = parseTaskManifest(JSON.parse(readFileSync(resolve(cwd, manifestPath), "utf8")));
      const proofs = (proofsPath === null ? [] : JSON.parse(readFileSync(resolve(cwd, proofsPath), "utf8"))) as Proof[];
      const blockers = plan.exitCode === 2 || plan.exitCode === 4 ? [`plan exited ${plan.exitCode}; no handoff written`] : porcelain.trim() !== "" ? ["worktree is not clean: the gate stamps only a committed, clean task commit"] : recordPath === null ? ["--emit-handoff requires --handoff-record: the tool stamps checksums, it never invents handoff content"] : parsed.ok === false ? parsed.errors : evaluateResultGate({ requiredCommands: parsed.manifest.commands.map((command) => command.argv.join(" ")), proofs, artifactSha256: Object.fromEntries(proofs.map((proof) => [proof.outputArtifact, hashArtifact(resolve(cwd, proof.outputArtifact))])), diff: evaluateDiffScope(parsed.manifest, { porcelain, numstat: git(["diff", "--numstat", "HEAD^1", "HEAD"]) }), commitParentSha: git(["rev-parse", "HEAD^1"]).trim(), approvedBaseSha: parsed.manifest.baseSha }).blockers;
      if (blockers.length > 0) { for (const blocker of blockers) console.log(`REJECT gate: ${blocker}`); process.exitCode = porcelain.trim() !== "" ? 3 : parsed.ok === false ? 2 : 5; }
      else if (parsed.ok) { process.exitCode = 0; const written = writeHandoff(outDir, parsed.manifest.taskId, JSON.parse(readFileSync(resolve(cwd, recordPath!), "utf8")) as Record<string, unknown>); console.log(`handoff=${written.path} checksum=${written.handoffHash} gate=accepted (clean tree + proofs + diff scope + HEAD^1 == approved base; the plan baseline line above describes the pre-task state)`); }
    }
  } catch (error) { console.log(`REJECT input: ${(error as Error).message}`); process.exitCode = 66; }
}
