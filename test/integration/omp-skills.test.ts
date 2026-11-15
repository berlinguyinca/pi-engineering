import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Real OMP, isolated HOME and cwd, no mocks. Evidence for spec 07 experiments C, D, E and the pack check.
// OMP_BIN=/path/to/bun OMP_BIN_ARGS=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts  (bun >= 1.4.4)
const ompBin = process.env.OMP_BIN;
const skip = ompBin ? false : "UNVERIFIED: OMP_BIN not set; no real omp available to probe skills with";
const PACK = join(import.meta.dirname, "..", "..", "skill-packs", "pe-operator");
const OFFLINE = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
};

interface Probe {
  skills: Record<string, { description: string }>;
  manageSkill: boolean;
  /** The system prompt the model would receive. */
  prompt: string;
}

const baseArgs = () => (process.env.OMP_BIN_ARGS ?? "").split(/\s+/).filter(Boolean);
const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
// The test preload points PI_CODING_AGENT_DIR / PI_AGENT_DIR at a shared profile; OMP honours them over HOME.
const env = (home: string): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, ANTHROPIC_API_KEY: "sk-dummy-not-used", ...OFFLINE };
  e.PI_CODING_AGENT_DIR = undefined;
  e.PI_AGENT_DIR = undefined;
  return e;
};

function writeSkill(root: string, name: string, description: string, body = "body"): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

/** Start omp in rpc mode, ask for its slash commands and state, return the skills it discovered. */
function probe(home: string, cwd: string, extra: string[] = []): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const child = spawn(ompBin as string, [...baseArgs(), "--mode", "rpc", "--no-session", ...extra], {
      cwd,
      env: env(home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result: Partial<Probe> = {};
    let buf = "";
    let stderr = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(result as Probe);
    };
    const timer = setTimeout(() => finish(new Error(`omp probe timed out: ${stderr.slice(-400)}`)), 60_000);
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.type === "ready") {
          child.stdin.write(`${JSON.stringify({ id: "1", type: "get_available_commands" })}\n`);
          child.stdin.write(`${JSON.stringify({ id: "2", type: "get_state" })}\n`);
        } else if (frame.type === "response" && frame.id === "1") {
          result.skills = {};
          for (const c of frame.data?.commands ?? []) {
            if (String(c.name).startsWith("skill:")) {
              result.skills[String(c.name).slice(6)] = { description: c.description ?? "" };
            }
          }
        } else if (frame.type === "response" && frame.id === "2") {
          result.prompt = ([] as string[]).concat(frame.data?.systemPrompt ?? []).join("\n");
          result.manageSkill = /manage_skill/.test(result.prompt);
        }
        if (result.skills && result.manageSkill !== undefined) finish();
      }
    });
    child.on("error", finish);
  });
}

const descriptions = (p: Probe) => Object.fromEntries(Object.entries(p.skills).map(([k, v]) => [k, v.description]));

test("pack: OMP discovers the PE skill from an extension package root, and only when loaded", { skip }, async () => {
  const home = dir("omp-home-");
  const cwd = dir("omp-cwd-");
  const without = await probe(home, cwd);
  assert.equal(without.skills["pe-operator"], undefined, "not loaded by default");
  const withPack = await probe(home, cwd, ["-e", PACK]);
  const found = withPack.skills["pe-operator"];
  assert.ok(found, `pe-operator missing; got ${Object.keys(withPack.skills)}`);
  assert.match(found.description, /Pi Engineering/);
  assert.match(
    withPack.prompt,
    /<skills>\n- pe-operator: How an operator drives Pi Engineering/,
    "listed in the model-visible prompt",
  );
  assert.doesNotMatch(without.prompt, /- pe-operator:/);
});

test("pack: lockfile integrity equals OMP's own deterministic pack integrity", { skip }, () => {
  const out = execFileSync(
    ompBin as string,
    [...baseArgs(), "skill", "publish", join(PACK, "skills", "pe-operator"), "--dry-run"],
    { env: env(dir("omp-home-")), cwd: dir("omp-cwd-"), encoding: "utf8" },
  );
  const lock = JSON.parse(execFileSync("cat", [join(PACK, "skills.lock.json")], { encoding: "utf8" }));
  assert.ok(out.includes(lock.skills["@pi_engineering/pe-operator"].integrity), out);
});

