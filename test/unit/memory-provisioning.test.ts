/**
 * #717 — the memory provisioning checks: "is this host provisioned?" answered before a recall has to fail.
 *
 * Every case here spawns a real executable. Two of them, because the question has two halves:
 *   `herdr-memory`  — the client the runtime actually talks to (its version, its config, its bank per scope)
 *   `herdr-eng`     — the provisioning wrapper, whose `memory doctor --json` owns the credential, permission,
 *                     pinned-revision and reachability checks (`src/blackhole/memoryPreflight.ts`)
 * The doctor fixture prints the byte-for-byte schema `parsePreflightPayload` reads, and the last case runs the
 * same checks against the real binaries when this host has them, so a fixture cannot quietly invent a shape
 * either tool does not have. A stubbed runner would hide exactly the class of bug this is about — a check that
 * passes because it never looked.
 *
 * The distinction the module exists for: a host that was never provisioned and a host whose read was merely
 * slow are different operator actions. Steady-state recall here measures 0.28-0.42 s and the cold spike
 * recorded in #673 measured 4.06 s (~13x apart), so "timed out" alone is not information.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { makeRunner } from "../../src/blackhole/hindsightRunner.ts";
import type { PreflightRunner } from "../../src/blackhole/memoryPreflight.ts";
import { runMemoryPreflight } from "../../src/blackhole/memoryPreflight.ts";
import {
  PREFLIGHT_CHECK_ORDER,
  type PreflightReport,
  runProvisioningChecks,
} from "../../src/blackhole/memoryProvisioning.ts";

/** Recorded from the real pinned client (0.1.8, contract 1) on 2026-11-18. */
const VERSION_JSON = '{"client":"0.1.8","contract":1,"harness":"pi"}';
const VALID_CONFIG_JSON = '{"valid":true,"contract":1,"client":"0.1.8"}';
const INVALID_CONFIG_JSON = '{"valid":false,"error":"Invalid or unreadable memory configuration"}';
const DOCUMENTS_OK_JSON =
  '{"bank_id":"pi-engineering-facts","scope":"project","documents":[],"total":31,"total_is_estimate":false,"offset":0}';
/** Recorded from a real request against a bank that does not exist (exit 1). */
const NOT_FOUND_JSON = '{"error":"Memory service rejected request (HTTP 404)"}';

/** The schema `parsePreflightPayload` reads — `status`, never a boolean `ok`, per the doctor contract. */
const DOCTOR_OK_JSON =
  '{"ok":true,"contract":1,"overall":"healthy","client_version":"0.1.8","project":"pi-engineering","harness":"pi",' +
  '"scopes":["project","global","infra","mission:*"],"server_version":null,"checks":[' +
  '{"name":"credential:project","status":"ok","detail":"0600 file in 0700 parent"},' +
  '{"name":"credential:global","status":"ok","detail":"0600 file in 0700 parent"},' +
  '{"name":"pin","status":"ok","detail":"pinned revision matches"},' +
  '{"name":"server","status":"ok","detail":"reachable, credential accepted"},' +
  '{"name":"outbox","status":"ok","detail":"0 pending"}]}';
const DOCTOR_CRED_FAIL_JSON = DOCTOR_OK_JSON.replace(
  '{"name":"credential:project","status":"ok","detail":"0600 file in 0700 parent"}',
  '{"name":"credential:project","status":"fail","detail":"credential is world-readable"}',
);

const CLIENT_FIXTURE = `#!/bin/sh
# Emits the recorded herdr-memory contracts. FIXTURE_MODE picks the state under test.
mode=\${FIXTURE_MODE:-healthy}
case "$1" in
  --version)
    [ "$mode" = "no_version" ] && { echo "not json at all"; exit 0; }
    [ "$mode" = "wedged" ] && sleep 2
    echo '${VERSION_JSON}'
    exit 0
    ;;
  validate-config)
    if [ "$mode" = "bad_config" ]; then echo '${INVALID_CONFIG_JSON}'; exit 1; fi
    echo '${VALID_CONFIG_JSON}'
    exit 0
    ;;
  documents)
    case "$mode" in
      missing_bank) echo '${NOT_FOUND_JSON}'; exit 1 ;;
      slow) sleep 2; echo '${DOCUMENTS_OK_JSON}'; exit 0 ;;
      foreign_bank) echo '{"bank_id":"personal-notes","scope":"project","documents":[],"total":1,"offset":0}'; exit 0 ;;
      garbage) echo 'not json'; exit 0 ;;
    esac
    echo '${DOCUMENTS_OK_JSON}'
    exit 0
    ;;
esac
echo '{}'; exit 0
`;

