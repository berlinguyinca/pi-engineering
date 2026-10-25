/**
 * T16 round 3: there is no window to race. Git reads a GENERATED config (an allow-list copy taken once), so a worker
 * that rewrites the shared `.git/config`, adds attribute files (tracked, ignored, in a sub-directory, in
 * info/attributes, through core.attributesFile) or any of them at any moment between safeGit's snapshot and the end of
 * the command changes nothing for that command. The loops below run 400 iterations per mode and case against a
 * flipper process that rewrites the config atomically as fast as it can; the control proves the same flip does run
 * the payload under raw git.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type GitTrust, safeGit, safeGitSync, testHooks } from "../../src/git/safeGit.ts";
import { resetTelemetrySinks } from "../../src/telemetry/sink.ts";

const RUNS = 400;

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
    "git init -q -b main prim && cd prim && git config user.name t && git config user.email t@t && mkdir -p sub/deep && echo hi > a.txt && echo s > sub/deep/s.txt && git add . && git commit -qm i && git worktree add -q ../wt -b feat",
  );
  const payload = join(root, "payload");
  writeFileSync(payload, `#!/bin/sh\ntouch '${marks}/p-$$'\ncat\n`);
  chmodSync(payload, 0o755);
  const attrFile = join(root, "extra.attributes");
  writeFileSync(attrFile, "* filter=e diff=e merge=e\n");
  return {
    root,
    marks,
    payload,
    attrFile,
    prim: join(root, "prim"),
    wt: join(root, "wt"),
    cfg: join(root, "prim", ".git", "config"),
    info: join(root, "prim", ".git", "info", "attributes"),
    sh,
    env,
    hits: () => readdirSync(marks).length,
    clear: () => {
      for (const n of readdirSync(marks)) rmSync(join(marks, n));
    },
  };
}
type Lab = ReturnType<typeof lab>;

/** Atomically alternates the shared config between its good state and one with the planted sections. */
function flipper(l: Lab, evilExtra: string) {
  return spawn(
    "bash",
    [
      "-c",
      `cp ${l.cfg} ${l.root}/good.cfg; cp ${l.cfg} ${l.root}/evil.cfg; printf '%s' '${evilExtra}' >> ${l.root}/evil.cfg; while :; do cp ${l.root}/evil.cfg ${l.cfg}.n && mv ${l.cfg}.n ${l.cfg}; cp ${l.root}/good.cfg ${l.cfg}.n && mv ${l.cfg}.n ${l.cfg}; done`,
    ],
    { stdio: "ignore" },
  );
}

