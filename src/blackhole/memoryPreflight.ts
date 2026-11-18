/**
 * Memory preflight (#717): answer "is this host provisioned?" before a recall has to fail.
 *
 * Every check below is an existing contract of the pinned `herdr-memory` CLI, verified against the real client
 * on 2026-11-18 and pinned byte-for-byte in `test/unit/hindsight-preflight.test.ts`:
 *
 * | call                                            | healthy answer                                  | broken answer |
 * |-------------------------------------------------|-------------------------------------------------|---------------|
 * | `--version`                                     | `{"client":"0.1.8","contract":1,"harness":"pi"}` | spawn ENOENT  |
 * | `validate-config`                               | `{"valid":true,"contract":1,"client":"0.1.8"}`   | `{"valid":false,"error":"Invalid or unreadable memory configuration"}`, exit 1 |
 * | `doctor`                                        | `{"ok":true,"checks":[{"name","ok","detail"}…]}` | `ok:false` with the failing check named |
 * | `documents --kind fact --scope S --limit 1`     | `{"bank_id":"<ns>-facts","total":N,…}`           | `{"error":"Memory service rejected request (HTTP 404)"}`, exit 1 |
 *
 * The distinction that matters, and the reason this module exists: **a host that was never provisioned and a
 * host whose read was merely slow are different operator actions.** Today both collapse into one notice. The
 * measurements behind that split (see #673 and the comment on #717): steady-state recall 0.28–0.42 s, cold
 * spike 4.06 s, and load does not move it (331 ms under 8-way contention vs 302 ms idle) — so a timeout is
 * evidence about the *call*, not about the *host*. `fail` therefore means "retrying will not fix this";
 * `warn` means "this call did not tell us anything, including that the host is broken".
 *
 * Nothing here asserts a version pin: the pin lives in herdr-engineering's install script, so the check reports
 * the observed client and contract instead of hardcoding a number that would rot and then lie.
 */
import { type HindsightRunner, engineeringBank, makeRunner } from "./hindsight.ts";

export type PreflightState = "ok" | "warn" | "fail";

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
  /** One line per check, in check order — what `/memory status` prints and what a headless notice names. */
  summary: string;
}

/** Check kinds in the order they run, cheapest first. Per-tenant and per-scope checks extend these names. */
export const PREFLIGHT_CHECK_ORDER = [
  "client",
  "config",
  "credentials",
  "server",
  "outbox",
  "dead_letter",
  "bank",
] as const;

export interface PreflightConfig {
  cli: string;
  scopes: string[];
  timeoutMs: number;
  harness: string;
  /** Injectable subprocess runner (same contract as the provider's). Defaults to a real spawn. */
  run?: HindsightRunner;
}

interface RawCall {
  json: Record<string, unknown> | null;
  exitCode: number | null;
  /** The process was killed by the deadline — a slow call, not a broken host. */
  timedOut: boolean;
  /** The executable does not exist on this host. */
  missing: boolean;
}

const ICON: Record<PreflightState, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/** The runbook section that fixes every `fail` this module can produce. */
export const PROVISIONING_RUNBOOK = "docs/integration/HINDSIGHT-MEMORY-STATUS.md";

async function call(run: HindsightRunner, cli: string, args: string[], timeoutMs: number): Promise<RawCall> {
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

/** `credential:<tenant>` from the doctor becomes `credentials:<tenant>`, so every credential gap is its own line. */
function doctorCheckName(name: string): string {
  if (name.startsWith("credential:")) return `credentials:${name.slice("credential:".length)}`;
  return name;
}

/**
 * Run every check that can run, cheapest first, and stop early only when the CLI itself is absent — checks
 * after that would each report the same missing binary, which reads like four problems instead of one.
 */
export async function runMemoryPreflight(config: PreflightConfig): Promise<PreflightReport> {
  const run = config.run ?? makeRunner(config.harness);
  const checks: PreflightCheck[] = [];
  const add = (name: string, state: PreflightState, detail: string, beganAt: number) =>
    checks.push({ name, state, detail, ms: Math.max(0, Date.now() - beganAt) });

  // 1. Is the client even here, and what does it say it is?
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
    add("client", "fail", `herdr-memory did not answer --version within ${config.timeoutMs} ms`, beganAt);
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

  // 3. Credentials and reachability, from the CLI's own doctor. A failing doctor still exits with JSON, so
  //    the exit code is not the signal — each reported check is.
  beganAt = Date.now();
  const doctor = await call(run, config.cli, ["doctor"], config.timeoutMs);
  if (doctor.timedOut) {
    add("doctor", "warn", `doctor did not finish within ${config.timeoutMs} ms`, beganAt);
  } else if (!Array.isArray(doctor.json?.checks)) {
    add("doctor", "warn", "doctor returned no checks to read", beganAt);
  } else {
    for (const row of doctor.json?.checks as unknown[]) {
      if (!row || typeof row !== "object") continue;
      const entry = row as Record<string, unknown>;
      const name = text(entry.name);
      const ok = boolean(entry.ok);
      if (!name || ok === null) continue;
      add(doctorCheckName(name), ok ? "ok" : "fail", text(entry.detail) ?? (ok ? "healthy" : "failed"), beganAt);
    }
  }

  // 4. Does each configured scope resolve to a bank? A never-written bank 404s (herdr-memory#17), which means
  //    the first memory call a project ever makes cannot succeed.
  for (const scope of config.scopes) {
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
    summary: checks.map((c) => `${c.name}  ${ICON[c.state]}  ${c.detail}  (${c.ms} ms)`).join("\n"),
  };
}