test(
  "D/E: same-named skills resolve native > claude > agents; losers are namespaced, not dropped",
  { skip },
  async () => {
    const home = dir("omp-home-");
    const cwd = dir("omp-cwd-");
    writeSkill(join(cwd, ".omp", "skills"), "dup", "native");
    writeSkill(join(cwd, ".claude", "skills"), "dup", "claude");
    writeSkill(join(cwd, ".agents", "skills"), "dup", "agents");
    const got = descriptions(await probe(home, cwd));
    assert.equal(got.dup, "native");
    assert.equal(got["claude/dup"], "claude");
    assert.equal(got["agents/dup"], "agents");
  },
);

test(
  "D: an extension-package skill (90) outranks a project .claude skill (80) of the same name",
  { skip },
  async () => {
    const home = dir("omp-home-");
    const cwd = dir("omp-cwd-");
    writeSkill(join(cwd, ".claude", "skills"), "pe-operator", "claude-copy");
    const got = descriptions(await probe(home, cwd, ["-e", PACK]));
    assert.match(got["pe-operator"] ?? "", /Pi Engineering/);
    assert.equal(got["claude/pe-operator"], "claude-copy");
  },
);

test(
  "E: Claude, Codex, Agents and GitHub layouts are read; foreign user-level roots are opt-in",
  { skip },
  async () => {
    const home = dir("omp-home-");
    const cwd = dir("omp-cwd-");
    writeSkill(join(cwd, ".claude", "skills"), "claude-proj", "p");
    writeSkill(join(cwd, ".codex", "skills"), "codex-proj", "p");
    writeSkill(join(cwd, ".agents", "skills"), "agents-proj", "p");
    writeSkill(join(cwd, ".github", "skills"), "github-proj", "p");
    writeSkill(join(home, ".claude", "skills"), "claude-user", "u");
    writeSkill(join(home, ".codex", "skills"), "codex-user", "u");
    writeSkill(join(home, ".agents", "skills"), "agents-user", "u");
    const names = Object.keys((await probe(home, cwd)).skills);
    for (const n of ["claude-proj", "codex-proj", "agents-proj", "github-proj", "agents-user"])
      assert.ok(names.includes(n), n);
    for (const n of ["claude-user", "codex-user"]) assert.ok(!names.includes(n), `${n} must not load by default`);
  },
);

test(
  "D: lockfile pins a store entry; offline load, mismatch refusal, rollback; marker-only integrity check",
  { skip },
  async () => {
    const home = dir("omp-home-");
    const cwd = dir("omp-cwd-");
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    const store = (v: string) => join(home, ".omp", "skillshare", "@pi_engineering", "pe-operator", v);
    const install = (v: string, integrity: string, description: string) => {
      mkdirSync(store(v), { recursive: true });
      writeFileSync(join(store(v), "SKILL.md"), `---\nname: pe-operator\ndescription: ${description}\n---\nbody\n`);
      writeFileSync(join(store(v), ".skillshare-integrity"), integrity);
    };
    const lock = (v: string, integrity: string) =>
      writeFileSync(
        join(cwd, ".omp", "skills.lock.json"),
        JSON.stringify({
          version: 1,
          skills: { "@pi_engineering/pe-operator": { version: v, integrity, resolved: "" } },
        }),
      );
    install("0.1.0", "sha512-AAA", "v1");
    install("0.2.0", "sha512-BBB", "v2");
    lock("0.2.0", "sha512-BBB");
    assert.equal(descriptions(await probe(home, cwd))["pe-operator"], "v2", "locked version loads offline");
    lock("0.2.0", "sha512-DIFFERENT");
    assert.equal((await probe(home, cwd)).skills["pe-operator"], undefined, "integrity mismatch is refused");
    lock("0.1.0", "sha512-AAA");
    assert.equal(
      descriptions(await probe(home, cwd))["pe-operator"],
      "v1",
      "rollback = re-pin an older locked version",
    );
    writeFileSync(join(store("0.1.0"), "SKILL.md"), "---\nname: pe-operator\ndescription: tampered\n---\nx\n");
    assert.equal(
      descriptions(await probe(home, cwd))["pe-operator"],
      "tampered",
      "FINDING: only the integrity marker is compared at load; unpacked content is not re-hashed",
    );
  },
);

