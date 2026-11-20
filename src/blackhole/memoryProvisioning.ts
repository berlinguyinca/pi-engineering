import type { HindsightRunner } from "./hindsight.ts";
import { makeRunner } from "./hindsightRunner.ts";
/**
 * Memory provisioning checks (issue #717, the remaining half of #673 ask 3).
 *
 * The failure taxonomy in `hindsight.ts` classifies ONE call. It cannot answer
 * the question an operator actually asks — "is this host provisioned, or was
 * memory just slow this turn?" — because a timeout is evidence about the call,
 * not about the host. Measured on this deployment (2026-11-18): steady-state
 * recall 0.28-0.42 s, the recorded cold spike 4.06 s (~13x apart), and 8-way
 * contention moves steady state by ~10% (331 ms vs 302 ms idle). "Timed out"
 * was therefore never information about provisioning, yet it printed as if it
 * were.
 *
 * This module answers it with checks, each one an existing contract:
 *
 * | check                              | call                                        | proves |
 * | ---------------------------------- | ------------------------------------------- | ------ |
 * | `client`                           | `herdr-memory --version`                    | the binary the runtime actually talks to exists, and what it says it is |
 * | `config`                           | `herdr-memory validate-config`              | the CLI's own config parses (offline; nothing called this before) |
 * | `credentials:<tenant>`, `pin`, `package_revision`, `server`, … | `herdr-eng memory doctor --json` (via `memoryPreflight.ts`) | credential readability + private modes, the pinned revision, reachability |
 * | `bank:<scope>`                     | `herdr-memory documents --kind fact --scope S --limit 1` | the scope resolves to an engineering bank, i.e. runbook section 5 ran |
 *
 * The host-side half is NOT re-implemented here. `herdr-eng memory doctor` lives
 * in herdr-engineering, which owns the pin and the credential layout; this module
 * consumes its JSON through `runMemoryPreflight` and adds only what doctor does
 * not cover — the client the runtime will actually spawn, and bank resolvability
 * per configured scope (herdr-memory#17: a never-written bank 404s, so the first
 * memory call a project ever makes is one that cannot succeed).
 *
 * The two answers an operator acts on are kept apart:
 *   `fail`  — retrying will not fix this. Missing binary, unusable config, refused
 *             credential, missing bank. Sets `provisioningGap`.
 *   `warn`  — the check learned nothing, including nothing about the host being
 *             broken. A slow host is therefore never reported as an unprovisioned
 *             one, and a host that has `herdr-memory` but not the `herdr-eng`
 *             wrapper is never told to install a client it already has.
 *
 * The client version is reported, never compared against a pin: the pin lives in
 * the install script (`lock/upstreams.yaml`, `memory_install.PINNED_REVISION`),
 * and a second copy here would rot and then lie.
 */
import { engineeringBank } from "./memoryBanks.ts";
import { type MemoryPreflightResult, runMemoryPreflight } from "./memoryPreflight.ts";

export type PreflightState = "ok" | "warn" | "unknown" | "fail";

export interface PreflightCheck {
  /** Stable identifier operators quote: `client`, `config`, `credentials:project`, `server`, `bank:project`. */
  name: string;
  state: PreflightState;
  detail: string;
  /** What the check cost, so a slow host is visible in the report rather than inferred. */
  ms: number;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /**
   * True when a check proved the host is not provisioned (or proved it cannot be reached at all). This is the
   * half of the notice that says "install / configure", as opposed to "the service was slow this turn".
   */
  provisioningGap: boolean;
  /**
   * True when nothing was proved either way — every check that ran said "I could not tell" (a client that
   * will not answer `--version`, a ceiling reached before anything completed). Neither of the two answers the
   * operator acts on is available, so the notice must say that instead of picking one.
   */
  inconclusive: boolean;
  /** One line per check, in check order — what `/memory status` prints and what a headless notice names. */
  summary: string;
}

/** Check kinds in the order they run, cheapest first. Per-tenant and per-scope checks extend these names. */
export const PREFLIGHT_CHECK_ORDER = [
  "client",
  "config",
  "doctor",
  "credentials",
  "pin",
  "package_revision",
  "server",
  "bank",
] as const;

/** The runbook section that fixes every `fail` this module can produce. */
export const PROVISIONING_RUNBOOK = "docs/integration/HINDSIGHT-MEMORY-STATUS.md";

export interface PreflightConfig {
  /** The client the runtime actually spawns (`herdr-memory`), not the provisioning wrapper. */
  cli: string;
  scopes: string[];
  /** Per-call ceiling, the same `memory.hindsight.timeout_ms` the provider uses. */
  timeoutMs: number;
  /** Harness handed to `herdr-eng memory doctor`. */
  harness?: string;
  /** Injectable subprocess runner (same contract as the provider's). Defaults to a real spawn. */
  run?: HindsightRunner;
  /**
   * Overall ceiling for the whole preflight. A check that would start after it is not started: an operator
   * waiting on `/memory status` or a session start gets a partial report plus one `budget` line rather than
   * more spawns of something that is not answering.
   */
  deadlineMs?: number;
  /**
   * The host-side half. Defaults to `herdr-eng memory doctor` through `memoryPreflight.ts`; injectable so a
   * test can say "doctor says the credentials are 0644" without installing herdr-engineering.
   */
  doctor?: (opts: { harness: string; timeoutMs: number }) => Promise<MemoryPreflightResult>;
}

