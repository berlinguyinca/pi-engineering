/**
 * `/engineering update` against REAL git sources (spec §11-§17, §39, §40, §46,
 * §47, §55, §56): a local bare repository is the remote, an upstream clone
 * publishes releases, and Pi runs from a clone of it. A real Pi session, real
 * staging, a real validation probe process, real activation.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EngineeringHostExtension, parseUpdateArgs } from "../../src/runtime/host/extension.ts";
import { readPreferences } from "../../src/update/preferences.ts";
import { createUpdateRepo, escapingSymlink, git, publishUnrelatedHistory } from "../support/gitRemote.ts";
import { type PiTestSession, startPiSession } from "../support/piSession.ts";
import { bag } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

let seq = 0;
async function world(opts: { updateRemote?: string; trusted?: string[] } = {}) {
  const key = `__rt_git_${process.pid}_${++seq}`;
  const b = bag(key);
  const root = mkdtempSync(join(tmpdir(), "rt-git-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = createUpdateRepo(join(root, "src"), key, { version: "0.2.0", value: "A" });
  const ext = new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: repo.checkout,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
    ...(opts.updateRemote ? { updateRemote: opts.updateRemote } : {}),
    ...(opts.trusted ? { trustedRemotes: opts.trusted } : {}),
  });
  const pi: PiTestSession = await startPiSession({ factories: [(api: never) => ext.install(api)] });
  cleanups.push(() => pi.close());
  const host = ext.host as NonNullable<typeof ext.host>;
  const settle = async () => {
    b.values.length = 0;
    await pi.emit({ type: "agent_settled" });
    return b.values.at(-1);
  };
  return { key, b, root, repo, ext, pi, host, settle };
}

/** A fingerprint of everything an update must not touch before activation. */
function fingerprint(dir: string): string {
  if (!existsSync(dir)) return "absent";
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (["cache", "telemetry", "generations"].includes(name) && d === dir) continue;
      const full = join(d, name);
      const st = statSync(full, { throwIfNoEntry: false });
      out.push(`${full.slice(dir.length)}:${st?.isDirectory() ? "d" : (st?.size ?? "?")}`);
      if (st?.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.join("\n");
}

async function update(w: Awaited<ReturnType<typeof world>>, args: string) {
  await w.pi.run(`/engineering update ${args}`.trim());
  const outcome = w.ext.lastUpdateOutcome;
  if (outcome?.status === "handover") await outcome.done;
  return outcome;
}

test("parseUpdateArgs: strict flags and values", () => {
  assert.deepEqual(parseUpdateArgs(["--check", "--channel", "stable"]), {
    ok: true,
    check: true,
    request: { channel: "stable" },
  });
  assert.equal(parseUpdateArgs(["--channel", "nightly"]).ok, false);
  assert.equal(parseUpdateArgs(["--commit", "abc;rm -rf"]).ok, false);
  assert.equal(parseUpdateArgs(["--commit", "abcdef1", "--channel", "main"]).ok, false);
  assert.equal(parseUpdateArgs(["--yolo"]).ok, false);
});

test("--check reports the available version and mutates nothing (§13)", async () => {
  const w = await world();
  const b2 = w.repo.publish({ version: "0.2.1", value: "B" });
  const before = fingerprint(w.ext.layout.root);
  const check = await w.ext.updates.check({});
  assert.equal(check.failure, undefined);
  assert.equal(check.current?.version, "0.2.0");
  assert.equal(check.target?.metadata.version, "0.2.1");
  assert.equal(check.target?.sha, b2);
  assert.equal(check.upToDate, false);
  assert.equal(check.pi.ok, true);
  assert.equal(check.migration, "none");
  await w.pi.run("/engineering update --check");
  assert.equal(fingerprint(w.ext.layout.root), before, "no versions, pointers, journal or staging written");
  assert.equal(w.ext.journal.read(), null);
  assert.equal(await w.settle(), "A");
});

test("update (main): staged, validated, activated, same Pi session; then up to date; --force reloads (§11, §39)", async () => {
  const w = await world();
  const session = w.pi.session;
  const sha = w.repo.publish({ version: "0.2.1", value: "B" });
  const outcome = await update(w, "");
  assert.equal(outcome?.status, "handover", JSON.stringify(outcome));
  assert.equal(w.host.lastHandover?.ok, true, w.host.lastHandover?.failure);
  assert.equal(await w.settle(), "B");
  assert.equal(w.pi.session, session);
  const current = w.ext.layout.readPointer("current") as string;
  assert.match(current, /versions\/0\.2\.1-/);
  assert.equal(w.ext.layout.readMeta(current)?.commit, sha);
  const journal = w.ext.journal.read();
  assert.ok(journal && journal !== "corrupt");
  assert.equal(journal.phase, "committed");
  assert.equal(journal.toCommit, sha);
  const events = w.ext.telemetry.recent(200).map((e) => e.event);
  for (const e of [
    "runtime.update.started",
    "runtime.update.fetched",
    "runtime.update.staged",
    "runtime.update.validated",
    "runtime.safe_point.reached",
    "runtime.activation.started",
    "runtime.activation.completed",
    "runtime.health.passed",
    "runtime.update.committed",
  ]) {
    assert.ok(events.includes(e as never), `${e} emitted`);
  }

  const again = await update(w, "");
  assert.equal(again?.status, "up_to_date");
  const gen = w.host.activeGeneration()?.generation as number;
  const forced = await update(w, "--force");
  assert.equal(forced?.status, "handover");
  assert.equal(w.host.activeGeneration()?.generation, gen + 1, "--force re-staged and reloaded the same version");
  assert.equal(await w.settle(), "B");
});

test("stable follows release tags; --channel is remembered, --commit is one-off (§12)", async () => {
  const w = await world();
  w.repo.tag("v0.2.0");
  const b = w.repo.publish({ version: "0.2.1", value: "B" });
  const stable = await w.ext.updates.check({ channel: "stable" });
  assert.equal(stable.target?.metadata.version, "0.2.0", "untagged main is not stable");
  w.repo.tag("v0.2.1");
  w.repo.tag("v0.10.0", b);
  w.repo.tag("not-a-release");
  const stable2 = await w.ext.updates.check({ channel: "stable" });
  assert.equal(stable2.target?.sha, b, "highest semver tag (v0.10.0 > v0.2.1)");

  const first = git(w.repo.upstream, "rev-list", "--max-parents=0", "HEAD");
  const c = w.repo.publish({ version: "0.3.0", value: "C" });
  assert.equal((await update(w, "--channel stable"))?.status, "handover");
  assert.equal(readPreferences(w.ext.layout.preferencesFile).channel, "stable");
  assert.equal(await w.settle(), "B");
  assert.equal((await update(w, `--commit ${c.slice(0, 10)}`))?.status, "handover");
  assert.equal(await w.settle(), "C");
  assert.equal(readPreferences(w.ext.layout.preferencesFile).channel, "stable", "a commit pin is one-off");
  const bogus = await update(w, "--commit deadbeefdeadbeef");
  assert.equal(bogus?.status, "failed");
  assert.match(bogus?.status === "failed" ? bogus.reason : "", /not on the update source/);
  assert.equal(await w.settle(), "C");
  assert.ok(first);
});

test("dirty development checkout: update refused, reload still works and loads the edit (§40, §56)", async () => {
  const w = await world();
  w.repo.publish({ version: "0.2.1", value: "B" });
  writeFileSync(join(w.repo.checkout, "dep.ts"), 'export const VALUE: string = "LOCAL-EDIT";\n');
  const outcome = await update(w, "");
  assert.equal(outcome?.status, "refused");
  assert.match(outcome?.status === "refused" ? outcome.reason : "", /uncommitted changes.\nAutomatic update refused/);
  assert.equal(w.ext.layout.readPointer("current"), null, "nothing activated");
  await w.pi.run("/engineering reload");
  assert.equal(w.host.lastHandover?.ok, true);
  assert.equal(await w.settle(), "LOCAL-EDIT");
});

test("Pi incompatibility: candidate staged, activation refused, current untouched (§17, §55)", async () => {
  const w = await world();
  w.repo.publish({ version: "0.3.0", value: "NEEDS-NEW-PI", metadata: { minimumPiVersion: "99.0.0" } });
  const check = await w.ext.updates.check({});
  assert.equal(check.pi.ok, false);
  const outcome = await update(w, "");
  assert.equal(outcome?.status, "pi_incompatible");
  if (outcome?.status !== "pi_incompatible") return;
  assert.match(outcome.reason, /requires a newer Pi runtime/);
  assert.match(outcome.reason, /Candidate downloaded but not activated.\nPi update\/restart required./);
  assert.ok(existsSync(join(outcome.staged, "runtime.ts")), "candidate staged");
  assert.equal(w.ext.layout.readPointer("current"), null);
  assert.equal(w.host.activeGeneration()?.generation, 1);
  assert.equal(await w.settle(), "A");
});

test("failure isolation: a candidate failing validation never touches the running runtime (§47)", async () => {
  const w = await world();
  w.repo.publish({ version: "0.2.1", value: "BROKEN", mode: "throw-create" });
  const outcome = await update(w, "");
  assert.equal(outcome?.status, "failed");
  assert.equal(outcome?.status === "failed" && outcome.stage, "validate");
  const versions = w.ext.layout.versionsDir;
  assert.equal(existsSync(versions) ? readdirSync(versions).length : 0, 0, "nothing installed");
  assert.match(outcome?.status === "failed" ? outcome.reason : "", /runtime initialization test/);
  assert.equal(w.host.activeGeneration()?.generation, 1);
  assert.equal(w.ext.layout.readPointer("current"), null);
  assert.deepEqual(readdirSync(w.ext.layout.stagingDir), [], "staging cleaned");
  const journal = w.ext.journal.read();
  assert.ok(journal && journal !== "corrupt" && journal.phase === "failed");
  assert.equal(await w.settle(), "A");
});

test("security: untrusted source, argument-injection remote, malformed metadata, escaping symlink, foreign history (§46)", async () => {
  const w = await world({ updateRemote: "/tmp/not-trusted.git" });
  const untrusted = await w.ext.updates.check({});
  assert.match(untrusted.failure ?? "", /not a trusted source/);

  const w2 = await world({
    updateRemote: "--upload-pack=touch /tmp/pwned",
    trusted: ["--upload-pack=touch /tmp/pwned"],
  });
  assert.match((await w2.ext.updates.check({})).failure ?? "", /malformed remote/);

  const w3 = await world();
  w3.repo.publish({ version: "0.2.1", value: "B" }, (dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.version = "1.0.0; rm -rf ~";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  });
  assert.match((await w3.ext.updates.check({})).failure ?? "", /malformed candidate version/);

  w3.repo.publish({ version: "0.2.2", value: "C" }, escapingSymlink);
  const escaped = await update(w3, "");
  assert.equal(escaped?.status, "failed");
  assert.match(escaped?.status === "failed" ? escaped.reason : "", /points outside the tree/);
  assert.equal(w3.host.activeGeneration()?.generation, 1);

  // A chain of in-tree links that resolves outside the tree on disk.
  w3.repo.publish({ version: "0.2.3", value: "D" }, (dir) => {
    rmSync(join(dir, "evil-link"));
    symlinkSync(".", join(dir, "loop"));
    symlinkSync("loop/../outside", join(dir, "chained"));
  });
  const chained = await update(w3, "");
  assert.equal(chained?.status, "failed");
  assert.match(chained?.status === "failed" ? chained.reason : "", /escapes the staging tree/);
  assert.equal(w3.host.activeGeneration()?.generation, 1);

  const w4 = await world();
  publishUnrelatedHistory(w4.repo, w4.key, { version: "9.9.9", value: "EVIL" });
  const foreign = await w4.ext.updates.check({});
  assert.match(foreign.failure ?? "", /does not belong to the trusted repository/);
  assert.equal(await w4.settle(), "A");
});
