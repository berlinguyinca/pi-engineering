/**
 * Legacy golden outputs and the parity gate (OMP unification, Phase 3).
 *
 * Every scenario drives the CURRENT implementation (the "legacy path") through
 * its real entry points with deterministic collaborators (FakeWorkerExecutor,
 * the BrokerBackends harness, a real CommandVerifier over real git fixture
 * repos, real ledger files) and reduces the result to a normalized record
 * (see ledgerNormalizer.ts). The records live under
 * test/fixtures/legacy-golden/ and are compared byte for byte.
 *
 * Parity gate: the scenario table below takes a {@link ParityPath}. A future
 * OMP-backed path implements the same factories and observation hooks and runs
 * the SAME table against the SAME golden files (select it with PARITY_PATH, see
 * {@link resolvePath} / {@link runParity}); equivalence is decided by byte
 * comparison only. Scenarios reach the implementation ONLY through the path. See docs/specs/omp-unification-2026-11-13/reports/phase3-legacy-golden.md.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import extension from "../../extensions/index.ts";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import type { Ledger } from "../../src/ledger/Ledger.ts";
import { selectOmpWorker } from "../../src/omp/selectWorker.ts";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator, type OrchestratorOptions } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier, type VerifyOutcome } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import {
  type JsonValue,
  type Normalizer,
  type RawEvent,
  createNormalizer,
  normalizeEvents,
  parseLedger,
  stableStringify,
} from "./ledgerNormalizer.ts";
import {
  type EngineerScript,
  engineerModelScript,
  offlineEnv,
  realOmpEnv,
  startOfflineOmp,
  writeOfflineHome,
} from "./ompOffline.ts";

const exec = promisify(execFile);

/**
 * The commit of the legacy implementation the goldens were captured from. It is the
 * baseline every path is compared against, so the stamped field is path-neutral.
 */
export const GOLDEN_BASELINE_SHA = "24a66588e93b3ad9cb3a65f0b71b3fb6d5f61736";

export interface OpenOptions {
  cwd: string;
  worker: WorkerExecutor;
  /**
   * Declarative stand-in for `worker`, for paths that drive a real model process
   * (the omp path). The legacy path ignores it and uses `worker`.
   */
  script?: EngineerScript;
}

/** The ledger operations the scenarios use; the legacy path hands out the runtime's own ledger. */
export type LedgerAccess = Pick<
  Ledger,
  "listCandidates" | "listEntities" | "listTasks" | "getWorkItem" | "count" | "createWorkItem" | "createCandidate"
>;

/** The mission-store reads the scenarios use. */
export type MissionView = Pick<
  MissionStore,
  "getMission" | "listTasks" | "listFindings" | "listRecoveryDecisions" | "flush"
>;

export type MissionOptions = Omit<OrchestratorOptions, "store">;

/** One mission store plus the orchestrator driving it and the event log behind it. */
export interface MissionSession {
  orchestrator: Orchestrator;
  store: MissionView;
  /** Every mission event recorded so far, in order. */
  events(): RawEvent[];
  /** A fresh store and orchestrator reopened over the same recorded events (a process restart). */
  restart(): { orchestrator: Orchestrator; store: MissionView };
}

/**
 * The implementation under test. The legacy path is the default; another path
 * supplies its own factories and observation hooks and nothing else changes: the
 * scenarios never reach into ledger files or stores themselves.
 */
export interface ParityPath {
  readonly name: string;
  openRuntime(opts: OpenOptions): Promise<EngineeringRuntime>;
  /** The ledger of an open runtime. */
  ledgerOf(rt: EngineeringRuntime): LedgerAccess;
  /** The recorded ledger events of the repository at `root`, in order (empty when nothing was recorded). */
  readEvents(root: string, opts?: { tornLinesExpected?: boolean }): Promise<RawEvent[]>;
  /** Simulate a crash mid-append: leave an unterminated, unparseable fragment at the end of the repository's ledger. */
  tearLedgerTail(root: string): Promise<void>;
  /** Detect the verification profile for the runtime's repository and run it. */
  verify(
    rt: EngineeringRuntime,
  ): Promise<{ profile: { name: string; stages: Array<{ name: string; required: boolean }> }; outcome: VerifyOutcome }>;
  /** A mission store (over a fresh in-memory event log) with an orchestrator built on it. */
  openMission(opts: MissionOptions): MissionSession;
  /** Register the slash commands on a pi host and return them with a way to shut the host down. */
  loadCommandHost(): CommandHost;
  /** A reason this path cannot run `s` (the test is then skipped and the reason printed), or false. */
  skipReason?(s: Pick<Scenario, "command" | "scenario">): string | false;
  /**
   * Explicit, printed exemptions from "this path runs the scenario end to end": `command / scenario` mapped to the
   * justification. An exemption never loosens the byte comparison; it states what the run does NOT exercise.
   */
  readonly exemptions?: Readonly<Record<string, string>>;
}

type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

export interface CommandHost {
  commands: Map<string, { handler: CommandHandler }>;
  shutdown(ctx: unknown): Promise<void>;
}

/** The same minimal pi host the extension tests use: it records commands and ignores UI registrations. */
function legacyCommandHost(): CommandHost {
  const commands = new Map<string, { handler: CommandHandler }>();
  const handlers = new Map<string, EventHandler[]>();
  const pi = {
    on: (name: string, handler: EventHandler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options),
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  };
  (extension as unknown as (api: unknown) => void)(pi);
  return {
    commands,
    shutdown: async (ctx) => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    },
  };
}