/** `herdr-eng memory doctor --json` — argument order as `doctorArgs()` builds it, output as doctor ships it. */
const ENG_FIXTURE = `#!/bin/sh
# FIXTURE_ENG picks the state under test for the host-side half.
mode=\${FIXTURE_ENG:-healthy}
[ "$1" = "memory" ] && [ "$2" = "doctor" ] && [ "$3" = "--json" ] || { echo "unexpected args: $*" >&2; exit 64; }
case "$mode" in
  missing) exit 127 ;;
  garbage) echo 'doctor said this in prose'; exit 1 ;;
  wedged)  sleep 2 ;;
  rows)    echo '{"ok":true,"checks":[{"status":"ok","detail":"no name"},{"name":"server","status":"fail","detail":"connection refused"}]}'; exit 1 ;;
  warn)    echo '{"ok":true,"overall":"warn","checks":[{"name":"package_revision","status":"warn","detail":"herdr-memory f3a20bae5fb9 != pin d48b334b6236"}]}'; exit 0 ;;
  unknown) echo '{"ok":false,"overall":"degraded","checks":[{"name":"credential:project","status":"unknown","detail":"doctor could not read the file"}]}'; exit 1 ;;
  # Exactly one check declines to answer, measured on a real host 2026-11-18: every other check is ok and
  # fleet_update has no state file because no unattended updater has run here. Recorded from
  # doctor's own --json output, verbatim apart from the surrounding checks.
  one_unknown) echo '{"ok":true,"contract":1,"overall":"healthy","checks":[{"name":"credential:project","status":"ok","detail":"0600 file in 0700 parent"},{"name":"pin","status":"ok","detail":"pinned revision matches"},{"name":"fleet_update","status":"unknown","detail":"no unattended fleet update has recorded a run"},{"name":"server","status":"ok","detail":"reachable, credential accepted"}]}'; exit 0 ;;
  cred_fail) echo '${DOCTOR_CRED_FAIL_JSON}'; exit 1 ;;
esac
echo '${DOCTOR_OK_JSON}'
exit 0
`;

interface Fixture {
  cli: string;
  engCli: string;
  cleanup: () => void;
}

function fixtures(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-provisioning-"));
  const cli = join(dir, "herdr-memory");
  const engCli = join(dir, "herdr-eng");
  writeFileSync(cli, CLIENT_FIXTURE, { mode: 0o755 });
  chmodSync(cli, 0o755);
  writeFileSync(engCli, ENG_FIXTURE, { mode: 0o755 });
  chmodSync(engCli, 0o755);
  return { cli, engCli, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The host-side half, through the production parser and a real spawn — only the executable is a fixture.
 * `engCli: null` stands in for a host that has the client but not the provisioning wrapper.
 */
function doctorVia(engCli: string | null): {
  doctor: NonNullable<Parameters<typeof runProvisioningChecks>[0]["doctor"]>;
} {
  if (engCli === null) {
    return {
      doctor: (opts) =>
        runMemoryPreflight({
          ...opts,
          runner: () => Promise.reject(Object.assign(new Error("nope"), { code: "ENOENT" })),
        }),
    };
  }
  const runner: PreflightRunner = (args, timeoutMs) => makeRunner("pi")(engCli, args, timeoutMs);
  return { doctor: (opts) => runMemoryPreflight({ ...opts, runner }) };
}

/** Real subprocesses, real parsers: the runner is the production one, only the executables are fixtures. */
async function withModes<T>(mode: string, eng: string, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env.FIXTURE_MODE;
  const prevEng = process.env.FIXTURE_ENG;
  process.env.FIXTURE_MODE = mode;
  process.env.FIXTURE_ENG = eng;
  try {
    // Awaited inside the scope: the runners read process.env per spawn, so returning the promise here would
    // restore the environment before the later checks ran.
    return await fn();
  } finally {
    if (prevMode === undefined) delete process.env.FIXTURE_MODE;
    else process.env.FIXTURE_MODE = prevMode;
    if (prevEng === undefined) delete process.env.FIXTURE_ENG;
    else process.env.FIXTURE_ENG = prevEng;
  }
}

const names = (report: PreflightReport): string[] => report.checks.map((c) => c.name);
const check = (report: PreflightReport, name: string) => report.checks.find((c) => c.name === name);

test("#673/#717: a provisioned host reports every check ok and no provisioning gap", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.deepEqual(names(report).slice(0, 2), ["client", "config"]);
    assert.deepEqual(names(report).slice(-1), ["bank:project"]);
    // The doctor's own check names, verbatim — the same names `/engineering version` prints.
    assert.deepEqual(names(report).slice(2, -1), [
      "credential:project",
      "credential:global",
      "pin",
      "server",
      "outbox",
    ]);
    assert.equal(report.provisioningGap, false, report.summary);
    assert.equal(check(report, "client")?.state, "ok");
    // The observed version is reported, never asserted against a pin: the pin lives in herdr-engineering,
    // so a hardcoded expectation here would rot and then lie.
    assert.match(String(check(report, "client")?.detail), /0\.1\.8/);
    assert.match(String(check(report, "client")?.detail), /contract 1/);
    assert.equal(check(report, "config")?.state, "ok");
    assert.equal(check(report, "credential:project")?.state, "ok");
    assert.equal(check(report, "server")?.state, "ok");
    assert.equal(check(report, "bank:project")?.state, "ok");
    assert.match(String(check(report, "bank:project")?.detail), /pi-engineering-facts/);
  } finally {
    cleanup();
  }
});

