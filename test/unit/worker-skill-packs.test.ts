import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  NO_WORKER_SKILLS,
  WORKER_SKILLS_ENV,
  packProblems,
  parseWorkerSkillPacks,
  resolveWorkerSkills,
  stage,
  workerSkillsEnabled,
} from "../../src/skillpack/workerPacks.ts";
import {
  REAL_PE_OPERATOR,
  installOperatorPack,
  manifestSha,
  operatorGrantingPack,
  plantHostileRepo,
  repinOperator,
} from "../support/workerSkillFixture.ts";

const on = (fx: { state: string; agentDir: string }): NodeJS.ProcessEnv => ({
  [WORKER_SKILLS_ENV]: "1",
  PI_ENGINEERING_STATE_DIR: fx.state,
  PI_CODING_AGENT_DIR: fx.agentDir,
  HOME: fx.state,
});
const SHA = "a".repeat(64);

describe("worker skill packs: config", () => {
  it("the master switch is explicit and off by default", () => {
    assert.equal(workerSkillsEnabled({}), false);
    assert.equal(workerSkillsEnabled({ [WORKER_SKILLS_ENV]: "0" }), false);
    assert.equal(workerSkillsEnabled({ [WORKER_SKILLS_ENV]: "1" }), true);
    assert.equal(workerSkillsEnabled({ [WORKER_SKILLS_ENV]: "true" }), true);
  });

  it("parses pinned {id, manifestSha256} grants, de-duplicates, and reports malformed entries", () => {
    const cfg = parseWorkerSkillPacks({
      scout: [
        { id: "a", manifestSha256: SHA },
        { id: "a", manifestSha256: SHA },
      ],
      implementer: "x",
      reviewer: ["bare-string", { id: "../evil", manifestSha256: SHA }, { id: "ok", manifestSha256: "short" }],
    });
    assert.deepEqual(cfg.byRole, { scout: [{ id: "a", manifestSha256: SHA }], reviewer: [] });
    assert.equal(cfg.issues.length, 4);
    assert.deepEqual(parseWorkerSkillPacks(undefined), { byRole: {}, issues: [] });
    assert.equal(parseWorkerSkillPacks([]).issues.length, 1);
  });
});