const ledgerFile = (root: string): string => join(root, ".pi-eng", "ledger.jsonl");

function legacyMissionSession(backend: JsonlEventStore, opts: MissionOptions): MissionSession {
  const store = MissionStore.open(backend);
  return {
    orchestrator: new Orchestrator({ ...opts, store }),
    store,
    events: () => backend.all() as unknown as RawEvent[],
    restart: () => {
      const restored = MissionStore.open(backend);
      return {
        store: restored,
        orchestrator: new Orchestrator({ store: restored, backends: {}, planner: async () => [] }),
      };
    },
  };
}

export const legacyPath: ParityPath = {
  name: "legacy",
  openRuntime: (opts) => EngineeringRuntime.open({ ...opts, verifier: new CommandVerifier() }),
  ledgerOf: (rt) => rt.ledger,
  readEvents: async (root, opts) => {
    // A runtime that recorded nothing has no ledger file yet: that is an empty sequence, not an error.
    const body = await readFile(ledgerFile(root), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    return parseLedger(body, opts);
  },
  tearLedgerTail: (root) => appendFile(ledgerFile(root), '{"event_id":"torn', "utf8"),
  verify: async (rt) => {
    const profile = await rt.verifier.detect(rt.cwd);
    const outcome = await rt.verifier.run(rt.cwd, profile, rt.artifacts);
    return { profile, outcome };
  },
  openMission: (opts) => legacyMissionSession(JsonlEventStore.inMemory(), opts),
  loadCommandHost: legacyCommandHost,
};

/**
 * The OMP-backed path. Every worker role (scout, planner, implementer, reviewer) runs on a REAL omp
 * process (`PI_ENGINEERING_OMP_WORKER=1`) talking to a local scripted OpenAI-compatible model with an
 * isolated HOME; the scenario's `script` is the declarative stand-in for the FakeWorkerExecutor handlers.
 * The ledger, verifier and orchestrator are the shared implementation, so the same table and the same
 * goldens decide equivalence. Scenarios that never reach a worker (verify, cmd-*, mission) open the runtime
 * under the same flags to prove the flag does not disturb them.
 */
export const ompPath: ParityPath = {
  ...legacyPath,
  name: "omp",
  openRuntime: async (opts) => {
    const offline = await startOfflineOmp(engineerModelScript(opts.script ?? {}));
    try {
      const picked = await selectOmpWorker(
        () => ({
          run: async () => {
            throw new Error("omp parity: the legacy fallback must never run");
          },
        }),
        offline.env,
      );
      if (picked?.selection.path !== "omp") {
        throw new Error(`omp path not selected: ${JSON.stringify(picked?.selection)}`);
      }
      const rt = await EngineeringRuntime.open({
        cwd: opts.cwd,
        worker: picked.executor,
        verifier: new CommandVerifier(),
      });
      const close = rt.close.bind(rt);
      rt.close = async () => {
        await close();
        await offline.close();
      };
      return rt;
    } catch (error) {
      await offline.close();
      throw error;
    }
  },
  loadCommandHost: () => {
    // The extension opens its runtime itself, so the production selection reads process.env: set the flags for
    // the host's lifetime (an isolated HOME, no model server: these commands never call a model).
    const real = realOmpEnv();
    if (!real) return legacyCommandHost();
    const home = mkdtempSync(join(tmpdir(), "pe-omp-cmd-home-"));
    writeOfflineHome(home, "http://127.0.0.1:9");
    const env = offlineEnv(home, real);
    const keys = Object.keys(env).filter((k) => env[k] !== process.env[k]);
    const before = new Map(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) process.env[k] = env[k];
    const host = legacyCommandHost();
    return {
      commands: host.commands,
      shutdown: async (ctx) => {
        try {
          await host.shutdown(ctx);
        } finally {
          for (const [k, v] of before) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
          rmSync(home, { recursive: true, force: true });
        }
      },
    };
  },
  skipReason: () => (realOmpEnv() ? false : "UNVERIFIED: OMP_BIN not set"),
  exemptions: Object.fromEntries([
    ...[
      "complete",
      "findings-repair-blocked",
      "validation-fail-then-pass",
      "block-then-resume",
      "restart-restores-state",
    ].map((name) => [
      `mission / ${name}`,
      "pass-through: the mission goldens drive the orchestrator with stub BrokerBackends that never reach a WorkerExecutor, so no omp process runs a worker; the production worker path (realBackends -> rt.worker) is covered by test/integration/omp-mission-backends.test.ts",
    ]),
    ...["green", "red"].map((name) => [
      `verify / ${name}`,
      "pass-through: the verifier runs real commands; no worker is involved, the runtime is opened under the omp flags to prove they do not disturb it",
    ]),
    ["plan / unknown-plan", "pass-through: fails before any worker runs"],
    ["cmd-review / no-work-item", "pass-through: the command stops before any worker runs"],
    ["cmd-review / no-candidate", "pass-through: the command stops before any worker runs"],
    ["cmd-execute / unknown-plan", "pass-through: the command stops before any worker runs"],
    ["cmd-engineer / missing-goal", "pass-through: the command stops before any worker runs"],
  ]),
};

/** Paths selectable with PARITY_PATH. Another implementation registers itself here. */
export const PATHS: Readonly<Record<string, ParityPath>> = { legacy: legacyPath, omp: ompPath };

/** Resolve the path named by PARITY_PATH (unset or empty means legacy); an unknown name fails loudly. */
export function resolvePath(name: string | undefined): ParityPath {
  const key = name === undefined || name === "" ? "legacy" : name;
  const path = PATHS[key];
  if (!path) throw new Error(`unknown PARITY_PATH "${key}"; known paths: ${Object.keys(PATHS).join(", ")}`);
  return path;
}

export interface Scenario {
  command: string;
  scenario: string;
  /** Returns the scenario-specific part of the record. `norm` is shared across the whole record. */
  run(path: ParityPath, norm: Normalizer, roots: string[]): Promise<Record<string, JsonValue>>;
}

export interface GoldenRecord {
  command: string;
  scenario: string;
  goldenBaselineSha: string;
  [key: string]: JsonValue;
}

export function goldenName(s: Pick<Scenario, "command" | "scenario">): string {
  return `${s.command}-${s.scenario}.golden.json`;
}

/** Run one scenario and return its record as stable JSON text. */
export async function renderScenario(s: Scenario, path: ParityPath): Promise<string> {
  const roots = [await realpath(tmpdir())];
  const norm = createNormalizer(roots);
  const body = await s.run(path, norm, roots);
  // goldenBaselineSha is stamped after normalization: it is a 40-hex SHA by design and must not become <SHA>.
  const record: GoldenRecord = {
    ...(norm.value({ command: s.command, scenario: s.scenario, ...body }) as Record<string, JsonValue>),
    goldenBaselineSha: GOLDEN_BASELINE_SHA,
  } as GoldenRecord;
  return stableStringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))));
}