test("#717: a missing client is the loud answer, and nothing after it is pretended", async () => {
  const { engCli, cleanup } = fixtures();
  try {
    const report = await runProvisioningChecks({
      cli: "/nonexistent/herdr-memory",
      scopes: ["project", "global"],
      timeoutMs: 1_000,
      harness: "pi",
      ...doctorVia(engCli),
    });
    assert.equal(report.provisioningGap, true);
    assert.deepEqual(names(report), ["client"]);
    assert.equal(check(report, "client")?.state, "fail");
    // The remedy, not the symptom: this is the one state no amount of retrying fixes.
    assert.match(String(check(report, "client")?.detail), /not installed on this host/);
    assert.match(report.summary, /install the pinned client/);
  } finally {
    cleanup();
  }
});

test("#717: an unreadable --version is reported as unreadable, not as a healthy client", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("no_version", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(report.provisioningGap, true);
    assert.equal(check(report, "client")?.state, "fail");
    assert.match(String(check(report, "client")?.detail), /unreadable/);
  } finally {
    cleanup();
  }
});

test("#717: an invalid or missing client config fails the config check (validate-config is the probe)", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("bad_config", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(report.provisioningGap, true);
    assert.equal(check(report, "config")?.state, "fail");
    assert.match(String(check(report, "config")?.detail), /Invalid or unreadable memory configuration/);
    // A broken config still gets the credential and bank checks: they are independent gaps (#673 had three).
    assert.ok(names(report).includes("credential:project"));
    assert.ok(names(report).includes("bank:project"));
  } finally {
    cleanup();
  }
});

test("#717: a credential doctor refuses is its own failing check", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "cred_fail", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(report.provisioningGap, true);
    assert.equal(check(report, "credential:project")?.state, "fail");
    assert.match(String(check(report, "credential:project")?.detail), /world-readable/);
    assert.equal(check(report, "server")?.state, "ok");
  } finally {
    cleanup();
  }
});

/**
 * The wrapper and the client are separate installs. A host can have `herdr-memory` working and no `herdr-eng`:
 * memory is provisioned, the credential checks simply did not run. Failing here would send the operator to
 * install a client that is already installed — the exact mistake this module exists to stop.
 */
test("#717: a host with the client but without the doctor wrapper warns instead of claiming a gap", async () => {
  const { cli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(null) }),
    );
    assert.equal(report.provisioningGap, false, "the client is installed and its config is valid");
    assert.equal(report.inconclusive, false, "the client-side checks did answer");
    assert.equal(check(report, "doctor")?.state, "warn");
    assert.match(String(check(report, "doctor")?.detail), /could not run/);
    assert.ok(names(report).includes("bank:project"), "the bank check still runs");
  } finally {
    cleanup();
  }
});

/** Same for a doctor that answers in prose: unreadable output is "I could not tell", never "not provisioned". */
test("#717: a doctor whose output cannot be parsed warns instead of claiming a gap", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "garbage", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(report.provisioningGap, false);
    assert.equal(check(report, "doctor")?.state, "warn");
  } finally {
    cleanup();
  }
});

