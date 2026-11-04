#!/usr/bin/env node
/**
 * B04: single-task bootstrap CLI wrapper. Loads ONE task manifest, verifies the clean baseline commit,
 * validates the declared parent handoff, prints a deterministic execution plan and STOPS — no model call
 * and no scheduler/orchestration/planner import (asserted by the unit test). Read-only: it reads files and
 * asks git only for HEAD and porcelain status. Exit codes: 0 plan, 2 manifest invalid, 3 baseline rejected,
 * 4 handoff rejected, 64 usage, 66 unreadable input.
 * Usage: node scripts/bootstrap-one.ts --manifest <path> [--parent-handoff <path>] [--cwd <path>]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTaskManifest, type TaskManifest } from "../src/bootstrap/taskManifest.ts";

export interface Plan { exitCode: number; lines: string[] } export interface Observations { manifestText: string; parentHandoffText: string | null; headSha: string; porcelain: string }

/** Same canonicalization as the handoff protocol: sorted keys at every level, compact JSON, UTF-8, `handoffHash` excluded. */
export function canonicalHash(record: unknown): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])])) : value;
  const clone = { ...(record as Record<string, unknown>) }; delete clone.handoffHash;
  return `sha256:${createHash("sha256").update(JSON.stringify(sort(clone)), "utf8").digest("hex")}`;
}

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
    const plan = bootstrapOne({ manifestText: readFileSync(resolve(cwd, manifestPath), "utf8"), parentHandoffText: parentPath === null ? null : readFileSync(resolve(cwd, parentPath), "utf8"), headSha: git(["rev-parse", "HEAD"]).trim(), porcelain: git(["status", "--porcelain"]) });
    for (const line of plan.lines) console.log(line);
    console.log(`plan exit=${plan.exitCode}; no model invoked (B04 stops here)`); process.exitCode = plan.exitCode;
  } catch (error) { console.log(`REJECT input: ${(error as Error).message}`); process.exitCode = 66; }
}