// ------------------------------------------------------------------ helpers

type Fixture = Awaited<ReturnType<typeof makeFixtureRepo>>;

const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";
const ADD_BAD = "export function add(a, b) {\n  return a - b;\n}\n";

async function withFixture<T>(
  norm: Normalizer,
  opts: { green?: boolean },
  fn: (fx: Fixture) => Promise<T>,
): Promise<T> {
  const fx = await makeFixtureRepo();
  try {
    norm.addRoot(fx.root);
    norm.addRoot(await realpath(fx.root));
    if (opts.green) {
      await writeFile(join(fx.root, "src", "add.js"), ADD_OK, "utf8");
      await exec("git", ["-C", fx.root, "add", "-A"]);
      await exec("git", ["-C", fx.root, "commit", "-q", "-m", "green baseline"]);
    }
    return await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

const scoutOk = () => ({ status: "completed" as const, summary: "scouted", details: {} });
const implement = (content: string | ((n: number) => string)) => {
  let n = 0;
  return async (req: { cwd: string }) => {
    n += 1;
    await writeFile(join(req.cwd, "src", "add.js"), typeof content === "string" ? content : content(n), "utf8");
    return { status: "completed" as const, summary: "implemented", details: {} };
  };
};
const reviewWith = (findingsFor: (n: number) => unknown[]) => {
  let n = 0;
  return () => {
    n += 1;
    const findings = findingsFor(n);
    return {
      status: "completed" as const,
      summary: findings.length ? "material findings" : "clean",
      details: { findings },
    };
  };
};
const HIGH = [{ severity: "high", claim: "edge case not handled", evidence: "diff://src/add.js" }];

async function eventSequence(path: ParityPath, root: string, norm: Normalizer): Promise<JsonValue> {
  return normalizeEvents(await path.readEvents(root), norm) as unknown as JsonValue;
}

function candidateSummary(ledger: LedgerAccess, norm: Normalizer): JsonValue {
  const all = ledger.listCandidates();
  return all.map((c) => ({
    id: norm.text(c.id),
    status: c.status,
    parent: c.parent_id ? norm.text(c.parent_id) : null,
    changed_files: [...(c.changed_files ?? [])].sort(),
    evidence: c.evidence_ids.length,
  }));
}

function verificationSummary(
  v: {
    passed: boolean;
    failedStage: string | null;
    noTargets?: boolean;
    stages: Array<{ stage: { name: string }; passed: boolean; exitCode: number | null }>;
    evidence: Array<{ type: string; status: string; exit_code: number | null; trust: string }>;
  } | null,
): JsonValue {
  if (!v) return null;
  return {
    passed: v.passed,
    failedStage: v.failedStage,
    noTargets: v.noTargets ?? false,
    stages: v.stages.map((s) => ({ name: s.stage.name, passed: s.passed, exitCode: s.exitCode })),
    evidence: v.evidence.map((e) => ({ type: e.type, status: e.status, exit_code: e.exit_code, trust: e.trust })),
  };
}

type EngineerLike = Awaited<ReturnType<EngineeringRuntime["engineer"]>>;

async function engineerBody(
  path: ParityPath,
  rt: EngineeringRuntime,
  report: EngineerLike,
  norm: Normalizer,
): Promise<Record<string, JsonValue>> {
  return {
    outcome: report.outcome,
    rounds: report.rounds,
    risk: report.risk,
    work_item_status: report.work_item.status,
    scout_summary: report.scout_summary,
    review_summary: report.review_summary,
    incumbent: report.incumbent_candidate
      ? { status: report.incumbent_candidate.status, has_parent: report.incumbent_candidate.parent_id !== null }
      : null,
    verification: verificationSummary(report.verification),
    evidence_count: report.evidence_ids.length,
    workers: report.telemetry.workers as unknown as JsonValue,
    candidates: candidateSummary(path.ledgerOf(rt), norm),
    ledger: await eventSequence(path, rt.cwd, norm),
  };
}

async function mainAdd(root: string): Promise<string> {
  return (await readFile(join(root, "src", "add.js"), "utf8")).includes("not implemented") ? "baseline" : "changed";
}

// ----------------------------------------------------------------- scenarios

function engineerScenario(
  scenario: string,
  workers: (state: { review: ReturnType<typeof reviewWith> }) => ConstructorParameters<typeof FakeWorkerExecutor>[0],
  review: ReturnType<typeof reviewWith>,
  goal: string,
  script: EngineerScript,
): Scenario {
  return {
    command: "engineer",
    scenario,
    async run(path, norm) {
      return withFixture(norm, {}, async (fx) => {
        const rt = await path.openRuntime({
          cwd: fx.root,
          worker: new FakeWorkerExecutor(workers({ review })),
          script,
        });
        try {
          const report = await rt.engineer(goal);
          return { ...(await engineerBody(path, rt, report, norm)), main_branch: await mainAdd(fx.root) };
        } finally {
          await rt.close();
        }
      });
    },
  };
}

const implementer = implement;

const GOAL = "Implement add(a, b) to return the sum of a and b";

function engineerScenarios(): Scenario[] {
  return [
    engineerScenario(
      "happy",
      (s) => ({ scout: scoutOk, implementer: implementer(ADD_OK), reviewer: s.review }),
      reviewWith(() => []),
      GOAL,
      { implement: ADD_OK, review: () => ({ findings: [] }) },
    ),
    engineerScenario(
      "fix-round",
      (s) => ({ scout: scoutOk, implementer: implementer(ADD_OK), reviewer: s.review }),
      reviewWith((n) => (n === 1 ? HIGH : [])),
      GOAL,
      { implement: ADD_OK, review: (n) => ({ findings: n === 1 ? HIGH : [] }) },
    ),
    engineerScenario(
      "persistent-findings-failed",
      (s) => ({ scout: scoutOk, implementer: implementer(ADD_OK), reviewer: s.review }),
      reviewWith(() => HIGH),
      GOAL,
      { implement: ADD_OK, review: () => ({ findings: HIGH }) },
    ),
    engineerScenario(
      "review-not-completed",
      () => ({
        scout: scoutOk,
        implementer: implementer(ADD_OK),
        reviewer: () => ({ status: "failed", summary: "Worker exceeded the hard context-token budget.", details: {} }),
      }),
      reviewWith(() => []),
      GOAL,
      { implement: ADD_OK, review: () => "fail" },
    ),
  ];
}

function reviewScenario(scenario: string, findings: unknown[]): Scenario {
  const summary = findings.length ? "changes required" : "approved";
  return {
    command: "review",
    scenario,
    async run(path, norm) {
      return withFixture(norm, {}, async (fx) => {
        const worker = new FakeWorkerExecutor({
          reviewer: () => ({
            status: "completed",
            summary,
            details: { findings },
          }),
        });
        const rt = await path.openRuntime({
          cwd: fx.root,
          worker,
          script: { review: () => ({ findings, summary }) },
        });
        try {
          const ledger = path.ledgerOf(rt);
          const wi = await ledger.createWorkItem("review target", "medium", [fx.root], { type: "system" });
          const cand = await ledger.createCandidate(wi.id, "base", "branch", null, "implementer", "run", null, {
            type: "system",
          });
          const result = await rt.review(wi, cand, "must be correct");
          return {
            completed: result.completed,
            summary: result.summary,
            finding_count: result.findingIds.length,
            findings: ledger
              .listEntities("finding")
              .map((f) => ({ severity: f.severity ?? null, status: f.status, claim: f.claim })),
            ledger: await eventSequence(path, fx.root, norm),
          };
        } finally {
          await rt.close();
        }
      });
    },
  };
}

function verifyScenario(scenario: string, green: boolean): Scenario {
  return {
    command: "verify",
    scenario,
    async run(path, norm) {
      return withFixture(norm, { green }, async (fx) => {
        const rt = await path.openRuntime({ cwd: fx.root, worker: new FakeWorkerExecutor({}) });
        try {
          const { profile, outcome } = await path.verify(rt);
          return {
            profile: profile.name,
            profile_stages: profile.stages.map((s) => ({ name: s.name, required: s.required })),
            ...(verificationSummary(outcome) as Record<string, JsonValue>),
            ledger: await eventSequence(path, fx.root, norm),
          };
        } finally {
          await rt.close();
        }
      });
    },
  };
}

const planTask = (title: string, scope: string, dependsOn: number[] = []) => ({
  title,
  kind: "implementation",
  risk: "medium",
  depends_on: dependsOn,
  scope_paths: [scope],
});

function planWorker(
  tasks: unknown[],
  impl: (req: { cwd: string; task: string }) => Promise<{
    status: "completed";
    summary: string;
    details: Record<string, unknown>;
  }>,
): FakeWorkerExecutor {
  return new FakeWorkerExecutor({
    planner: () => ({ status: "completed", summary: "planned", details: { tasks } }),
    scout: scoutOk,
    implementer: impl,
    reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
  });
}

async function implAddOrSubtract(req: { cwd: string; task: string }) {
  const body = req.task.toLowerCase();
  if (body.includes("subtract")) {
    await writeFile(
      join(req.cwd, "src", "subtract.js"),
      "export function subtract(a, b) {\n  return a - b;\n}\n",
      "utf8",
    );
  } else if (body.includes("add")) {
    await writeFile(join(req.cwd, "src", "add.js"), ADD_OK, "utf8");
  }
  return { status: "completed" as const, summary: "implemented", details: {} };
}

async function implBoom(req: { cwd: string }) {
  await writeFile(
    join(req.cwd, "src", "add.js"),
    'export function add(a, b) {\n  throw new Error("boom");\n}\n',
    "utf8",
  );
  return { status: "completed" as const, summary: "implemented", details: {} };
}

const SUBTRACT_OK = "export function subtract(a, b) {\n  return a - b;\n}\n";
const ADD_BOOM = 'export function add(a, b) {\n  throw new Error("boom");\n}\n';

/** Script twin of {@link implAddOrSubtract}. */
const scriptAddOrSubtract: EngineerScript["implement"] = (_run, task) => {
  const body = task.toLowerCase();
  if (body.includes("subtract")) return { path: "src/subtract.js", content: SUBTRACT_OK };
  if (body.includes("add")) return { path: "src/add.js", content: ADD_OK };
  return undefined;
};

type PlanRt = EngineeringRuntime;

function taskSummary(ledger: LedgerAccess, planId: string, norm: Normalizer): JsonValue {
  const tasks = ledger.listTasks(planId);
  const index = new Map(tasks.map((t, i) => [t.id, i]));
  return tasks.map((t) => ({
    title: t.title,
    status: t.status,
    risk: t.risk,
    depends_on: t.depends_on.map((d) => index.get(d) ?? norm.text(d)),
    linked_result: Boolean(t.result_work_item_id),
  }));
}

function planScenario(
  scenario: string,
  build: () => FakeWorkerExecutor,
  script: EngineerScript,
  drive: (rt: PlanRt, ledger: LedgerAccess, norm: Normalizer) => Promise<Record<string, JsonValue>>,
): Scenario {
  return {
    command: "plan",
    scenario,
    async run(path, norm) {
      return withFixture(norm, {}, async (fx) => {
        const rt = await path.openRuntime({ cwd: fx.root, worker: build(), script });
        try {
          const body = await drive(rt, path.ledgerOf(rt), norm);
          return { ...body, ledger: await eventSequence(path, fx.root, norm) };
        } finally {
          await rt.close();
        }
      });
    },
  };
}

function planScenarios(): Scenario[] {
  const twoTasks = [
    planTask("implement add to return the sum", "src/add.js"),
    planTask("implement subtract to return the difference", "src/subtract.js", [0]),
  ];
  const addThenSubtract = [
    planTask("implement add", "src/add.js"),
    planTask("implement subtract", "src/subtract.js", [0]),
  ];
  const oneAdd = [planTask("implement add", "src/add.js")];
  const twelveTasks = Array.from({ length: 12 }, (_, i) => planTask(`task ${i}`, `src/t${i}.js`, [999]));
  return [
    planScenario(
      "happy",
      () => planWorker(twoTasks, implAddOrSubtract),
      { planner: twoTasks, implement: scriptAddOrSubtract },
      async (rt, ledger, norm) => {
        const plan = await rt.plan("Build a small math module with add and subtract");
        const dag = await rt.executePlan(plan.plan_work_item.id);
        return {
          plan_outcome: plan.outcome,
          dag_outcome: dag.outcome,
          order: dag.order.map((t) => t.title),
          tasks: taskSummary(ledger, plan.plan_work_item.id, norm),
          plan_work_item_status: ledger.getWorkItem(plan.plan_work_item.id)!.status,
        };
      },
    ),
    planScenario(
      "blocked-downstream",
      () => planWorker(addThenSubtract, implBoom),
      { planner: addThenSubtract, implement: () => ({ path: "src/add.js", content: ADD_BOOM }) },
      async (rt, ledger, norm) => {
        const plan = await rt.plan("Build add then subtract");
        const dag = await rt.executePlan(plan.plan_work_item.id);
        return {
          plan_outcome: plan.outcome,
          dag_outcome: dag.outcome,
          tasks: taskSummary(ledger, plan.plan_work_item.id, norm),
        };
      },
    ),
    planScenario(
      "idempotent-rerun",
      () => planWorker(oneAdd, implAddOrSubtract),
      { planner: oneAdd, implement: scriptAddOrSubtract },
      async (rt, ledger, norm) => {
        const plan = await rt.plan("add");
        const first = await rt.executePlan(plan.plan_work_item.id);
        const linkBefore = ledger.listTasks(plan.plan_work_item.id)[0]!.result_work_item_id;
        const eventsBetween = ledger.count();
        const second = await rt.executePlan(plan.plan_work_item.id);
        const linkAfter = ledger.listTasks(plan.plan_work_item.id)[0]!.result_work_item_id;
        return {
          first_outcome: first.outcome,
          second_outcome: second.outcome,
          link_preserved: linkBefore === linkAfter,
          implementer_reruns: ledger.listCandidates().length,
          events_added_by_rerun: ledger.count() - eventsBetween,
          tasks: taskSummary(ledger, plan.plan_work_item.id, norm),
        };
      },
    ),
    planScenario(
      "invalid-deps",
      () => planWorker(twelveTasks, implAddOrSubtract),
      { planner: twelveTasks, implement: scriptAddOrSubtract },
      async (rt, ledger, norm) => {
        const plan = await rt.plan("big goal");
        return {
          plan_outcome: plan.outcome,
          task_count: plan.tasks.length,
          tasks: taskSummary(ledger, plan.plan_work_item.id, norm),
          decisions: ledger.listEntities("decision").map((d) => d.claim),
          findings: [...new Set(ledger.listEntities("finding").map((f) => `${f.severity ?? "?"}: ${f.claim}`))],
        };
      },
    ),
    planScenario(
      "unknown-plan",
      () => new FakeWorkerExecutor({}),
      {},
      async (rt) => {
        let error = "";
        try {
          await rt.executePlan("WI-does-not-exist");
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        return { error };
      },
    ),
  ];
}

type TournamentRt = Awaited<ReturnType<EngineeringRuntime["tournament"]>>;

function tournamentScenario(
  scenario: string,
  n: number,
  worker: () => FakeWorkerExecutor,
  script: EngineerScript,
): Scenario {
  return {
    command: "tournament",
    scenario,
    async run(path, norm) {
      return withFixture(norm, {}, async (fx) => {
        const rt = await path.openRuntime({ cwd: fx.root, worker: worker(), script });
        try {
          const report: TournamentRt = await rt.tournament(GOAL, { n });
          return {
            outcome: report.outcome,
            n_candidates: report.n_candidates,
            risk: report.risk,
            work_item_status: report.work_item.status,
            entries: report.entries.map((e) => ({
              candidate_status: e.candidate.status,
              passed: e.outcome.passed,
              failed_stage: e.outcome.failedStage,
              findings: e.findings.length,
              review_completed: e.reviewCompleted,
              winner: e.winner,
            })),
            winner_index: report.entries.findIndex((e) => e.winner),
            evidence_count: report.evidence_ids.length,
            candidates: candidateSummary(path.ledgerOf(rt), norm),
            main_branch: await mainAdd(fx.root),
            ledger: await eventSequence(path, fx.root, norm),
          };
        } finally {
          await rt.close();
        }
      });
    },
  };
}

function tournamentScenarios(): Scenario[] {
  const NOISE = [{ severity: "high", claim: "unnecessary +0 noise", evidence: "diff://src/add.js" }];
  const ADD_NOISY = "export function add(a, b) {\n  return a + b + 0;\n}\n";
  const leg3 = (n: number): string => (n === 1 ? ADD_OK : n === 2 ? ADD_BAD : ADD_NOISY);
  const leg2 = (n: number): string => (n === 1 ? ADD_BAD : ADD_OK);
  return [
    tournamentScenario(
      "serial-n3-winner",
      3,
      () =>
        new FakeWorkerExecutor({
          scout: scoutOk,
          implementer: implementer(leg3),
          reviewer: reviewWith((n) => (n === 2 ? NOISE : [])),
        }),
      {
        implement: (run) => ({ path: "src/add.js", content: leg3(run) }),
        review: (n) => ({ findings: n === 2 ? NOISE : [] }),
      },
    ),
    tournamentScenario(
      "failing-leg",
      2,
      () =>
        new FakeWorkerExecutor({
          scout: scoutOk,
          implementer: implementer(leg2),
          reviewer: reviewWith(() => []),
        }),
      { implement: (run) => ({ path: "src/add.js", content: leg2(run) }) },
    ),
  ];
}

// ------------------------------------------------------------------- mission

interface MissionKnobs {
  /** Findings the reviewer raises; mutable so a scenario can fix them before a resume. */
  findings: string[];
  validationFailTimes: number;
}

interface MissionHarness {
  session: MissionSession;
  orchestrator: Orchestrator;
  store: MissionView;
  knobs: MissionKnobs;
  calls: { agent: number; review: number; validation: number };
}

function backendsFor(knobs: MissionKnobs, calls: MissionHarness["calls"]): BrokerBackends {
  return {
    agent: {
      runAgent: async () => {
        calls.agent += 1;
        return { executionId: "e", exitStatus: "succeeded", summary: "implemented", artifactRefs: [], usage: {} };
      },
    },
    review: {
      runReview: async ({ acceptanceCriteria }) => {
        calls.review += 1;
        const findings = knobs.findings.map((summary) => ({ summary, severity: "blocking", status: "open" }));
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
          findings,
          reviewEvidence: {
            reviewerSessionId: "review-session",
            model: "test-reviewer",
            provider: "test",
            verdict: findings.length > 0 ? ("request_changes" as const) : ("approve" as const),
            independenceMode: "independent" as const,
            findings: findings.map((f) => ({
              severity: "blocking" as const,
              summary: f.summary,
              status: "open" as const,
            })),
            outputValid: true,
            accessible: true,
            acceptanceResults: (acceptanceCriteria ?? []).map((criterion) => ({
              acceptanceId: criterion.acceptanceId,
              status: findings.length > 0 ? ("failed" as const) : ("passed" as const),
              detail: "deterministic reviewer checked this criterion",
            })),
          },
        };
      },
    },
    validation: {
      runValidation: async () => {
        calls.validation += 1;
        if (calls.validation <= knobs.validationFailTimes) {
          return { executionId: "e", exitStatus: "failed", summary: "suite red", artifactRefs: [], usage: {} };
        }
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "valid",
          artifactRefs: [],
          usage: {},
          validationEvidence: {
            command: "npm test",
            profile: "test",
            exitCode: 0,
            testSummary: { passed: 1, failed: 0 },
            noTargets: false,
            accessible: true,
            acceptanceResults: [],
          },
        };
      },
    },
  };
}

function missionHarness(path: ParityPath, norm: Normalizer, partial: Partial<MissionKnobs> = {}): MissionHarness {
  // The stub git provider reports the checkout it runs in as its root.
  norm.addRoot(process.cwd());
  const knobs: MissionKnobs = { findings: [], validationFailTimes: 0, ...partial };
  const calls = { agent: 0, review: 0, validation: 0 };
  const session = path.openMission({
    backends: backendsFor(knobs, calls),
    git: {
      root: process.cwd(),
      headCommit: async () => (calls.agent > 1 ? "candidate-repair-sha" : "candidate-test-sha"),
      captureDiff: async () =>
        calls.agent > 1 ? "diff --git a/src/repair.ts b/src/repair.ts" : "diff --git a/src/health.ts b/src/health.ts",
      changedFiles: async () => ["src/health.ts"],
      loadCandidateLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadIntegrationRunInventory: async () => ({ records: [], diagnostics: [] }),
      loadPromotionLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadPendingBranchCleanupInventory: async () => ({ records: [], diagnostics: [] }),
    } as unknown as GitRepo,
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "none" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        acceptance_ids: mission.acceptance_criteria.flatMap((c) => (c.acceptance_id ? [c.acceptance_id] : [])),
        max_attempts: 3,
        failure_policy: "retry" as const,
      },
    ],
  });
  return { session, orchestrator: session.orchestrator, store: session.store, knobs, calls };
}