const ICON: Record<PreflightState, string> = { ok: "ok  ", warn: "warn", unknown: "n/a ", fail: "FAIL" };

async function call(
  run: HindsightRunner,
  cli: string,
  args: string[],
  timeoutMs: number,
): Promise<{
  json: Record<string, unknown> | null;
  exitCode: number | null;
  /** The process was killed by the deadline — a slow call, not a broken host. */
  timedOut: boolean;
  /** The executable does not exist on this host. */
  missing: boolean;
}> {
  try {
    const res = await run(cli, args, timeoutMs);
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(res.stdout);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      /* unreadable output is a finding, not a crash */
    }
    return { json, exitCode: res.exitCode, timedOut: false, missing: false };
  } catch (error) {
    const e = error as { code?: unknown; killed?: boolean };
    if (e?.code === "ENOENT") return { json: null, exitCode: null, timedOut: false, missing: true };
    const timedOut = e?.killed === true || e?.code === "ETIMEDOUT";
    return { json: null, exitCode: null, timedOut, missing: false };
  }
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const boolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/**
 * Run every check that can run, cheapest first, and stop early only when the client itself is absent — checks
 * after that would each report the same missing executable and read like four problems instead of one.
 */
export async function runProvisioningChecks(config: PreflightConfig): Promise<PreflightReport> {
  const run = config.run ?? makeRunner(config.harness ?? "pi");
  const checks: PreflightCheck[] = [];
  const add = (name: string, state: PreflightState, detail: string, beganAt: number) =>
    checks.push({ name, state, detail, ms: Math.max(0, Date.now() - beganAt) });
  const startedAt = Date.now();
  /** Past the overall ceiling, and the ceiling is a fact about the host's speed, never about provisioning. */
  const outOfBudget = () => config.deadlineMs !== undefined && Date.now() - startedAt >= config.deadlineMs;
  const budgetLine = () => {
    add(
      "budget",
      "warn",
      `preflight stopped at its ${String(config.deadlineMs)} ms ceiling — the checks that did not run learned nothing`,
      Date.now(),
    );
    return finish(checks);
  };

  // 1. Is the client the runtime will spawn even here, and what does it say it is?
  let beganAt = Date.now();
  const version = await call(run, config.cli, ["--version"], config.timeoutMs);
  if (version.missing) {
    add(
      "client",
      "fail",
      `herdr-memory is not installed on this host — install the pinned client (see ${PROVISIONING_RUNBOOK})`,
      beganAt,
    );
    return finish(checks);
  }
  if (version.timedOut) {
    // Present but wedged: `--version` is local and answers in milliseconds, so a client that will not answer it
    // is unhealthy without anything being unprovisioned. Calling that a provisioning gap would send the
    // operator to install a binary that is already there.
    add(
      "client",
      "warn",
      `herdr-memory did not answer --version within ${config.timeoutMs} ms — the client is present but not answering, and nothing else could be checked`,
      beganAt,
    );
    return finish(checks);
  }
  const client = text(version.json?.client);
  const contract = typeof version.json?.contract === "number" ? version.json.contract : null;
  if (!client || contract === null) {
    add("client", "fail", "herdr-memory answered --version with unreadable output", beganAt);
    return finish(checks);
  }
  // Reported, never asserted: the pin lives in the install script, not here.
  add("client", "ok", `client ${client} (contract ${contract})`, beganAt);

  // 2. Does the CLI's own config parse? This is the check nothing used to call.
  if (outOfBudget()) return budgetLine();
  beganAt = Date.now();
  const validated = await call(run, config.cli, ["validate-config"], config.timeoutMs);
  const valid = boolean(validated.json?.valid);
  if (validated.timedOut) {
    add("config", "warn", `validate-config did not finish within ${config.timeoutMs} ms`, beganAt);
  } else if (valid === true) {
    add("config", "ok", `configuration valid (contract ${String(validated.json?.contract ?? "unknown")})`, beganAt);
  } else {
    add(
      "config",
      "fail",
      text(validated.json?.error) ??
        `validate-config reported the configuration unusable (exit ${String(validated.exitCode)})`,
      beganAt,
    );
  }

  // 3. Credentials, permissions, the pinned revision and reachability — the checks herdr-engineering owns.
  //    Doctor is consulted through memoryPreflight.ts so `/engineering version` and this report read the same
  //    source. A failing doctor still prints its JSON, so the per-check statuses, not the exit code, are the
  //    signal; `unknown` means doctor could not tell, which is never evidence of a gap.
  if (outOfBudget()) return budgetLine();
  beganAt = Date.now();
  const doctor = await (config.doctor ?? ((opts) => runMemoryPreflight(opts)))({
    harness: config.harness ?? "pi",
    timeoutMs: config.timeoutMs,
  });
  if (!doctor.available) {
    // `not-installed` here means the *wrapper* is absent, not the client — step 1 already proved the client
    // is present. Telling this operator to install something would be wrong; what is missing is the answer.
    // Every unavailable code is therefore a `warn`: it says "this check learned nothing", never "the host is
    // unprovisioned".
    add(
      "doctor",
      "warn",
      `${doctor.reason} — credential, permission, pin and reachability checks could not run`,
      beganAt,
    );
  } else {
    for (const entry of doctor.checks) {
      // Doctor's vocabulary is four-valued and `unknown` is not a softer `fail` or a quieter `warn`: it means
      // the check learned nothing. Folding it into `warn` told operators to reconcile drift that was not there
      // (#728, measured on a host where `fleet_update` had never been recorded).
      const state: PreflightState =
        entry.status === "ok"
          ? "ok"
          : entry.status === "fail"
            ? "fail"
            : entry.status === "unknown"
              ? "unknown"
              : "warn";
      add(entry.name, state, entry.detail || entry.status, beganAt);
    }
  }

  // 4. Does each configured scope resolve to a bank? A never-written bank 404s (herdr-memory#17), which means
  //    the first memory call a project ever makes cannot succeed.
  for (const scope of config.scopes) {
    if (outOfBudget()) return budgetLine();
    beganAt = Date.now();
    const listing = await call(
      run,
      config.cli,
      ["documents", "--kind", "fact", "--scope", scope, "--limit", "1", "--offset", "0"],
      config.timeoutMs,
    );
    if (listing.timedOut) {
      add(
        `bank:${scope}`,
        "warn",
        `reading scope ${scope} timed out after ${config.timeoutMs} ms — a slow read, not a missing bank`,
        beganAt,
      );
      continue;
    }
    const error = text(listing.json?.error);
    if (error) {
      const missingBank = /404|not found/i.test(error);
      add(
        `bank:${scope}`,
        missingBank ? "fail" : "warn",
        missingBank
          ? `bank for scope ${scope} does not exist — create it (PUT /v1/default/banks/<bank>, see ${PROVISIONING_RUNBOOK})`
          : `bank listing for scope ${scope} refused: ${error}`,
        beganAt,
      );
      continue;
    }
    const bank = text(listing.json?.bank_id);
    if (!bank) {
      add(`bank:${scope}`, "warn", `bank listing for scope ${scope} was unreadable`, beganAt);
      continue;
    }
    if (!engineeringBank(bank, scope)) {
      add(
        `bank:${scope}`,
        "warn",
        `${bank} is not an engineering memory bank, so its contents are not trusted`,
        beganAt,
      );
      continue;
    }
    const total = typeof listing.json?.total === "number" ? String(listing.json.total) : "unknown";
    add(`bank:${scope}`, "ok", `${bank} resolves (${total} record(s))`, beganAt);
  }

  return finish(checks);
}

