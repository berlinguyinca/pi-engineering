import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadGithubSettings } from "../../src/github/settings.ts";
import { runRereviewCommand } from "../../src/github/sync.ts";
import { runGithubSyncCli } from "../../src/github/syncCli.ts";

const dirWith = (yaml?: string) => {
  const d = mkdtempSync(join(tmpdir(), "gh-settings-"));
  if (yaml !== undefined) writeFileSync(join(d, "engineering.yaml"), yaml);
  return d;
};

describe("github: YAML settings", () => {
  it("no block, or enabled absent/false: off without a note", async () => {
    assert.deepEqual(await loadGithubSettings(dirWith("foo: 1\n")), { settings: null, notes: [] });
    assert.deepEqual(await loadGithubSettings(dirWith("github:\n  enabled: false\n")), { settings: null, notes: [] });
  });

  it("reads hosts, default repo, gh path, required checks and the re-review argv", async () => {
    const { settings } = await loadGithubSettings(
      dirWith(
        'github:\n  enabled: true\n  hosts: [github.com]\n  default_repo: a/b\n  gh_path: /x/gh\n  required_checks: [ci]\n  rereview_command: ["/bin/req", "--x"]\n',
      ),
    );
    assert.equal(settings?.config.defaultRepo, "a/b");
    assert.equal(settings?.config.ghPath, "/x/gh");
    assert.deepEqual(settings?.requiredChecks, ["ci"]);
    assert.deepEqual(settings?.rereviewCommand, ["/bin/req", "--x"]);
  });

  it("refuses unknown keys, an option-like command and a non-list argv (off with a note)", async () => {
    for (const y of [
      "github:\n  enabled: true\n  token: nope\n",
      "github:\n  enabled: true\n  gh_path: --evil\n",
      "github:\n  enabled: true\n  rereview_command: run.sh\n",
    ]) {
      const r = await loadGithubSettings(dirWith(y));
      assert.equal(r.settings, null, y);
      assert.equal(r.notes.length, 1, y);
    }
  });

  it("the CLI with no github block does nothing: no gh, no network, exit 0", async () => {
    let out = "";
    let fetched = 0;
    const code = await runGithubSyncCli(
      ["sync", "--store", join(mkdtempSync(join(tmpdir(), "gh-cli-")), "s")],
      { PI_CODING_AGENT_DIR: dirWith() },
      {
        out: (t) => {
          out += t;
        },
        err: () => undefined,
      },
      {
        fetch: (async () => {
          fetched++;
          throw new Error("no network expected");
        }) as never,
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), { result: "disabled" });
    assert.equal(fetched, 0);
    assert.equal(await runGithubSyncCli(["bogus"], {}, { out: () => undefined, err: () => undefined }), 2);
  });
});

describe("rereview_command execution", () => {
  it("settings: a relative executable and a bad env name are refused; the env allow-list is read", async () => {
    assert.equal(
      (await loadGithubSettings(dirWith('github:\n  enabled: true\n  rereview_command: ["relative.sh"]\n'))).settings,
      null,
    );
    assert.equal(
      (await loadGithubSettings(dirWith('github:\n  enabled: true\n  rereview_env: ["bad name"]\n'))).settings,
      null,
    );
    const ok = await loadGithubSettings(
      dirWith('github:\n  enabled: true\n  rereview_command: ["/bin/true"]\n  rereview_env: [MY_TOKEN]\n'),
    );
    assert.deepEqual(ok.settings?.rereviewEnv, ["MY_TOKEN"]);
  });

  it("runs WITHOUT the caller's secrets, with only the YAML-listed names, and refuses a relative executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-"));
    const out = join(dir, "env.json");
    const script = join(dir, "dump.mjs");
    writeFileSync(
      script,
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`,
    );
    chmodSync(script, 0o755);
    const source = {
      PATH: process.env.PATH,
      HOME: "/h",
      GH_TOKEN: "t1",
      GIT_SSH_COMMAND: "x",
      SSH_AUTH_SOCK: "/s",
      MY_TOKEN: "allowed",
    };
    const node = process.execPath;
    assert.equal(await runRereviewCommand([node, script], ["MY_TOKEN"], source), true);
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(seen.GH_TOKEN, undefined);
    assert.equal(seen.GIT_SSH_COMMAND, undefined);
    assert.equal(seen.SSH_AUTH_SOCK, undefined);
    assert.equal(seen.MY_TOKEN, "allowed");
    assert.equal(seen.HOME, "/h");
    assert.equal(await runRereviewCommand(["node", script], [], source), false, "a relative executable is refused");
  });

  it("no shell: metacharacters in arguments are data; output beyond the cap kills the command (false); a failing exit is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-"));
    const marker = join(dir, "pwned");
    assert.equal(await runRereviewCommand([process.execPath, "-e", "0", `; touch ${marker}`], []), true);
    assert.equal(existsSync(marker), false, "the argument was not run by a shell");
    assert.equal(
      await runRereviewCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"], []),
      false,
      "unbounded output is cut",
    );
    assert.equal(await runRereviewCommand([process.execPath, "-e", "process.exit(3)"], []), false);
  });
});
