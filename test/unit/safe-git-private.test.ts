/**
 * T16 round 4 (HIGH-1): the shadow config can be edited by a same-user worker that watches /tmp. The shadow now lives
 * in a Pi-private 0700 directory under the state dir (unpredictable names), is read-only while git runs when the
 * command has no business writing there, is verified afterwards (a changed shadow discards the result and logs
 * loudly), and no attribute from the repository can select a driver whatever the shadow config says.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { forgetRemotePinsForTests, safeGit, stateHooks, testHooks } from "../../src/git/safeGit.ts";
import { SWEEP_MAX_AGE_MS, resetSweepForTests, sweepStaleShadows } from "../../src/git/safeGitState.ts";
import { type TelemetryNotice, resetTelemetrySinks, setTelemetrySink } from "../../src/telemetry/sink.ts";

const MODES = ["strict", "operator"] as const;

let root = "";
let events: TelemetryNotice[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-private-"));
  stateHooks.stateRoot = join(root, "state");
  stateHooks.shadowRoot = join(root, "shadows");
  mkdirSync(join(root, "home"));
  events = [];
  setTelemetrySink((e) => events.push(e));
});
afterEach(() => {
  testHooks.afterPlan = undefined;
  stateHooks.stateRoot = undefined;
  stateHooks.shadowRoot = undefined;
  stateHooks.legacyDir = null;
  resetTelemetrySinks();
  forgetRemotePinsForTests();
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  HOME: join(root, "home"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env: env(), stdio: "pipe" }).toString();

function repo() {
  const marks = join(root, "marks");
  mkdirSync(marks, { recursive: true });
  const hook = join(root, "x.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marks}/x-$$'\ncat\n`, { mode: 0o755 });
  sh(
    "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one",
  );
  return { r: join(root, "r"), hook, fired: () => readdirSync(marks) };
}

/** The shadow directory of the call that is about to run (the only entry of the private root). */
const theShadow = (): string => {
  const names = readdirSync(stateHooks.shadowRoot as string);
  assert.equal(names.length, 1, `expected one live shadow, saw ${names.join(",")}`);
  return join(stateHooks.shadowRoot as string, names[0] as string);
};

test("the shadow is created in the private state directory (0700, unpredictable name), never in the shared temp directory", async () => {
  const l = repo();
  let seen = "";
  let parentMode = 0;
  let configMode = 0;
  testHooks.afterPlan = () => {
    seen = theShadow();
    parentMode = lstatSync(stateHooks.shadowRoot as string).mode & 0o777;
    configMode = lstatSync(join(seen, ".git", "config")).mode & 0o777;
  };
  const r = await safeGit(["status", "--porcelain"], { cwd: l.r });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(seen.startsWith(join(root, "shadows")), seen);
  assert.match(seen, /\/s-[A-Za-z0-9]{6}$/);
  assert.equal(parentMode, 0o700);
  assert.equal(configMode, 0o400);
  assert.equal(existsSync(seen), false, "removed afterwards");
  assert.deepEqual(
    readdirSync(tmpdir()).filter(
      (n) => n.startsWith("pi-safegit-") && lstatSync(join(tmpdir(), n)).mtimeMs > Date.now() - 60_000,
    ),
    [],
    "nothing is created in the shared temp directory",
  );
  // the real state directory is checked on every use: too-open permissions are repaired, a symlink in its place is refused
  chmodSync(stateHooks.shadowRoot as string, 0o777);
  assert.equal((await safeGit(["status"], { cwd: l.r })).code, 0);
  assert.equal(lstatSync(stateHooks.shadowRoot as string).mode & 0o777, 0o700);
  rmSync(stateHooks.shadowRoot as string, { recursive: true });
  execFileSync("ln", ["-s", tmpdir(), stateHooks.shadowRoot as string]);
  const refused = await safeGit(["status"], { cwd: l.r });
  assert.equal(refused.code, 128);
  assert.match(refused.stderr, /isolated git view/);
});

test("a command that has no business writing config gets a read-only shadow; config writers keep it writable", async () => {
  const l = repo();
  const modes: Record<string, number> = {};
  for (const args of [
    ["status", "--porcelain"],
    ["config", "user.name", "Z"],
    ["log", "-1"],
    ["remote", "add", "o", "https://example.invalid/x.git"],
  ]) {
    testHooks.afterPlan = () => {
      const sh2 = theShadow();
      modes[args[0] as string] = lstatSync(join(sh2, ".git")).mode & 0o777;
    };
    assert.equal((await safeGit(args, { cwd: l.r })).code, 0, args.join(" "));
  }
  assert.equal(modes.status, 0o500);
  assert.equal(modes.log, 0o500);
  assert.equal(modes.config, 0o700);
  assert.equal(modes.remote, 0o700);
  assert.deepEqual(readdirSync(stateHooks.shadowRoot as string), [], "read-only shadows are still removed");
});

