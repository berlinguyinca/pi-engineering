import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadGithubSettings } from "../../src/github/settings.ts";
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
