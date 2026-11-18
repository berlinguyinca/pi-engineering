/**
 * #717 — the memory preflight: "is this host provisioned?" answered before a recall has to fail.
 *
 * Every case here spawns a real executable. The healthy fixture prints the byte-for-byte contracts recorded
 * from the pinned client on 2026-11-18 (`--version`, `validate-config`, `doctor`, `documents`), and the last
 * case runs the same preflight against the real `herdr-memory` when this host has one, so the fixture cannot
 * quietly invent a shape the client does not have. A stubbed runner would hide exactly the class of bug this
 * is about — a check that passes because it never looked.
 *
 * The distinction the whole module exists for: a host that was never provisioned and a host whose read was
 * merely slow are different operator actions, and today's notice text cannot tell them apart. Steady-state
 * recall on this deployment measures 0.28-0.42 s; the cold spike recorded in #673 measured 4.06 s — ~13x
 * apart — so "timed out" alone is not information.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { makeRunner } from "../../src/blackhole/hindsight.ts";
import {
  PREFLIGHT_CHECK_ORDER,
  type PreflightReport,
  runMemoryPreflight,
} from "../../src/blackhole/memoryPreflight.ts";

/** Recorded from the real pinned client (0.1.8, contract 1) on 2026-11-18. */
const VERSION_JSON = '{"client":"0.1.8","contract":1,"harness":"pi"}';
const VALID_CONFIG_JSON = '{"valid":true,"contract":1,"client":"0.1.8"}';
const INVALID_CONFIG_JSON = '{"valid":false,"error":"Invalid or unreadable memory configuration"}';
const DOCTOR_OK_JSON =
  '{"ok":true,"contract":1,"client_version":"0.1.8","project":"pi-engineering","harness":"pi",' +
  '"scopes":["project","global","infra","mission:*"],"server_version":null,"checks":[' +
  '{"name":"credential:project","ok":true,"detail":"readable, private permissions"},' +
  '{"name":"credential:global","ok":true,"detail":"readable, private permissions"},' +
  '{"name":"server","ok":true,"detail":"reachable and credential accepted"},' +
  '{"name":"outbox","ok":true,"detail":"0 pending"},' +
  '{"name":"dead_letter","ok":true,"detail":"0 dead-lettered"}]}';
const DOCTOR_CRED_FAIL_JSON = DOCTOR_OK_JSON.replace(
  '{"name":"credential:project","ok":true,"detail":"readable, private permissions"}',
  '{"name":"credential:project","ok":false,"detail":"credential is world-readable"}',
);
const DOCUMENTS_OK_JSON =
  '{"bank_id":"pi-engineering-facts","scope":"project","documents":[],"total":31,"total_is_estimate":false,"offset":0}';
/** Recorded from a real request against a bank that does not exist (exit 1). */
const NOT_FOUND_JSON = '{"error":"Memory service rejected request (HTTP 404)"}';

