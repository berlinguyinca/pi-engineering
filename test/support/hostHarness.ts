/**
 * Shared setup for update/rollback/crash tests: a real Pi session running the
 * Host over a temp install root, plus installed fixture versions.
 */

import { join } from "node:path";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { type InstallLayout, versionId } from "../../src/update/installLayout.ts";
import type { UpdateJournalRecord } from "../../src/update/journal.ts";
import { type PiTestSession, startPiSession } from "./piSession.ts";
import { type FixtureOptions, writeFixtureRuntime } from "./runtimeFixtures.ts";

let installSeq = 0;

export async function installFixtureVersion(
  layout: InstallLayout,
  key: string,
  opts: FixtureOptions & { version: string; commit?: string },
): Promise<string> {
  const commit = opts.commit ?? `${opts.value.toLowerCase().replace(/[^a-z0-9]/g, "0")}${"0".repeat(40)}`.slice(0, 40);
  const id = versionId(opts.version, commit);
  const dir = layout.versionDir(id);
  writeFixtureRuntime(dir, key, opts);
  await layout.writeMeta(dir, {
    id,
    version: opts.version,
    commit,
    channel: "main",
    source: "test",
    installedAt: new Date(Date.UTC(2026, 0, 1) + ++installSeq * 1000).toISOString(),
    runtimeApi: opts.runtimeApi ?? 1,
    ...(opts.stateSchema ? { stateSchema: opts.stateSchema } : {}),
  });
  return dir;
}

export interface HostSession {
  ext: EngineeringHostExtension;
  pi: PiTestSession;
  host: NonNullable<EngineeringHostExtension["host"]>;
}

export async function hostSession(opts: {
  installRoot: string;
  packageRoot: string;
  cwd?: string;
}): Promise<HostSession> {
  const ext = new EngineeringHostExtension({
    installRoot: opts.installRoot,
    packageRoot: opts.packageRoot,
    entry: "runtime.ts",
    baseline: false,
    autoUpdateCheck: false,
  });
  const pi = await startPiSession({
    factories: [(api: never) => ext.install(api)],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  return { ext, pi, host: ext.host as NonNullable<EngineeringHostExtension["host"]> };
}

/** A journal record for a transaction from whatever runs now to `candidateDir`. */
export function beginRecord(
  ext: EngineeringHostExtension,
  kind: "update" | "rollback",
  candidateDir: string,
  transaction = `${kind}-${Date.now().toString(36)}`,
): UpdateJournalRecord {
  const active = ext.host?.activeGeneration();
  const meta = ext.layout.readMeta(candidateDir);
  return ext.journal.begin({
    transaction,
    kind,
    channel: "main",
    fromVersion: active?.source.version ?? null,
    fromCommit: active?.source.commit ?? null,
    toVersion: meta?.version ?? null,
    toCommit: meta?.commit ?? null,
    previousRuntime: active?.source.root ?? null,
    candidateRuntime: candidateDir,
    pointers: { current: ext.layout.readPointer("current"), previous: ext.layout.readPointer("previous") },
    phase: "validating",
  });
}

export function stateDirOf(cwd: string): string {
  return join(cwd, ".pi-eng");
}