test("#717: a bank that does not exist is named with its remedy, not folded into 'unavailable'", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("missing_bank", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(report.provisioningGap, true);
    assert.equal(check(report, "bank:project")?.state, "fail");
    // herdr-memory#17: recall 404s on a never-written bank, so the first call a project ever makes cannot
    // succeed. The detail has to carry the PUT that fixes it.
    assert.match(String(check(report, "bank:project")?.detail), /bank .*does not exist/);
    assert.match(String(check(report, "bank:project")?.detail), /PUT \/v1\/default\/banks\//);
  } finally {
    cleanup();
  }
});

test("#717: a slow read is a warning, never a provisioning gap", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("slow", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 250, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(check(report, "bank:project")?.state, "warn");
    assert.equal(report.provisioningGap, false, "a slow host is provisioned; the notice must not say otherwise");
    assert.equal(report.inconclusive, false, "the other checks did answer, so the report is not empty of evidence");
    assert.match(String(check(report, "bank:project")?.detail), /slow|timed out/);
  } finally {
    cleanup();
  }
});

/**
 * The third state, which is the one an absent-minded report gets wrong in the other direction: a client that
 * will not answer `--version` is present but wedged, so "install the client" is wrong, and "everything is
 * fine" is equally wrong. Nothing was proved, and the report has to say that.
 */
test("#717: a client that will not answer --version is inconclusive, not unprovisioned", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("wedged", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 250, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(report.provisioningGap, false, "the binary is there; sending the operator to install it is a lie");
    assert.equal(report.inconclusive, true, "and the absence of a failure is not a clean bill of health either");
    // Nothing after it is pretended: every later check would report the same unresponsive client.
    assert.deepEqual(names(report), ["client"]);
    assert.equal(check(report, "client")?.state, "warn");
    assert.match(String(check(report, "client")?.detail), /not answering/);
  } finally {
    cleanup();
  }
});

test("#717: a ceiling reached mid-run is reported as a check that learned nothing", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    // The client check always runs first; the ceiling is already spent by the time the next one is due.
    const report = await withModes("healthy", "healthy", () =>
      runProvisioningChecks({
        cli,
        scopes: ["project", "global"],
        timeoutMs: 5_000,
        deadlineMs: 0,
        harness: "pi",
        ...doctorVia(engCli),
      }),
    );
    assert.deepEqual(names(report), ["client", "budget"]);
    assert.equal(check(report, "budget")?.state, "warn");
    assert.match(String(check(report, "budget")?.detail), /did not run learned nothing/);
    // The client did answer, so this is not "nothing proved" — but it is not a provisioning verdict either.
    assert.equal(report.provisioningGap, false);
    assert.equal(report.inconclusive, false);
  } finally {
    cleanup();
  }
});

/**
 * Doctor's payload is read whole or not at all (`parseDoctorJson` returns null if any row lacks a name), so a
 * malformed report becomes one `doctor` line saying it could not be consulted. Inventing per-row checks from a
 * payload the parser refused would be reading meaning out of bytes that failed to parse.
 */
test("#717: a doctor payload that cannot be read becomes one unavailable line, not invented rows", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "rows", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.deepEqual(names(report), ["client", "config", "doctor", "bank:project"]);
    assert.equal(check(report, "doctor")?.state, "warn");
    assert.match(String(check(report, "doctor")?.detail), /could not run/);
    assert.equal(report.provisioningGap, false, "unreadable output is not evidence that the host is unprovisioned");
    assert.equal(report.inconclusive, false, "the client-side checks still answered");
  } finally {
    cleanup();
  }
});

/** Doctor's `warn` is "not what was expected", not "broken" — it must never become a provisioning gap. */
test("#717: a doctor warning is reported as a warning", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "warn", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(check(report, "package_revision")?.state, "warn");
    assert.equal(report.provisioningGap, false, "a drifted revision is not a host that was never provisioned");
  } finally {
    cleanup();
  }
});

/** `unknown` is doctor declining to answer. Counting it as a gap would be the same mistake in a new costume. */
test("#717: a doctor check that says unknown is neither healthy nor unprovisioned", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "unknown", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    // #728: doctor's `unknown` is its own answer. Folding it into `warn` told operators to go reconcile
    // drift when the honest statement was that the check learned nothing.
    assert.equal(check(report, "credential:project")?.state, "unknown");
    assert.equal(report.provisioningGap, false);
    assert.equal(report.inconclusive, false, "the client-side checks still answered");
  } finally {
    cleanup();
  }
});