test("D: a native project skill outranks the same name pinned in the lockfile store", { skip }, async () => {
  const home = dir("omp-home-");
  const cwd = dir("omp-cwd-");
  mkdirSync(join(cwd, ".omp"), { recursive: true });
  const s = join(home, ".omp", "skillshare", "@pi_engineering", "pe-operator", "0.1.0");
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, "SKILL.md"), "---\nname: pe-operator\ndescription: locked\n---\nb\n");
  writeFileSync(join(s, ".skillshare-integrity"), "sha512-AAA");
  writeFileSync(
    join(cwd, ".omp", "skills.lock.json"),
    JSON.stringify({
      version: 1,
      skills: { "@pi_engineering/pe-operator": { version: "0.1.0", integrity: "sha512-AAA", resolved: "" } },
    }),
  );
  writeSkill(join(cwd, ".omp", "skills"), "pe-operator", "native");
  const got = descriptions(await probe(home, cwd));
  assert.equal(got["pe-operator"], "native");
  assert.equal(got["pe-operator/pe-operator"], "locked", "the lower-priority copy is namespaced by package name");
});

test(
  "C: autolearn is off by default; user or project config enables it; a --config overlay set to false wins",
  { skip },
  async () => {
    const cwd = dir("omp-cwd-");
    const off = dir("omp-off-");
    writeFileSync(join(off, "off.yml"), "autolearn:\n  enabled: false\n");
    assert.equal((await probe(dir("omp-home-"), cwd)).manageSkill, false, "default off");

    const userOn = dir("omp-home-");
    mkdirSync(join(userOn, ".omp", "agent"), { recursive: true });
    writeFileSync(join(userOn, ".omp", "agent", "config.yml"), "autolearn:\n  enabled: true\n");
    assert.equal((await probe(userOn, cwd)).manageSkill, true, "user config enables manage_skill");
    assert.equal(
      (await probe(userOn, cwd, ["--config", join(off, "off.yml")])).manageSkill,
      false,
      "overlay beats user",
    );

    const projOn = dir("omp-cwd-");
    mkdirSync(join(projOn, ".omp"), { recursive: true });
    writeFileSync(join(projOn, ".omp", "config.yml"), "autolearn:\n  enabled: true\n");
    assert.equal(
      (await probe(dir("omp-home-"), projOn)).manageSkill,
      true,
      "a cloned repo's .omp/config.yml enables it",
    );
    assert.equal(
      (await probe(dir("omp-home-"), projOn, ["--config", join(off, "off.yml")])).manageSkill,
      false,
      "overlay beats project",
    );
  },
);

test("C: managed skills are discovered even with autolearn off, and lose to authored skills", { skip }, async () => {
  const home = dir("omp-home-");
  const cwd = dir("omp-cwd-");
  writeSkill(join(home, ".omp", "agent", "managed-skills"), "lesson", "managed");
  writeSkill(join(home, ".omp", "agent", "managed-skills"), "both", "managed");
  writeSkill(join(cwd, ".agents", "skills"), "both", "authored");
  const got = descriptions(await probe(home, cwd));
  assert.equal(got.lesson, "managed");
  assert.equal(got.both, "authored");
});

test("pack copy keeps working when relocated (path independent)", { skip }, async () => {
  const copy = join(dir("omp-pack-"), "pe-operator");
  cpSync(PACK, copy, { recursive: true });
  const got = await probe(dir("omp-home-"), dir("omp-cwd-"), ["-e", copy]);
  assert.ok(got.skills["pe-operator"]);
});