/** Kill the flipper and wait until it is really gone, so it cannot recreate files while the lab is removed. */
async function stop(f: ReturnType<typeof flipper>, l: Lab): Promise<void> {
  const gone = new Promise<void>((done) => f.once("close", () => done()));
  f.kill("SIGKILL");
  await gone;
  rmSync(l.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const planted = (l: Lab) =>
  `[filter "e"]\n\tclean = ${l.payload}\n\tsmudge = ${l.payload}\n[diff "e"]\n\ttextconv = ${l.payload}\n[merge "e"]\n\tdriver = ${l.payload} %O %A %B\n[core]\n\tfsmonitor = ${l.payload}\n\tattributesFile = ${l.attrFile}\n`;

interface Case {
  name: string;
  setup(l: Lab): void;
  command(l: Lab, i: number): string[];
}

const CASES: Case[] = [
  {
    name: "info/attributes names the driver, the config section flips",
    setup: (l) => writeFileSync(l.info, "* filter=e diff=e\n"),
    command: () => ["add", "-A"],
  },
  {
    name: "an IGNORED sub-directory .gitattributes names the driver, the config section flips",
    setup: (l) => {
      writeFileSync(join(l.wt, ".gitignore"), "sub/deep/.gitattributes\n");
      writeFileSync(join(l.wt, "sub", "deep", ".gitattributes"), "* filter=e diff=e\n");
    },
    command: () => ["add", "-A"],
  },
  {
    name: "core.attributesFile flips in with its driver sections (no attribute file in the tree at all)",
    setup: () => {},
    command: () => ["add", "-A"],
  },
  {
    name: "status and diff read the work tree through whatever flips",
    setup: (l) => writeFileSync(l.info, "* filter=e diff=e\n"),
    command: (_l, i) => (i % 2 === 0 ? ["status", "--porcelain"] : ["diff", "HEAD"]),
  },
];

for (const trust of ["strict", "operator"] as GitTrust[]) {
  for (const c of CASES) {
    test(`flip loop (${trust}): ${c.name} - ${RUNS} runs, 0 hits`, async () => {
      const l = lab();
      const f = flipper(l, planted(l));
      try {
        c.setup(l);
        for (let i = 0; i < RUNS; i++) {
          appendFileSync(join(l.wt, "a.txt"), "x\n");
          await safeGit(c.command(l, i), { cwd: l.wt, trust, timeoutMs: 120_000 });
        }
        assert.equal(l.hits(), 0, `the planted driver ran ${l.hits()} time(s) in ${RUNS} runs`);
      } finally {
        await stop(f, l);
      }
    });
  }
}

test("control: the same flip does run the payload under raw git, so a 0 above is not a broken flipper", async () => {
  const l = lab();
  const f = flipper(l, planted(l));
  try {
    writeFileSync(l.info, "* filter=e diff=e\n");
    for (let i = 0; i < 100 && l.hits() === 0; i++) {
      appendFileSync(join(l.wt, "a.txt"), "x\n");
      await new Promise<void>((done) => {
        const p = spawn("git", ["add", "-A"], { cwd: l.wt, env: l.env, stdio: "ignore" });
        p.on("close", () => done());
      });
    }
    assert.ok(l.hits() > 0, "raw git never ran the payload in 100 tries: the flipper is not racing");
  } finally {
    await stop(f, l);
  }
});

test("everything planted INSIDE the window (after the snapshot, before the command) is not seen by the command, async and sync", async () => {
  const l = lab();
  try {
    const plant = () => {
      appendFileSync(l.info, "* filter=e diff=e merge=e\n");
      appendFileSync(l.cfg, planted(l));
      writeFileSync(join(l.wt, ".gitattributes"), "* filter=e\n");
      writeFileSync(join(l.wt, ".lfsconfig"), "[lfs]\n\turl = http://127.0.0.1:9/lfs\n");
    };
    for (const trust of ["strict", "operator"] as GitTrust[]) {
      l.clear();
      appendFileSync(join(l.wt, "a.txt"), `x ${trust}\n`);
      testHooks.afterPlan = plant;
      const r = await safeGit(["add", "-A"], { cwd: l.wt, trust, timeoutMs: 60_000 });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(l.hits(), 0, `${trust}: the command ran what was planted after its snapshot`);
      // restore for the next round
      rmSync(l.info);
      writeFileSync(l.info, "");
      writeFileSync(l.cfg, GOOD_CONFIG);
      rmSync(join(l.wt, ".gitattributes"), { force: true });
      testHooks.afterPlan = undefined;
    }
    appendFileSync(join(l.wt, "a.txt"), "sync\n");
    testHooks.afterPlan = plant;
    const s = safeGitSync(["add", "-A"], { cwd: l.wt, trust: "strict", timeoutMs: 60_000 });
    assert.equal(s.code, 0, s.stderr);
    assert.equal(l.hits(), 0, "sync variant");
    // control: with the same plant already in place, raw git runs the payload
    appendFileSync(join(l.wt, "a.txt"), "raw\n");
    try {
      execFileSync("git", ["add", "-A"], { cwd: l.wt, env: l.env, stdio: "pipe" });
    } catch {
      /* a payload exiting non-zero */
    }
    assert.ok(l.hits() > 0, "control: raw git must run the planted payload");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

/** The config without the planted sections (good state), for re-arming the window test. */
const GOOD_CONFIG =
  "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[user]\n\tname = t\n\temail = t@t\n";
