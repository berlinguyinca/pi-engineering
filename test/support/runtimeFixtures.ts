/**
 * Real runtime-generation source trees for host tests.
 *
 * Each fixture is an actual package directory (package.json, an entry module,
 * and a dependency module) that the Host snapshots and imports exactly like
 * the real runtime. Observations are written to a process-global bag keyed per
 * test. The Host and every generation run in this process, so the test can see
 * what each generation actually did.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FixtureMode = "ok" | "throw-start" | "unhealthy" | "throw-create";

export interface FixtureOptions {
  /** Exported from dep.ts and observed by the generation; proves which code ran. */
  value: string;
  mode?: FixtureMode;
  version?: string;
  runtimeApi?: number;
  /** Extra `piEngineering` metadata in package.json. */
  metadata?: Record<string, unknown>;
}

export interface FixtureBag {
  reactions: number;
  values: string[];
  starts: number;
  stops: number;
  ticks: number;
  stale: number;
  generations: number[];
  restored: unknown[];
  missions: string[];
  lateFences: number;
  /** When set, stop() waits for it: holds a handover mid-flight. */
  stopGate?: Promise<void>;
}

export function bag(key: string): FixtureBag {
  const g = globalThis as Record<string, unknown>;
  g[key] ??= {
    reactions: 0,
    values: [],
    starts: 0,
    stops: 0,
    ticks: 0,
    stale: 0,
    generations: [],
    restored: [],
    missions: [],
    lateFences: 0,
  } satisfies FixtureBag;
  return g[key] as FixtureBag;
}

/** Write (or overwrite) a fixture runtime package at `dir`. */
export function writeFixtureRuntime(dir: string, key: string, opts: FixtureOptions): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-runtime",
        version: opts.version ?? "0.0.1",
        type: "module",
        piEngineering: { runtimeApi: opts.runtimeApi ?? 1, entry: "runtime.ts", ...(opts.metadata ?? {}) },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "dep.ts"), `export const VALUE: string = ${JSON.stringify(opts.value)};\n`);
  const mode = opts.mode ?? "ok";
  writeFileSync(
    join(dir, "runtime.ts"),
    `import { VALUE } from "./dep.ts";
const KEY = ${JSON.stringify(key)};
const MODE = ${JSON.stringify(mode)};
export const runtimeApi = ${opts.runtimeApi ?? 1};
export const value = VALUE;

function bag(): any {
  return (globalThis as any)[KEY];
}

export async function createRuntime(ctx: any) {
  if (MODE === "throw-create") throw new Error("candidate createRuntime failed");
  const b = bag();
  b.generations.push(ctx.generation);
  if (ctx.restore) b.restored.push(ctx.restore);
  return {
    async start() {
      ctx.pi.on("agent_settled", () => {
        if (!ctx.isActive()) b.stale++;
        b.reactions++;
        b.values.push(VALUE);
      });
      ctx.pi.on("session_start", () => b.values.push("session_start:" + VALUE));
      ctx.pi.registerCommand("probe", {
        description: "fixture probe " + VALUE,
        handler: async () => {
          b.values.push("cmd:" + VALUE);
        },
      });
      ctx.resources.setInterval(() => b.ticks++, 60_000);
      // A late timer: after a handover it must not run, or must be fenced.
      ctx.resources.setTimeout(() => {
        if (!ctx.isActive()) b.lateFences++;
      }, 60_000);
      if (ctx.session.active()) await ctx.session.replay("session_start", { type: "session_start", reason: "reload" });
      b.starts++;
      if (MODE === "throw-start") throw new Error("candidate start() failed");
    },
    async quiesce() {},
    async waitForSafePoint() {
      return { reached: true, waitedMs: 0 };
    },
    async snapshot() {
      return {
        generation: ctx.generation,
        activeMissionIds: [...b.missions],
        pendingMissionIds: [],
        createdAt: new Date().toISOString(),
      };
    },
    async stop() {
      b.stops++;
      if (b.stopGate) await b.stopGate;
    },
    async health() {
      return { healthy: MODE !== "unhealthy", checks: [{ name: "fixture", ok: MODE !== "unhealthy" }] };
    },
  };
}
`,
  );
}
