/**
 * `pi-engineering github sync --store <dir> [--mission <id>]`: one {@link githubSync} tick over a store.
 *
 * Everything comes from the GLOBAL engineering.yaml: the `github:` block turns the layer on, the `herdr:` block (with
 * `lineage: true`) says where to project. Neither block, nothing happens (no `gh`, no network). The Herdr key is read
 * from its 0600 file and sent only as a header; it never reaches argv, stdout or an error.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadPlanCliLineage } from "../orchestration/missionLineage.ts";
import { MissionStore } from "../orchestration/missionStore.ts";
import { JsonlEventStore } from "../platform/eventstore/jsonl.ts";
import { loadHerdrConnection } from "../runtime/herdr/herdrConnection.ts";
import { type GithubClient, createGithubClient, refConfigOf } from "./client.ts";
import { type QuorumReader, createHerdrQuorumReader } from "./quorum.ts";
import { loadGithubSettings } from "./settings.ts";
import { githubSync } from "./sync.ts";

export interface GithubSyncCliDeps {
  client?: GithubClient | null;
  quorum?: QuorumReader | null;
  run?: (argv: string[]) => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  lineageDir?: string;
}

const USAGE = "usage: pi-engineering github sync --store <dir> [--mission <id>]\n";

export async function runGithubSyncCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { out(text: string): void; err(text: string): void } = {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
  },
  deps: GithubSyncCliDeps = {},
): Promise<number> {
  if (args[0] !== "sync") {
    io.err(USAGE);
    return 2;
  }
  let store: string | undefined;
  let mission: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--store") store = args[++i];
    else if (args[i] === "--mission") mission = args[++i];
    else {
      io.err(USAGE);
      return 2;
    }
  }
  if (!store) {
    io.err(USAGE);
    return 2;
  }
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  const { settings, notes } = await loadGithubSettings(agentDir);
  for (const n of notes) io.err(`${n}\n`);
  if (!settings && deps.client === undefined) {
    io.out(`${JSON.stringify({ result: "disabled" })}\n`);
    return 0;
  }
  const dir = resolve(store);
  await mkdir(dir, { recursive: true });
  const backend = await JsonlEventStore.open(join(dir, "orchestration.jsonl"));
  const missions = MissionStore.open(backend);
  const lineage = await loadPlanCliLineage(env, {
    ...(deps.lineageDir ? { lineageDir: deps.lineageDir } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const { connection } = await loadHerdrConnection(agentDir);
  const quorum =
    deps.quorum !== undefined
      ? deps.quorum
      : connection?.apiKey
        ? createHerdrQuorumReader(connection, deps.fetch ?? globalThis.fetch)
        : null;
  const client = deps.client !== undefined ? deps.client : createGithubClient(settings?.config);
  try {
    const report = await githubSync({
      client,
      store: missions,
      cfg: refConfigOf(settings?.config),
      lineage,
      ...(mission ? { missionId: mission } : {}),
      ...(settings?.requiredChecks.length ? { requiredChecks: settings.requiredChecks } : {}),
      ...(settings?.rereviewCommand.length ? { rereviewCommand: settings.rereviewCommand } : {}),
      quorum,
      ...(deps.run ? { run: deps.run } : {}),
    });
    await missions.flush();
    await lineage?.idle();
    io.out(
      `${JSON.stringify({
        result: report.status,
        corrections: report.reconcile?.corrections.length ?? 0,
        staleSignals: report.reconcile?.staleSignals.length ?? 0,
        rereviews: report.rereviews.map((r) => ({
          signalId: r.signalId,
          target: r.target,
          head: r.headSha,
          dispatch: r.dispatch,
        })),
        ciPrs: report.ciPrs,
        dependencyEdges: report.dependencyEdges,
        gates: report.gates,
      })}\n`,
    );
    return 0;
  } finally {
    await lineage?.idle().catch(() => undefined);
  }
}