for (const trust of MODES) {
  test(`${trust}: a shadow config edited while git runs (driver, fsmonitor, external diff, hooksPath) runs nothing, discards the result and logs`, async () => {
    const l = repo();
    // the worker's half of the attack: `* filter=e` in the shared info/attributes
    mkdirSync(join(l.r, ".git", "info"), { recursive: true });
    writeFileSync(join(l.r, ".git", "info", "attributes"), "* filter=e diff=e\n");
    const payload = `[filter "e"]\n\tclean = ${l.hook}\n\tsmudge = ${l.hook}\n[core]\n\tfsmonitor = ${l.hook}\n\thooksPath = ${join(root, "hk")}\n[diff]\n\texternal = ${l.hook}\n[diff "e"]\n\ttextconv = ${l.hook}\n`;
    for (const args of [
      ["add", "-A"],
      ["status", "--porcelain"],
      ["diff", "HEAD"],
      ["commit", "--allow-empty", "-m", "q"],
      ["log", "-p", "-1"],
    ]) {
      appendFileSync(join(l.r, "a.txt"), "more\n");
      testHooks.afterPlan = () => {
        const cfg = join(theShadow(), ".git", "config");
        chmodSync(cfg, 0o600); // a same-user worker can; that is why the result is verified
        appendFileSync(cfg, payload);
      };
      const before = readFileSync(join(l.r, ".git", "config"), "utf8");
      events.length = 0;
      const r = await safeGit(args, { cwd: l.r, trust });
      assert.equal(r.code, 128, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /generated config was modified/);
      assert.equal(r.stdout, "", "the result is discarded");
      assert.deepEqual(l.fired(), [], `${args.join(" ")} ran something`);
      assert.equal(
        readFileSync(join(l.r, ".git", "config"), "utf8"),
        before,
        "nothing was copied into the repository config",
      );
      assert.ok(
        events.some((e) => e.level === "error" && e.key === "git-shadow-tampered"),
        "logged loudly",
      );
    }
  });

  test(`${trust}: an edited info/attributes, attributes file or hooks directory in the shadow is detected too`, async () => {
    const l = repo();
    const tamper: Array<[string, (dir: string) => void, RegExp]> = [
      [
        "info/attributes",
        (d) => {
          chmodSync(join(d, ".git", "info"), 0o700);
          chmodSync(join(d, ".git", "info", "attributes"), 0o600);
          writeFileSync(join(d, ".git", "info", "attributes"), "* filter=e\n");
        },
        /info\/attributes/,
      ],
      [
        "attributes file",
        (d) => {
          chmodSync(join(d, "attributes"), 0o600);
          writeFileSync(join(d, "attributes"), "* filter=e\n");
        },
        /attributes file/,
      ],
      [
        "hooks",
        (d) => {
          chmodSync(join(d, ".git", "hooks"), 0o700);
          writeFileSync(join(d, ".git", "hooks", "post-commit"), "#!/bin/sh\n");
        },
        /hook appeared/,
      ],
      [
        "link",
        (d) => {
          chmodSync(join(d, ".git"), 0o700);
          rmSync(join(d, ".git", "refs"));
          execFileSync("ln", ["-s", tmpdir(), join(d, ".git", "refs")]);
        },
        /repointed/,
      ],
    ];
    for (const [name, edit, why] of tamper) {
      testHooks.afterPlan = () => edit(theShadow());
      const r = await safeGit(["status", "--porcelain"], { cwd: l.r, trust });
      assert.equal(r.code, 128, name);
      assert.match(r.stderr, why, name);
    }
  });

  test(`${trust}: no attribute selects a driver: .gitattributes, info/attributes and core.attributesFile, with the drivers defined in a (tampered) config`, async () => {
    const l = repo();
    const globalAttrs = join(root, "global-attributes");
    writeFileSync(globalAttrs, "* filter=e diff=e merge=e\n");
    writeFileSync(join(l.r, ".gitattributes"), "* filter=e diff=e merge=e\n");
    mkdirSync(join(l.r, ".git", "info"), { recursive: true });
    writeFileSync(join(l.r, ".git", "info", "attributes"), "* filter=e diff=e merge=e\n");
    // drivers exist in the REAL config (a worker wrote them); they are not on the allow-list, so the shadow lacks them,
    // and even a shadow that had them could not be selected, because no attribute reaches git
    sh(
      `git config filter.e.clean ${l.hook} && git config filter.e.smudge ${l.hook} && git config diff.e.textconv ${l.hook} && git config core.attributesFile ${globalAttrs}`,
      l.r,
    );
    for (const args of [
      ["add", "-A"],
      ["diff", "HEAD"],
      ["status"],
      ["checkout", "-f", "."],
      ["stash"],
      ["log", "-p", "-1"],
      ["reset", "--hard"],
    ]) {
      appendFileSync(join(l.r, "a.txt"), "more\n");
      await safeGit(args, { cwd: l.r, trust });
    }
    assert.deepEqual(l.fired(), []);
    // control: raw git runs them
    appendFileSync(join(l.r, "a.txt"), "raw\n");
    sh("git add -A", l.r);
    assert.ok(l.fired().length > 0, "control: the setup is live");
  });
}

