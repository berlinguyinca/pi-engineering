/**
 * Child process for crash tests (spec §53). Not a test file: the crash tests
 * spawn it with a real Node process and kill it with SIGKILL.
 *
 *   transact <json>  start Pi with the Host, run a journaled activation, and at
 *                    the requested phase print CRASH_POINT and hang so the
 *                    parent can SIGKILL the process exactly there.
 *   start <json>     start Pi with the Host (crash recovery runs during
 *                    install), then print what was recovered and what runs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readStateSchema } from "../../src/runtime/migrations/schema.ts";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { candidateMigrations, runActivation } from "../../src/update/transaction.ts";
import { beginRecord, hostSession } from "./hostHarness.ts";
import { bag } from "./runtimeFixtures.ts";

interface Config {
  key: string;
  installRoot: string;
  packageRoot: string;
  cwd: string;
  candidateDir?: string;
  crashAt?: string;
}

const [mode, raw] = process.argv.slice(2);
const config = JSON.parse(raw ?? "{}") as Config;
bag(config.key);
const layout = new InstallLayout(config.installRoot);
const state = join(config.cwd, ".pi-eng");

if (mode === "transact") {
  const s = await hostSession({ installRoot: config.installRoot, packageRoot: config.packageRoot, cwd: config.cwd });
  const candidate = config.candidateDir as string;
  const plan = [...(await candidateMigrations(candidate))];
  const record = beginRecord(s.ext, "update", candidate, "update-crash");
  const tx = await runActivation({
    host: s.ext,
    journal: s.ext.journal,
    record,
    candidateDir: candidate,
    kind: "update",
    stateDir: state,
    migration: { plan, from: 7, to: 8 },
    onPhase: async (phase) => {
      if (phase === config.crashAt) {
        process.stdout.write(`CRASH_POINT ${phase}\n`);
        await new Promise(() => {});
      }
    },
  });
  await tx.done;
  process.stdout.write("TRANSACTION_FINISHED\n");
  await s.pi.close();
  process.exit(0);
}

if (mode === "start") {
  const s = await hostSession({ installRoot: config.installRoot, packageRoot: config.packageRoot, cwd: config.cwd });
  const active = s.host.activeGeneration();
  const health = await s.host.health();
  const journal = s.ext.journal.read();
  let missions: string | null = null;
  try {
    missions = readFileSync(join(state, "missions.json"), "utf8");
  } catch {
    missions = null;
  }
  process.stdout.write(
    `RESULT ${JSON.stringify({
      recovery: s.ext.recovery,
      active: active ? { root: active.source.root, label: active.source.label } : null,
      healthy: health.healthy,
      journalPhase: journal && journal !== "corrupt" ? journal.phase : journal,
      current: layout.readPointer("current"),
      previous: layout.readPointer("previous"),
      schema: readStateSchema(state),
      missions,
      lockHeld: s.ext.lock.isHeldByLiveProcess(),
    })}\n`,
  );
  await s.pi.close();
  process.exit(0);
}

process.stderr.write(`unknown mode ${mode}\n`);
process.exit(2);