const MISSION_REQUEST = "Add a health endpoint";
const MISSION_CTX = { repository: ".", baseRef: "abc", mutationRequested: true } as const;

function missionSummary(h: MissionHarness, missionId: string, norm: Normalizer): Record<string, JsonValue> {
  const mission = h.store.getMission(missionId)!;
  return {
    status: mission.status,
    required_gates: [...mission.required_gates].sort(),
    tasks: h.store.listTasks(missionId).map((t) => ({
      kind: t.kind,
      role: t.role ?? null,
      objective: t.objective.split(":")[0]!.slice(0, 40),
      status: t.status,
    })),
    findings: h.store
      .listFindings(missionId)
      .map((f) => ({ severity: f.severity, status: f.status, summary: f.summary })),
    recovery: h.store.listRecoveryDecisions(missionId).map((d) => ({ action: d.action, status: d.status })),
    calls: { ...h.calls },
    events: normalizeEvents(h.session.events(), norm) as unknown as JsonValue,
  };
}

function missionScenario(
  scenario: string,
  drive: (path: ParityPath, norm: Normalizer) => Promise<Record<string, JsonValue>>,
): Scenario {
  return { command: "mission", scenario, run: (path, norm) => drive(path, norm) };
}

function missionScenarios(): Scenario[] {
  return [
    missionScenario("complete", async (path, norm) => {
      const h = missionHarness(path, norm);
      const r = await h.orchestrator.orchestrate(MISSION_REQUEST, MISSION_CTX);
      return { completed: r.completed, ...missionSummary(h, r.mission.mission_id, norm) };
    }),
    missionScenario("findings-repair-blocked", async (path, norm) => {
      const h = missionHarness(path, norm, { findings: ["missing null check in auth service"] });
      const r = await h.orchestrator.orchestrate(MISSION_REQUEST, MISSION_CTX);
      return { completed: r.completed, ...missionSummary(h, r.mission.mission_id, norm) };
    }),
    missionScenario("validation-fail-then-pass", async (path, norm) => {
      const h = missionHarness(path, norm, { validationFailTimes: 1 });
      const r = await h.orchestrator.orchestrate("Add an endpoint and fix the build", MISSION_CTX);
      return { completed: r.completed, ...missionSummary(h, r.mission.mission_id, norm) };
    }),
    missionScenario("block-then-resume", async (path, norm) => {
      const h = missionHarness(path, norm, { findings: ["missing null check in auth service"] });
      const r = await h.orchestrator.orchestrate(MISSION_REQUEST, MISSION_CTX);
      const blocked = h.store.getMission(r.mission.mission_id)!.status;
      h.knobs.findings = [];
      const resumed = await h.orchestrator.repairBlockedMission(r.mission.mission_id);
      await h.store.flush();
      return {
        status_before_resume: blocked,
        status_after_resume: resumed.status,
        ...missionSummary(h, r.mission.mission_id, norm),
      };
    }),
    missionScenario("restart-restores-state", async (path, norm) => {
      const h = missionHarness(path, norm);
      const r = await h.orchestrator.orchestrate(MISSION_REQUEST, MISSION_CTX);
      await h.store.flush();
      const { store: restored, orchestrator: o2 } = h.session.restart();
      const mission = restored.getMission(r.mission.mission_id)!;
      return {
        status_before: r.mission.status,
        status_after_restart: mission.status,
        task_count_before: h.store.listTasks(r.mission.mission_id).length,
        task_count_after: restored.listTasks(r.mission.mission_id).length,
        gate_can_complete: o2.gate.evaluate(mission).can_complete,
        events: normalizeEvents(h.session.events(), norm) as unknown as JsonValue,
      };
    }),
  ];
}