test("#728: one check reporting no data is not drift, and is not counted as answered", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "one_unknown", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    const fleet = check(report, "fleet_update");
    assert.equal(fleet?.state, "unknown", "doctor's vocabulary is four-valued; the ingestion must not collapse it");
    assert.match(String(fleet?.detail), /no unattended fleet update has recorded a run/);
    // The two verdicts an operator acts on stay untouched by a check that declined to answer.
    assert.equal(report.provisioningGap, false, "no data is not evidence of a gap");
    assert.equal(report.inconclusive, false, "the other checks did answer, so the report is not empty of proof");
    // Rendered distinctly, in the same column, so `n/a` cannot be read as `warn` or as `ok`.
    assert.match(report.summary, /fleet_update\s+n\/a\s+no unattended fleet update has recorded a run/);
    assert.doesNotMatch(report.summary, /fleet_update\s+warn/);
    assert.equal(check(report, "server")?.state, "ok");
    assert.equal(check(report, "pin")?.state, "ok");
  } finally {
    cleanup();
  }
});

test("#717: a bank outside the engineering namespaces is refused, not trusted", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("foreign_bank", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(check(report, "bank:project")?.state, "warn");
    assert.match(String(check(report, "bank:project")?.detail), /not an engineering memory bank/);
  } finally {
    cleanup();
  }
});

test("#717: unreadable output warns instead of claiming a healthy bank", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("garbage", "healthy", () =>
      runProvisioningChecks({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi", ...doctorVia(engCli) }),
    );
    assert.equal(check(report, "bank:project")?.state, "warn");
    assert.equal(report.provisioningGap, false);
  } finally {
    cleanup();
  }
});

test("#717: the summary is one line per check, in check order", async () => {
  const { cli, engCli, cleanup } = fixtures();
  try {
    const report = await withModes("healthy", "healthy", () =>
      runProvisioningChecks({
        cli,
        scopes: ["project", "global"],
        timeoutMs: 5_000,
        harness: "pi",
        ...doctorVia(engCli),
      }),
    );
    const lines = report.summary.split("\n");
    assert.equal(lines.length, report.checks.length);
    assert.match(lines[0] ?? "", /^client\b/);
    assert.match(lines[lines.length - 1] ?? "", /^bank:global\b/);
    assert.ok(
      report.checks.every((c) => c.ms >= 0),
      "every check reports what it cost",
    );
  } finally {
    cleanup();
  }
});

// The fixtures above are only evidence if they match the real tools. This runs the same checks against the real
// binaries when this host has them, so a contract change upstream shows up here rather than in production.
const realCli = process.env.PREFLIGHT_REAL_CLI ?? "herdr-memory";
test(`#717: the same checks against the real client (${realCli})`, async (t) => {
  const probe = await makeRunner("pi")(realCli, ["--version"], 5_000).catch(() => null);
  if (!probe || probe.exitCode !== 0) {
    t.skip("herdr-memory is not installed on this host (a provisioning gap, see #673)");
    return;
  }
  const report = await runProvisioningChecks({
    cli: realCli,
    scopes: ["project", "global", "infra"],
    timeoutMs: 10_000,
    harness: "pi",
  });
  // The contract this test guards is that the real tools answer in the shape the parser reads, and that every
  // half of the report really ran. It is deliberately NOT "this host is green": `fleet_update` reports the
  // state of an unattended fleet updater this repository does not own, and on 2026-11-19 its absence turned
  // this unit test red on a host where memory itself was provisioned and healthy. Asserting on state another
  // repo owns makes a unit test a fleet-status monitor; the state is printed instead, so it stays visible.
  const outsideProvisioning = report.checks.filter(
    (c) => c.name === "fleet_update" || c.name === "package_revision" || c.name === "client_version",
  );
  const gaps = report.checks.filter((c) => c.state === "fail" && !outsideProvisioning.some((o) => o.name === c.name));
  assert.deepEqual(
    gaps.map((c) => `${c.name}: ${c.detail}`),
    [],
    `this host's memory is provisioned; report:\n${report.summary}`,
  );
  for (const check of outsideProvisioning) {
    if (check.state !== "ok") console.log(`note: ${check.name} is ${check.state} — ${check.detail}`);
  }
  assert.deepEqual(names(report).slice(-3), ["bank:project", "bank:global", "bank:infra"]);
  assert.deepEqual(names(report).slice(0, 2), ["client", "config"]);
  // The host-side half really ran (this host has herdr-eng), so the report is not client-only by accident.
  assert.ok(names(report).includes("server"), report.summary);
  assert.ok(
    names(report).some((n) => n.startsWith("credential:")),
    report.summary,
  );
  assert.deepEqual(PREFLIGHT_CHECK_ORDER.slice(0, 2), ["client", "config"]);
});