const FIXTURE = `#!/bin/sh
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
  doctor)
    if [ "$mode" = "cred_fail" ]; then echo '${DOCTOR_CRED_FAIL_JSON}'; exit 1; fi
    if [ "$mode" = "doctor_rows" ]; then echo '{"ok":true,"checks":[{"ok":true,"detail":"no name"},{"name":"server"},{"name":"server","ok":false,"detail":"unreachable"}]}'; exit 1; fi
    echo '${DOCTOR_OK_JSON}'
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

function fixtureCli(): { dir: string; cli: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-preflight-"));
  const cli = join(dir, "herdr-memory");
  writeFileSync(cli, FIXTURE, { mode: 0o755 });
  chmodSync(cli, 0o755);
  return { dir, cli, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Real subprocess, real parser: the runner is the production one (`makeRunner`), only the executable is a fixture. */
async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FIXTURE_MODE;
  process.env.FIXTURE_MODE = mode;
  try {
    // Awaited inside the scope: the runner reads process.env per spawn, so returning the promise here would
    // restore the environment before the later checks ran and every check after the first would be "healthy".
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_MODE;
    else process.env.FIXTURE_MODE = previous;
  }
}

const names = (report: PreflightReport): string[] => report.checks.map((c) => c.name);
const check = (report: PreflightReport, name: string) => report.checks.find((c) => c.name === name);

test("#673/#717: a provisioned host reports every check ok and no provisioning gap", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("healthy", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
    );
    assert.deepEqual(names(report).slice(0, 2), ["client", "config"]);
    assert.deepEqual(names(report).slice(-1), ["bank:project"]);
    assert.deepEqual(names(report).slice(2, -1), [
      "credentials:project",
      "credentials:global",
      "server",
      "outbox",
      "dead_letter",
    ]);
    assert.equal(report.provisioningGap, false, report.summary);
    assert.equal(check(report, "client")?.state, "ok");
    // The observed version is reported, never asserted against a pin: the pin lives in herdr-engineering,
    // so a hardcoded expectation here would rot and then lie.
    assert.match(String(check(report, "client")?.detail), /0\.1\.8/);
    assert.match(String(check(report, "client")?.detail), /contract 1/);
    assert.equal(check(report, "config")?.state, "ok");
    assert.equal(check(report, "credentials:project")?.state, "ok");
    assert.equal(check(report, "server")?.state, "ok");
    assert.equal(check(report, "bank:project")?.state, "ok");
    assert.match(String(check(report, "bank:project")?.detail), /pi-engineering-facts/);
  } finally {
    cleanup();
  }
});

test("#717: a missing client is the loud answer, and nothing after it is pretended", async () => {
  const report = await runMemoryPreflight({
    cli: "/nonexistent/herdr-memory",
    scopes: ["project", "global"],
    timeoutMs: 1_000,
    harness: "pi",
  });
  assert.equal(report.provisioningGap, true);
  assert.deepEqual(names(report), ["client"]);
  assert.equal(check(report, "client")?.state, "fail");
  // The remedy, not the symptom: this is the one state no amount of retrying fixes.
  assert.match(String(check(report, "client")?.detail), /not installed on this host/);
  assert.match(report.summary, /install the pinned client/);
});

test("#717: an unreadable --version is reported as unreadable, not as a healthy client", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("no_version", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
    );
    assert.equal(report.provisioningGap, true);
    assert.equal(check(report, "client")?.state, "fail");
    assert.match(String(check(report, "client")?.detail), /unreadable/);
  } finally {
    cleanup();
  }
});

test("#717: an invalid or missing client config fails the config check (validate-config is the probe)", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("bad_config", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
    );
    assert.equal(report.provisioningGap, true);
    assert.equal(check(report, "config")?.state, "fail");
    assert.match(String(check(report, "config")?.detail), /Invalid or unreadable memory configuration/);
    // A broken config still gets the credential and bank checks: they are independent gaps (#673 had three).
    assert.ok(names(report).includes("credentials:project"));
    assert.ok(names(report).includes("bank:project"));
  } finally {
    cleanup();
  }
});

test("#717: a credential the doctor refuses is its own failing check", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("cred_fail", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
    );
    assert.equal(report.provisioningGap, true);
    assert.equal(check(report, "credentials:project")?.state, "fail");
    assert.match(String(check(report, "credentials:project")?.detail), /world-readable/);
    assert.equal(check(report, "server")?.state, "ok");
  } finally {
    cleanup();
  }
});

test("#717: a bank that does not exist is named with its remedy, not folded into 'unavailable'", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("missing_bank", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
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
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("slow", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 250, harness: "pi" }),
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
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("wedged", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 250, harness: "pi" }),
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
  const { cli, cleanup } = fixtureCli();
  try {
    // The client check always runs first; the ceiling is already spent by the time the next one is due.
    const report = await withMode("healthy", () =>
      runMemoryPreflight({ cli, scopes: ["project", "global"], timeoutMs: 5_000, deadlineMs: 0, harness: "pi" }),
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

test("#717: a doctor row that cannot be read is skipped, not invented", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("doctor_rows", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
    );
    // Two of the three rows are missing `name` or `ok`; only the complete one becomes a check, once.
    assert.deepEqual(names(report), ["client", "config", "server", "bank:project"]);
    assert.equal(check(report, "server")?.state, "fail");
    assert.equal(report.provisioningGap, true);
  } finally {
    cleanup();
  }
});

test("#717: a bank outside the engineering namespaces is refused, not trusted", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("foreign_bank", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
    );
    assert.equal(check(report, "bank:project")?.state, "warn");
    assert.match(String(check(report, "bank:project")?.detail), /not an engineering memory bank/);
  } finally {
    cleanup();
  }
});

test("#717: unreadable output warns instead of claiming a healthy bank", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("garbage", () =>
      runMemoryPreflight({ cli, scopes: ["project"], timeoutMs: 5_000, harness: "pi" }),
    );
    assert.equal(check(report, "bank:project")?.state, "warn");
    assert.equal(report.provisioningGap, false);
  } finally {
    cleanup();
  }
});

test("#717: the summary is one line per check, in check order", async () => {
  const { cli, cleanup } = fixtureCli();
  try {
    const report = await withMode("healthy", () =>
      runMemoryPreflight({ cli, scopes: ["project", "global"], timeoutMs: 5_000, harness: "pi" }),
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

// The fixture above is only evidence if it matches the real client. This runs the same preflight against the
// real binary when this host has one, so a contract change upstream shows up here rather than in production.
const realCli = process.env.PREFLIGHT_REAL_CLI ?? "herdr-memory";
test(`#717: the same preflight against the real client (${realCli})`, async (t) => {
  const probe = await makeRunner("pi")(realCli, ["--version"], 5_000).catch(() => null);
  if (!probe || probe.exitCode !== 0) {
    t.skip("herdr-memory is not installed on this host (a provisioning gap, see #673)");
    return;
  }
  const report = await runMemoryPreflight({
    cli: realCli,
    scopes: ["project", "global", "infra"],
    timeoutMs: 10_000,
    harness: "pi",
  });
  assert.equal(report.provisioningGap, false, `this host is provisioned; report:\n${report.summary}`);
  assert.deepEqual(names(report).slice(-3), ["bank:project", "bank:global", "bank:infra"]);
  assert.deepEqual(names(report).slice(0, 2), ["client", "config"]);
  assert.deepEqual(PREFLIGHT_CHECK_ORDER.slice(0, 2), ["client", "config"]);
});