// ------------------------------------------------------------------ recovery

function recoveryScenarios(): Scenario[] {
  return [
    {
      command: "recovery",
      scenario: "torn-tail-reopen-append",
      async run(path, norm) {
        return withFixture(norm, {}, async (fx) => {
          const worker = () =>
            new FakeWorkerExecutor({
              scout: scoutOk,
              implementer: implementer(ADD_OK),
              reviewer: reviewWith(() => []),
            });
          const script: EngineerScript = { implement: ADD_OK };
          const first = await path.openRuntime({ cwd: fx.root, worker: worker(), script });
          const report = await first.engineer(GOAL);
          const eventsBefore = path.ledgerOf(first).count();
          await first.close();

          await path.tearLedgerTail(fx.root);

          const second = await path.openRuntime({ cwd: fx.root, worker: worker(), script });
          try {
            const ledger = path.ledgerOf(second);
            const eventsAfterReopen = ledger.count();
            const wi = ledger.getWorkItem(report.work_item.id);
            const appended = await ledger.createWorkItem("after the tear", "low", [fx.root], { type: "system" });
            // The fragment torn above stays mid-file (the store starts the next record on a fresh line).
            const reread = await path.readEvents(fx.root, { tornLinesExpected: true });
            return {
              events_before: eventsBefore,
              events_after_reopen: eventsAfterReopen,
              prior_work_item_status: wi?.status ?? null,
              appended_work_item_status: appended.status,
              events_after_append: reread.length,
              ledger: normalizeEvents(reread, norm) as unknown as JsonValue,
            };
          } finally {
            await second.close();
          }
        });
      },
    },
  ];
}