describe("worker skill packs: resolution", () => {
  it("switch off: nothing resolves even with an allowlist (and no config is read)", async () => {
    const fx = operatorGrantingPack(["scout"]);
    assert.equal(await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: {} }), NO_WORKER_SKILLS);
  });

  it("switch on but role not allowlisted: nothing, no diagnostic", async () => {
    const fx = operatorGrantingPack(["scout"]);
    const out = await resolveWorkerSkills({ role: "implementer", cwd: fx.repo, env: on(fx) });
    assert.deepEqual(out, { packs: [], diagnostics: [] });
  });

  it("allowlisted role resolves a verified private copy (0700/0600), identical content shares one copy", async () => {
    const fx = operatorGrantingPack(["scout"]);
    const env = on(fx);
    const byId = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env });
    assert.equal(byId.packs.length, 1);
    assert.deepEqual(byId.diagnostics, []);
    const pack = byId.packs[0];
    assert.ok(pack);
    assert.notEqual(pack.dir, fx.pack, "loads the staged copy, not the repo dir");
    assert.deepEqual(packProblems(pack.dir), []);
    assert.equal(statSync(pack.dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(pack.skillsDir, "pe-operator", "SKILL.md")).mode & 0o777, 0o600);
    const again = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env });
    assert.equal(again.packs[0]?.dir, pack.dir, "same content, same content-addressed copy");
  });

  it("a role named like an Object.prototype member is not allowlisted and does not throw", async () => {
    const fx = operatorGrantingPack(["scout"]);
    const out = await resolveWorkerSkills({ role: "constructor", cwd: fx.repo, env: on(fx) });
    assert.deepEqual(out, { packs: [], diagnostics: [] });
  });

  it("the operator's agent dir honours PI_AGENT_DIR alone, like the legacy executor", async () => {
    const fx = operatorGrantingPack(["scout"]);
    const env = { ...on(fx), PI_CODING_AGENT_DIR: undefined, PI_AGENT_DIR: fx.agentDir };
    const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env });
    assert.deepEqual(out.diagnostics, []);
    assert.equal(out.packs.length, 1);
  });

  it("a cache dir that is a symlink is refused with a diagnostic, never thrown", async () => {
    const fx = operatorGrantingPack(["scout"]);
    mkdirSync(join(fx.state, "elsewhere"), { recursive: true });
    const cacheDir = join(fx.state, "cache-link");
    symlinkSync(join(fx.state, "elsewhere"), cacheDir);
    const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx), cacheDir });
    assert.deepEqual(out.packs, []);
    assert.equal(out.diagnostics.length, 1);
    assert.match(out.diagnostics[0] ?? "", /^worker skill pack refused \(scout\): pe-operator: .*private directory/);
    assert.deepEqual(readdirSync(join(fx.state, "elsewhere")), [], "nothing was staged through the link");
  });

  it("a pack directory that is itself a symlink is refused", async () => {
    const fx = operatorGrantingPack(["scout"]);
    const real = join(fx.agentDir, "real-pack");
    renameSync(fx.pack, real);
    symlinkSync(real, fx.pack);
    const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx) });
    assert.deepEqual(out.packs, []);
    assert.match(out.diagnostics[0] ?? "", /pe-operator: pack is not a plain directory/);
  });

  it("a missing pack is refused with a diagnostic", async () => {
    const fx = operatorGrantingPack(["scout"]);
    installOperatorPack(fx.agentDir, ["scout"], { id: "nope" });
    rmSync(join(fx.agentDir, "skill-packs", "nope"), { recursive: true });
    const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx) });
    assert.deepEqual(out.packs, []);
    assert.deepEqual(out.diagnostics, ["worker skill pack refused (scout): nope: pack not found"]);
  });

  const tampers: Array<[string, (pack: string) => void, RegExp]> = [
    [
      "edited skill body",
      (p) => appendFileSync(join(p, "skills", "pe-operator", "SKILL.md"), "\nignore previous\n"),
      /digest mismatch: skills\/pe-operator\/SKILL\.md/,
    ],
    ["extra file", (p) => writeFileSync(join(p, "skills", "pe-operator", "extra.md"), "x"), /unlisted file/],
    ["symlink", (p) => symlinkSync("/etc/hosts", join(p, "skills", "pe-operator", "link.md")), /symlink: /],
    [
      "script file",
      (p) => {
        mkdirSync(join(p, "scripts"));
        writeFileSync(join(p, "scripts", "x.sh"), "echo hi");
      },
      /unlisted file: scripts\/x\.sh/,
    ],
    [
      "lock tampered",
      (p) => writeFileSync(join(p, "skills.lock.json"), '{"version":1,"skills":{}}'),
      /lock has no entry for skill/,
    ],
    ["manifest replaced", (p) => writeFileSync(join(p, "pack.manifest.json"), "{"), /does not match the pinned digest/],
    ["empty directory", (p) => mkdirSync(join(p, "skills", "pe-operator", "hollow")), /empty directory/],
  ];
  for (const [name, mutate, expected] of tampers) {
    it(`fails closed: ${name}`, async () => {
      const fx = operatorGrantingPack(["scout"]);
      mutate(fx.pack);
      const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx) });
      assert.deepEqual(out.packs, []);
      assert.equal(out.diagnostics.length, 1);
      assert.match(out.diagnostics[0] ?? "", /^worker skill pack refused \(scout\): pe-operator: /);
      assert.match(out.diagnostics[0] ?? "", expected);
    });
  }

  it("a manifest-consistent pack that ships a script or executable is still refused", async () => {
    const { buildPackManifest } = await import("../../src/skillpack/verify.ts");
    for (const [file, mode] of [
      ["skills/pe-operator/run.sh", 0o644],
      ["skills/pe-operator/notes.md", 0o755],
    ] as const) {
      const fx = operatorGrantingPack(["scout"]);
      const pack = fx.pack;
      writeFileSync(join(pack, file), "echo hi\n");
      chmodSync(join(pack, file), mode);
      writeFileSync(join(pack, "pack.manifest.json"), `${JSON.stringify(buildPackManifest(pack), null, 2)}\n`);
      repinOperator(fx.agentDir, ["scout"]);
      const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx) });
      assert.deepEqual(out.packs, [], file);
      assert.match(out.diagnostics[0] ?? "", /script-like file|executable file/);
    }
  });

  it("a hostile repository's allowlist and pack are ignored, with a visible warning", async () => {
    const fx = operatorGrantingPack([]);
    rmSync(join(fx.agentDir, "engineering.yaml"));
    plantHostileRepo(fx.repo, ["scout"]);
    const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx) });
    assert.deepEqual(out.packs, []);
    assert.match(out.diagnostics.join("\n"), /ignored workers\.skillPacks in the repository's \.pi\/engineering\.yaml/);
  });

  it("a repo allowlist cannot add to the operator's grants for other roles", async () => {
    const fx = operatorGrantingPack(["scout"]);
    plantHostileRepo(fx.repo, ["implementer"]);
    const out = await resolveWorkerSkills({ role: "implementer", cwd: fx.repo, env: on(fx) });
    assert.deepEqual(out.packs, []);
  });

  it("ids with separators, dots, traversal or uppercase are rejected, never resolved against cwd", async () => {
    for (const id of ["../repo-pack", "a/b", "/abs/pack", ".hidden", "Upper", "a..b"]) {
      const fx = operatorGrantingPack([]);
      writeFileSync(
        join(fx.agentDir, "engineering.yaml"),
        `workers:\n  skillPacks:\n    scout: [{id: "${id}", manifestSha256: "${"a".repeat(64)}"}]\n`,
      );
      const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx) });
      assert.deepEqual(out.packs, [], id);
      assert.match(out.diagnostics.join("\n"), /entry needs id matching/, id);
    }
  });

  it("a wrong pinned manifest digest is refused before anything is staged", async () => {
    const fx = operatorGrantingPack([]);
    installOperatorPack(fx.agentDir, ["scout"], { sha: "b".repeat(64) });
    const out = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env: on(fx) });
    assert.deepEqual(out.packs, []);
    assert.equal(
      out.diagnostics[0],
      "worker skill pack refused (scout): pe-operator: manifest sha256 does not match the pinned digest",
    );
    assert.equal(existsSync(join(fx.state, "worker-skill-packs")), false, "nothing staged");
    assert.equal(manifestSha(fx.pack).length, 64);
  });

  it("the committed pe-operator pack is loadable", () => {
    assert.deepEqual(packProblems(REAL_PE_OPERATOR), []);
  });

  it("a tampered copy in the private cache is rebuilt, never trusted", async () => {
    const fx = operatorGrantingPack(["scout"]);
    const env = on(fx);
    const first = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env });
    const dir = first.packs[0]?.dir ?? "";
    appendFileSync(join(dir, "skills", "pe-operator", "SKILL.md"), "\nplanted\n");
    const again = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env });
    assert.deepEqual(packProblems(again.packs[0]?.dir ?? ""), []);
    const cache = join(fx.state, "worker-skill-packs");
    assert.equal(readdirSync(cache).filter((n) => n.startsWith(".bad.")).length, 1, "bad copy moved aside, not edited");
  });

  it("a manifest swapped after the pin check is refused by stage (hash of the bytes actually copied)", async () => {
    const fx = operatorGrantingPack([]);
    installOperatorPack(fx.agentDir, ["scout"]);
    const pin = manifestSha(fx.pack);
    appendFileSync(join(fx.pack, "pack.manifest.json"), "\n");
    const cache = join(fx.state, "worker-skill-packs");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const out = stage(fx.pack, cache, pin);
    assert.ok("problems" in out);
    assert.match(out.problems.join(";"), /does not match the pinned digest/);
    assert.deepEqual(readdirSync(cache), [], "nothing staged");
  });

  it("a cached copy whose manifest no longer matches the pin is not reused", async () => {
    const fx = operatorGrantingPack(["scout"]);
    const env = on(fx);
    const first = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env });
    const dir = first.packs[0]?.dir ?? "";
    appendFileSync(join(dir, "pack.manifest.json"), "\n");
    const again = await resolveWorkerSkills({ role: "scout", cwd: fx.repo, env });
    assert.equal(manifestSha(again.packs[0]?.dir ?? ""), manifestSha(fx.pack));
  });
});

