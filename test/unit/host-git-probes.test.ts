/** The startup-path git probes: cached where that is safe, never stale, and async where a caller can wait. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  describeSource,
  describeSourceAsync,
  invalidateGitProbeCache,
  originRemote,
} from "../../src/runtime/host/extension.ts";
import { sshCommandConfigured, sshCommandConfiguredAsync } from "../../src/runtime/host/sourceWatch.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-git-probes-"));
  invalidateGitProbeCache();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sh = (c: string, cwd = root) =>
  execFileSync("bash", ["-c", c], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
  }).toString();

test("originRemote is cached per repository but sees a remote change at once (keyed by the config file)", () => {
  sh("git init -q -b main r && cd r && git remote add origin https://a.example/x.git");
  const r = join(root, "r");
  assert.equal(originRemote(r), "https://a.example/x.git");
  sh("git remote set-url origin https://b.example/longer-name/y.git", r);
  assert.equal(originRemote(r), "https://b.example/longer-name/y.git");
  assert.equal(originRemote(join(root, "nowhere")), null);
});

test("describeSource is never served stale (HEAD moves with the checkout), and the async twin gives the same answer", async () => {
  sh(
    "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && git commit -q --allow-empty -m one",
  );
  const r = join(root, "r");
  mkdirSync(r, { recursive: true });
  const first = describeSource(r).commit;
  assert.match(String(first), /^[0-9a-f]{40}$/);
  sh("git commit -q --allow-empty -m two", r);
  const second = describeSource(r).commit;
  assert.notEqual(second, first);
  assert.equal((await describeSourceAsync(r)).commit, second);
});

test("sshCommandConfiguredAsync agrees with the sync probe and does not block", async () => {
  sh("git init -q -b main r");
  const r = join(root, "r");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const asyncAnswer = await sshCommandConfiguredAsync(r);
  clearInterval(timer);
  assert.equal(asyncAnswer, sshCommandConfigured(r));
  assert.equal(asyncAnswer, false);
});