function commandScenario(
  scenario: string,
  command: string,
  args: string,
  seed?: "work-item-without-candidate",
): Scenario {
  return {
    command: `cmd-${command}`,
    scenario,
    async run(path, norm) {
      return withFixture(norm, {}, async (fx) => {
        if (seed) {
          const rt = await path.openRuntime({ cwd: fx.root, worker: new FakeWorkerExecutor({}) });
          try {
            await path.ledgerOf(rt).createWorkItem("seeded", "low", [fx.root], { type: "system" });
          } finally {
            await rt.close();
          }
        }
        const host = path.loadCommandHost();
        const notices: Array<{ text: string; level: string }> = [];
        const ctx = {
          cwd: fx.root,
          mode: "tui",
          signal: undefined,
          model: undefined,
          modelRegistry: undefined,
          getContextUsage: () => undefined,
          isIdle: () => true,
          ui: {
            notify: (text: string, level: string) => notices.push({ text, level }),
            custom: () => ({ close: () => {} }),
            setFooter: () => {},
            onTerminalInput: () => () => {},
          },
        };
        try {
          await host.commands.get(command)!.handler(args, ctx);
        } finally {
          await host.shutdown(ctx);
        }
        return { args, notices: notices.map((n) => ({ level: n.level, text: norm.text(n.text) })) };
      });
    },
  };
}