test("builtin attributes are cut off as well (ident is not expanded), proving GIT_ATTR_SOURCE is in force", async () => {
  const l = repo();
  writeFileSync(join(l.r, ".gitattributes"), "* ident\n");
  writeFileSync(join(l.r, "id.txt"), "$Id$\n");
  sh("git add .gitattributes id.txt && git commit -qm ident && rm id.txt && git checkout -- id.txt", l.r);
  assert.match(readFileSync(join(l.r, "id.txt"), "utf8"), /\$Id: [0-9a-f]{40} \$/, "control: raw git expands ident");
  rmSync(join(l.r, "id.txt"));
  for (const trust of MODES) {
    rmSync(join(l.r, "id.txt"), { force: true });
    const r = await safeGit(["checkout", "--", "id.txt"], { cwd: l.r, trust });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(l.r, "id.txt"), "utf8"), "$Id$\n", trust);
  }
});

test("internal ls-files runs (nested-repo check) cannot start a tampered fsmonitor either", async () => {
  const l = repo();
  // the shadow is edited the instant it exists, i.e. before Pi's own `ls-files --stage` uses it
  testHooks.afterShadow = (shadow) => {
    const cfg = join(shadow, ".git", "config");
    chmodSync(cfg, 0o600);
    appendFileSync(cfg, `[core]\n\tfsmonitor = ${l.hook}\n`);
  };
  try {
    for (const trust of MODES) await safeGit(["add", "-A"], { cwd: l.r, trust });
  } finally {
    testHooks.afterShadow = undefined;
  }
  assert.deepEqual(l.fired(), []);
});

test("sweeper: removes stale shadow directories (ours, old, not live), keeps young and live ones, and cleans legacy /tmp ones", async () => {
  const dir = stateHooks.shadowRoot as string;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  resetSweepForTests(); // the first shadow of a process sweeps once; make this call that first one
  const mk = (name: string, ageMs: number, readOnly = false) => {
    const d = join(dir, name);
    mkdirSync(join(d, ".git", "info"), { recursive: true });
    writeFileSync(join(d, ".git", "config"), "x");
    if (readOnly) {
      chmodSync(join(d, ".git", "info"), 0o500);
      chmodSync(join(d, ".git"), 0o500);
    }
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(d, t, t);
    return d;
  };
  const stale = mk("s-stale1", SWEEP_MAX_AGE_MS + 60_000, true);
  const stale2 = mk("s-stale2", SWEEP_MAX_AGE_MS * 3);
  const young = mk("s-young1", 60_000);
  const notOurs = join(dir, "other-name");
  mkdirSync(notOurs);
  const t = (Date.now() - SWEEP_MAX_AGE_MS * 2) / 1000;
  utimesSync(notOurs, t, t);
  const legacyRoot = mkdtempSync(join(tmpdir(), "safegit-legacy-root-"));
  stateHooks.legacyDir = legacyRoot;
  const legacy = mkdtempSync(join(legacyRoot, "pi-safegit-"));
  utimesSync(legacy, t, t);
  // a live shadow of this process (a call in flight) is never removed, however old its timestamp
  const l = repo();
  let liveSurvived = false;
  let swept = false;
  testHooks.afterPlan = () => {
    swept = !existsSync(stale) && !existsSync(stale2) && !existsSync(legacy); // before any explicit sweep below
    const live = readdirSync(dir).filter(
      (n) => !["s-stale1", "s-stale2", "s-young1", "other-name"].includes(n),
    )[0] as string;
    const p = join(dir, live);
    utimesSync(p, t, t);
    sweepStaleShadows(SWEEP_MAX_AGE_MS);
    liveSurvived = existsSync(p);
  };
  assert.equal((await safeGit(["status"], { cwd: l.r })).code, 0);
  assert.equal(liveSurvived, true);
  // the first shadow of a process sweeps once by itself: the stale ones were removed by that call, not by the sweep below
  assert.equal(swept, true, "the call itself swept the stale directories");
  assert.equal(sweepStaleShadows(SWEEP_MAX_AGE_MS), 0);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(stale2), false);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(notOurs), true, "only s-* directories are touched");
  assert.equal(existsSync(legacy), false, "legacy pi-safegit-* directories in the temp dir are swept too");
  rmSync(legacyRoot, { recursive: true, force: true });
});

test("by default the shadow root is <state root>/safegit/shadow", async () => {
  stateHooks.shadowRoot = undefined;
  const l = repo();
  let seen = "";
  testHooks.afterPlan = () => {
    seen = readdirSync(join(root, "state", "safegit", "shadow")).join(",");
  };
  const r = await safeGit(["status"], { cwd: l.r });
  assert.equal(r.code, 0, r.stderr);
  assert.match(seen, /^s-[A-Za-z0-9]{6}$/);
  assert.equal(lstatSync(join(root, "state", "safegit")).mode & 0o777, 0o700);
});

test("the stderr of a call is bounded before it reaches the caller", async () => {
  const l = repo();
  const r = await safeGit(["checkout", `nosuch-${"x".repeat(5000)}`], { cwd: l.r });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /line truncated/);
  assert.ok(Math.max(...r.stderr.split("\n").map((x) => x.length)) < 1100);
});
