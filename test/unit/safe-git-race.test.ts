/**
 * T16 review round 2 (HIGH 2): the policy is computed from a listing and the command runs afterwards. A worker that
 * flips the shared config in between must not get a driver to run when the attributes already name it, and a change
 * that does slip through is reported, not trusted.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type GitTrust, safeGit, safeGitSync, testHooks } from "../../src/git/safeGit.ts";
import { type TelemetryNotice, resetTelemetrySinks, setTelemetrySink } from "../../src/telemetry/sink.ts";

const RUNS = 200;

afterEach(() => {
  testHooks.afterPlan = undefined;
  resetTelemetrySinks();
});

function lab() {
  const root = mkdtempSync(join(tmpdir(), "safe-git-race-"));
  const marks = join(root, "M");
  mkdirSync(marks);
  const env = { ...process.env, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  mkdirSync(join(root, "home"));
  const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" });
  sh(
    "git init -q -b main prim && cd prim && git config user.name t && git config user.email t@t && echo hi > a.txt && git add . && git commit -qm i && git worktree add -q ../wt -b feat",
  );
  const payload = join(root, "payload");
  writeFileSync(payload, `#!/bin/sh\ntouch '${marks}/p-$$'\ncat\n`);
  chmodSync(payload, 0o755);
  return {
    root,
    marks,
    payload,
    prim: join(root, "prim"),
    wt: join(root, "wt"),
    cfg: join(root, "prim", ".git", "config"),
    info: join(root, "prim", ".git", "info", "attributes"),
    sh,
    hits: () => readdirSync(marks).length,
  };
}

for (const trust of ["strict", "operator"] as GitTrust[]) {
  test(`flip loop (${trust}): attributes name a driver, the config section appears and disappears - ${RUNS} runs, 0 hits`, async () => {
    const l = lab();
    const flipper = spawn(
      "bash",
      [
        "-c",
        `cp ${l.cfg} ${l.root}/good.cfg; cp ${l.cfg} ${l.root}/evil.cfg; printf '[filter "e"]\\n\\tclean = ${l.payload}\\n\\tsmudge = ${l.payload}\\n' >> ${l.root}/evil.cfg; while :; do cp ${l.root}/evil.cfg ${l.cfg}.n && mv ${l.cfg}.n ${l.cfg}; cp ${l.root}/good.cfg ${l.cfg}.n && mv ${l.cfg}.n ${l.cfg}; done`,
      ],
      { stdio: "ignore" },
    );
    try {
      writeFileSync(l.info, "* filter=e\n");
      let tainted = 0;
      for (let i = 0; i < RUNS; i++) {
        appendFileSync(join(l.wt, "a.txt"), "x\n");
        const r = await safeGit(["add", "-A"], { cwd: l.wt, trust, timeoutMs: 120_000 });
        if (/changed while the command ran/.test(r.stderr)) tainted++;
      }
      assert.equal(l.hits(), 0, `the planted driver ran ${l.hits()} time(s) in ${RUNS} runs (${tainted} reported)`);
    } finally {
      flipper.kill("SIGKILL");
      rmSync(l.root, { recursive: true, force: true });
    }
  });
}

test("a driver whose attribute AND section both appear inside the window is reported, and the result is discarded", async () => {
  const l = lab();
  try {
    const notices: TelemetryNotice[] = [];
    setTelemetrySink((n) => notices.push(n));
    appendFileSync(join(l.wt, "a.txt"), "x\n");
    testHooks.afterPlan = () => {
      appendFileSync(l.info, "* filter=late\n");
      appendFileSync(l.cfg, `[filter "late"]\n\tclean = ${l.payload}\n`);
    };
    const r = await safeGit(["add", "-A"], { cwd: l.wt, trust: "strict", timeoutMs: 60_000 });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /changed while the command ran/);
    assert.ok(notices.some((n) => n.level === "error" && n.key === "git-config-changed-during-command"));
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a change that is irrelevant to execution (a new branch setting) is not reported", async () => {
  const l = lab();
  try {
    testHooks.afterPlan = () => {
      appendFileSync(l.cfg, '[branch "x"]\n\tremote = origin\n');
    };
    const r = await safeGit(["status", "--porcelain"], { cwd: l.wt, trust: "strict", timeoutMs: 60_000 });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("the synchronous variant has the same post-command check", () => {
  const l = lab();
  try {
    testHooks.afterPlan = () => {
      appendFileSync(l.cfg, `[filter "late"]\n\tclean = ${l.payload}\n`);
    };
    const r = safeGitSync(["status", "--porcelain"], { cwd: l.wt, trust: "strict", timeoutMs: 20_000 });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /changed while the command ran/);
    copyFileSync(l.cfg, join(l.root, "unused"));
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