export const scenarios: Scenario[] = [
  commandScenario("no-work-item", "review", ""),
  commandScenario("no-candidate", "review", "", "work-item-without-candidate"),
  commandScenario("unknown-plan", "execute", "WI-does-not-exist"),
  commandScenario("missing-goal", "engineer", ""),
  ...engineerScenarios(),
  reviewScenario("approve", []),
  reviewScenario("findings", HIGH),
  verifyScenario("green", true),
  verifyScenario("red", false),
  ...planScenarios(),
  ...tournamentScenarios(),
  ...missionScenarios(),
  ...recoveryScenarios(),
];

// -------------------------------------------------------------------- runner

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "legacy-golden");

/**
 * Register one test per scenario that renders it through `path` and compares byte for
 * byte with its golden file. UPDATE_GOLDEN=1 rewrites the files, but only from the
 * legacy path (the baseline) and never in CI.
 */
export function runParity(path: ParityPath): void {
  const update = process.env.UPDATE_GOLDEN === "1";
  if (update && process.env.CI) {
    throw new Error(
      "UPDATE_GOLDEN=1 is refused when CI is set: goldens are regenerated deliberately, on a workstation",
    );
  }
  if (update && path.name !== legacyPath.name) {
    throw new Error(`UPDATE_GOLDEN=1 only regenerates from the legacy path, not "${path.name}"`);
  }
  for (const [scenario, why] of Object.entries(path.exemptions ?? {})) {
    process.stdout.write(`# ${path.name} path exemption: ${scenario}: ${why}\n`);
  }
  describe(`legacy golden outputs (parity gate, ${path.name} path)`, () => {
    for (const s of scenarios) {
      const skip = path.skipReason?.(s) || false;
      it(`${s.command} / ${s.scenario}`, { skip }, async () => {
        const actual = await renderScenario(s, path);
        const file = join(GOLDEN_DIR, goldenName(s));
        if (update) {
          mkdirSync(GOLDEN_DIR, { recursive: true });
          writeFileSync(file, actual);
          return;
        }
        assert.equal(
          actual,
          readFileSync(file, "utf8"),
          `${goldenName(s)} drifted; rerun with UPDATE_GOLDEN=1 if intended`,
        );
      });
    }

    it("every printed exemption names a real scenario", () => {
      const known = new Set(scenarios.map((s) => `${s.command} / ${s.scenario}`));
      for (const key of Object.keys(path.exemptions ?? {})) assert.ok(known.has(key), `unknown exemption ${key}`);
    });

    it("has a unique golden file per scenario", () => {
      const names = scenarios.map(goldenName);
      assert.equal(new Set(names).size, names.length);
    });
  });
}