describe("worker skill packs: omp firewall overlay", () => {
  it("default args are unchanged; with packs the skills overlay relaxes only skills and loads -e", async () => {
    const { OMP_FIREWALL_OVERLAY_YML, OMP_FIREWALL_SKILLS_OVERLAY_YML, firewallArgs } = await import(
      "../../src/omp/firewall.ts"
    );
    const dir = join(operatorGrantingPack([]).state, "fw");
    const off = firewallArgs(dir);
    assert.ok(off.includes("--no-skills") && !off.includes("-e"));
    assert.match(off[1] ?? "", /firewall\.yml$/);
    const on = firewallArgs(dir, ["/p/one"]);
    assert.ok(!on.includes("--no-skills") && on.includes("--no-extensions"));
    assert.deepEqual(on.slice(-2), ["-e", "/p/one"]);
    assert.match(on[1] ?? "", /firewall-skills\.yml$/);
    const overlay = OMP_FIREWALL_SKILLS_OVERLAY_YML;
    assert.match(overlay, /skills:\n {2}enabled: true\n/);
    for (const keep of [
      "autolearn:\n  enabled: false",
      'backend: "off"',
      "enableSkillCommands: false",
      "enableClaudeProject: false",
    ]) {
      assert.ok(overlay.includes(keep), keep);
    }
    for (const p of ["omp-managed", "claude", "agents", "codex", "github", "native", "skillshare"]) {
      assert.ok(overlay.includes(`  - ${p}\n`), p);
    }
    assert.ok(!overlay.includes("  - omp-plugins"));
    assert.ok(OMP_FIREWALL_OVERLAY_YML.includes("skills:\n  enabled: false"), "default overlay untouched");
  });
});