function finish(checks: PreflightCheck[]): PreflightReport {
  return {
    checks,
    provisioningGap: checks.some((c) => c.state === "fail"),
    // Nothing ok and nothing failing means every check that ran declined to answer — which is not evidence
    // of a healthy host, whatever the absence of a failure might suggest.
    inconclusive: checks.length > 0 && !checks.some((c) => c.state === "ok") && !checks.some((c) => c.state === "fail"),
    summary: checks.map((c) => `${c.name}  ${ICON[c.state]}  ${c.detail}  (${c.ms} ms)`).join("\n"),
  };
}

/**
 * The checks that produced nothing, split by *why* — because the operator's next action differs.
 *
 * `slow` is a call that could not be completed (absent wrapper, timed-out read, unreadable output): wait, or
 * make the thing reachable. `noData` is a check that completed and answered "I could not tell" (doctor's
 * `unknown`): there is nothing to reconcile, and calling it drift would send someone to fix a non-problem.
 */
export function unansweredChecks(report: PreflightReport): { slow: string[]; noData: string[] } {
  return {
    slow: report.checks.filter((c) => c.state === "warn").map((c) => c.name),
    noData: report.checks.filter((c) => c.state === "unknown").map((c) => c.name),
  };
}

/** One trailing sentence naming what did not answer — shared so the notice and `/memory status` cannot disagree. */
export function unansweredSentence(report: PreflightReport): string {
  const { slow, noData } = unansweredChecks(report);
  const parts: string[] = [];
  if (slow.length > 0) parts.push(`${slow.length} check(s) could not answer: ${slow.join(", ")}`);
  if (noData.length > 0)
    parts.push(
      `${noData.length} check(s) reported no data (the check learned nothing, which is not drift): ${noData.join(", ")}`,
    );
  return parts.length > 0 ? ` ${parts.join("; ")}.` : "";
}
