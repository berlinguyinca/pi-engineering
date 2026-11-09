import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type Observations,
  bootstrapOne,
  canonicalHash,
  executionPlan,
  validateParentHandoff,
} from "../../scripts/bootstrap-one.ts";
import { canonicalHash as protocolHash, taskAuthorityHash } from "../../src/bootstrap/resultGate.ts";
import { type TaskManifest, parseTaskManifest } from "../../src/bootstrap/taskManifest.ts";

const BASE = "bfffb539025959a7429cb8703779573c132ead1f";
const PARENT = {
  specVersion: "1.2.0",
  taskId: "B03",
  status: "PASS",
  repo: "pi",
  baseSha: "bcfee3b03791afae66e41050a981d28e2e8a03de",
  resultSha: "bfffb539025959a7429cb8703779573c132ead1f",
  taskAuthorityHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  changedFiles: [
    { path: "src/bootstrap/diffGuard.ts", changeType: "added", summary: "guard" },
    { path: "test/unit/bootstrap-diff-guard.test.ts", changeType: "added", summary: "tests" },
  ],
  commands: [
    { argv: ["npm", "run", "typecheck"], cwd: ".", exitCode: 0, durationMs: null, outputArtifact: "docs/logs/01.txt" },
  ],
  evidence: ["docs/logs/01.txt", "annotated entry"],
  blockedReasons: ["B03-1 note"],
  nextTaskId: "B04",
  nextBaseSha: "bfffb539025959a7429cb8703779573c132ead1f",
  operatorApproval: { required: true, approved: true, approvedBy: "operator", approvedAt: "2026-11-04T01:03:16Z" },
  handoffHash: "sha256:7c422083a6b280d0163272d14c4fd303b8c6a93d60749cb394f96c7672b1c43e",
};
const MANIFEST = {
  taskId: "B04",
  baseSha: "bfffb539025959a7429cb8703779573c132ead1f",
  repoId: "pi",
  objective: "CLI skeleton that plans one bootstrap microtask",
  allowPaths: ["scripts/**"],
  denyPaths: ["scripts/evidence/**"],
  commands: [
    { argv: ["npm", "run", "typecheck"], cwd: "." },
    {
      argv: ["node", "--test", "--import", "./test/support/isolatedState.ts", "test/unit/bootstrap-one.test.ts"],
      cwd: ".",
    },
  ],
  limits: { maxProductionFiles: 2, maxTestFiles: 2, maxChangedLines: 100 },
  parentHandoffHash: "sha256:7c422083a6b280d0163272d14c4fd303b8c6a93d60749cb394f96c7672b1c43e",
  expectedOutputs: ["scripts/bootstrap-one.ts"],
  mode: "isolated-change" as const,
};
const obs = (over: Partial<Observations> = {}): Observations => ({
  manifestText: JSON.stringify(MANIFEST),
  parentHandoffText: JSON.stringify(PARENT),
  headSha: BASE,
  porcelain: "",
  ...over,
});
test("canonical hashing agrees with the handoff protocol's Python canonicalization", () => {
  assert.equal(canonicalHash(PARENT), PARENT.handoffHash, "must match the protocol canonicalization");
  assert.equal(
    canonicalHash({
      ...PARENT,
      changedFiles: [{ ...PARENT.changedFiles[0], summary: "changed" }, PARENT.changedFiles[1]],
    }) !== PARENT.handoffHash,
    true,
    "nested changes move the hash",
  );
});
test("one accepted manifest yields a deterministic plan and touches nothing", () => {
  assert.deepEqual(bootstrapOne(obs()), {
    exitCode: 0,
    lines: [`parent=B03 accepted ${PARENT.handoffHash.slice(0, 18)}…`, ...executionPlan(MANIFEST)],
  });
  assert.deepEqual(executionPlan(MANIFEST), [
    "task=B04",
    "mode=isolated-change",
    "repo=pi",
    "base=bfffb539025959a7429cb8703779573c132ead1f",
    "allow=scripts/**",
    "deny=scripts/evidence/**",
    "limits=2/2/100",
    "command=. :: npm run typecheck",
    "command=. :: node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts",
  ]);
});
test("malformed manifests and baseline drift are rejected before any planning", () => {
  const bad = bootstrapOne(
    obs({
      manifestText: JSON.stringify({
        ...MANIFEST,
        allowPaths: ["**"],
        limits: { maxProductionFiles: 9, maxTestFiles: 1, maxChangedLines: 100 },
      }),
    }),
  );
  assert.equal(bad.exitCode, 2);
  assert.match(bad.lines.join("\n"), /allowPaths|limits/u);
  assert.equal(bootstrapOne(obs({ manifestText: "{not json" })).exitCode, 2);
  assert.deepEqual(bootstrapOne(obs({ headSha: "f".repeat(40) })).lines, [
    `REJECT baseline: HEAD ${"f".repeat(40)} != manifest baseSha ${BASE}`,
  ]);
  assert.match(
    bootstrapOne(obs({ porcelain: " M src/index.ts\n" })).lines.join("\n"),
    /worktree is not clean[\s\S]*M src\/index\.ts/u,
  );
});
test("handoff mismatch is rejected and no model, scheduler or inference path is reachable", () => {
  assert.equal(bootstrapOne(obs({ parentHandoffText: null })).exitCode, 4);
  assert.match(
    bootstrapOne(
      obs({ manifestText: JSON.stringify({ ...MANIFEST, parentHandoffHash: `sha256:${"0".repeat(64)}` }) }),
    ).lines.join("\n"),
    /!= manifest parentHandoffHash sha256:0{64}/u,
  );
  const forged = { ...PARENT, nextTaskId: "B05" };
  forged.handoffHash = canonicalHash(forged);
  assert.match(
    bootstrapOne(
      obs({
        manifestText: JSON.stringify({ ...MANIFEST, parentHandoffHash: canonicalHash(forged) }),
        parentHandoffText: JSON.stringify(forged),
      }),
    ).lines.join("\n"),
    /parent nextTaskId B05 != B04/u,
  );
  assert.match(
    bootstrapOne(obs({ parentHandoffText: JSON.stringify({ ...PARENT, status: "BLOCKED" }) })).lines.join("\n"),
    /stored hash .* != canonical/u,
  );
  const source = readFileSync("scripts/bootstrap-one.ts", "utf8");
  const imports = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("import"))
    .join(" ");
  for (const banned of [/orchestration/iu, /scheduler/iu, /plannerWorker/iu, /gateway/iu, /capability/iu])
    assert.equal(banned.test(imports), false, `forbidden import: ${banned}`);
  assert.equal(
    /\bfetch\s*\(|createModel|generateContent|completeChat/i.test(source),
    false,
    "no model call site anywhere in the wrapper",
  );
});

// FIX-2: the parent chain the record asserts must be verified where the handoff is STAMPED, not only in a plan-only run at the base commit.
type StampKind = "valid" | "absent" | "tampered" | "sequence";
/** FIX-3C additions to the stamp run: `schema` is the content written to `fixtures/schema.json` (a string verbatim, anything else as JSON; the default is the permissive `{ "type": "object" }`, so the FIX-2 assertions stay about the parent chain), `schemaArg` is the `--handoff-schema` value (`null` omits the flag, a path never written is the unreadable case), `record` replaces the stamped record — as an object, or FIX-4A as a factory receiving the authority the fixture manifest derives (a record may no longer name its own authority). */
type Stamp3 = {
  schema?: unknown;
  schemaArg?: string | null;
  record?: Record<string, unknown> | ((authority: string) => Record<string, unknown>);
};
/** A committed-clean temp repo (fixtures/ is git-ignored, so porcelain stays empty) whose HEAD is a task commit on its own approved base, plus one `--emit-handoff` run in it. */
function stampRun(
  t: { after(fn: () => void): void },
  kind: StampKind,
  fix3: Stamp3 = {},
): {
  status: number | null;
  stdout: string;
  written: string[];
  declared: string;
  derived: string;
  manifestJson: Record<string, unknown>;
} {
  const dir = mkdtempSync(join(tmpdir(), "fix2-stamp-"));
  const out = mkdtempSync(join(tmpdir(), "fix2-out-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  const git = (args: string[]): string =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=fix2",
        "-c",
        "user.email=fix2@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "absent-global-config"), GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  git(["init", "-q"]);
  mkdirSync(join(dir, "fixtures/logs"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "fixtures/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-q", "-m", "approved base"]);
  const baseSha = git(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/x.ts"), "export const x = 1;\nexport const y = 2;\n");
  git(["add", "src/x.ts"]);
  git(["commit", "-q", "-m", "task"]);
  const fx = (rel: string, data: unknown): void => {
    writeFileSync(join(dir, "fixtures", rel), typeof data === "string" ? data : JSON.stringify(data));
  };
  fx("logs/01.txt", "ok\n");
  fx("proofs.json", [{ command: "true", exitCode: 0, outputArtifact: "fixtures/logs/01.txt" }]);
  fx("schema.json", fix3.schema ?? { type: "object" });
  const parent: Record<string, unknown> = {
    specVersion: "1.2.0",
    taskId: "E01",
    status: "PASS",
    repo: "pi",
    baseSha,
    resultSha: baseSha,
    evidence: [],
    nextTaskId: kind === "sequence" ? "OTHER" : "T1",
    nextBaseSha: baseSha,
  };
  const parentStatus = (fix3 as StampParentStatus).parentStatus; // FIX-5: written before the checksum below, so a parent on an accept path hashes exactly as the CLI reads it (`null` = no status key at all)
  if (parentStatus === null) delete parent.status;
  else if (parentStatus !== undefined) parent.status = parentStatus;
  const declared = protocolHash(parent);
  if (kind === "tampered") parent.status = "BLOCKED"; // the stored checksum below is then stale, exactly as an edited handoff would be
  fx("parent.json", { ...parent, handoffHash: declared });
  // FIX-4A: the fixture manifest is written BEFORE the record, so every record on an accept path can carry the authority that manifest derives instead of a placeholder.
  const manifestJson = {
    ...MANIFEST,
    taskId: "T1",
    baseSha,
    allowPaths: ["src/**"],
    denyPaths: [],
    commands: [{ argv: ["true"], cwd: "." }],
    limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 100 },
    expectedOutputs: ["src/x.ts"],
    parentHandoffHash: declared,
  };
  fx("manifest.json", manifestJson);
  const derived = taskAuthorityHash(manifestOf(manifestJson));
  const record =
    typeof fix3.record === "function"
      ? fix3.record(derived)
      : (fix3.record ?? {
          taskId: "T1",
          status: "PASS",
          evidence: [],
          nextTaskId: "T2",
          nextBaseSha: git(["rev-parse", "HEAD"]).trim(),
          taskAuthorityHash: derived,
        });
  fx("record.json", record);
  const argv = [
    join(process.cwd(), "scripts/bootstrap-one.ts"),
    "--cwd",
    dir,
    "--manifest",
    "fixtures/manifest.json",
    "--proofs",
    "fixtures/proofs.json",
    "--handoff-record",
    "fixtures/record.json",
    "--emit-handoff",
    out,
  ];
  if (kind !== "absent") argv.push("--parent-handoff", "fixtures/parent.json");
  if (fix3.schemaArg !== null) argv.push("--handoff-schema", fix3.schemaArg ?? "fixtures/schema.json"); // FIX-3C: --emit-handoff requires the schema
  const run = spawnSync(process.execPath, argv, { encoding: "utf8" });
  return {
    status: run.status,
    stdout: `${run.stdout}${run.stderr}`,
    written: readdirSync(out),
    declared,
    derived,
    manifestJson,
  };
}

test("validateParentHandoff is pure: a manifest with no parent and a correct parent both yield no blockers", () => {
  assert.deepEqual(validateParentHandoff(MANIFEST, JSON.stringify(PARENT)), [], "the existing fixture chain is valid");
  assert.deepEqual(
    validateParentHandoff({ ...MANIFEST, parentHandoffHash: null }, null),
    [],
    "nothing is declared, so nothing is verified",
  );
  assert.equal(
    canonicalHash(PARENT),
    protocolHash(PARENT),
    "the CLI re-export is the protocol canonicalization itself",
  );
});

test("FIX-2: a declared parent that is absent at stamp time blocks the gate, exits 5 and writes no handoff", (t) => {
  const run = stampRun(t, "absent");
  assert.equal(run.status, 5, run.stdout);
  assert.match(
    run.stdout,
    /REJECT gate: manifest declares parentHandoffHash sha256:[0-9a-f]{64} but no parent handoff was supplied/u,
  );
  assert.doesNotMatch(run.stdout, /gate=accepted/u);
  assert.deepEqual(run.written, [], "the output directory holds no <taskId>.handoff.json");
});

test("FIX-2: a parent whose stored hash is not its canonical hash is rejected at stamp time", (t) => {
  const run = stampRun(t, "tampered");
  assert.equal(run.status, 5, run.stdout);
  assert.match(run.stdout, /REJECT gate: stored hash sha256:[0-9a-f]{64} != canonical sha256:[0-9a-f]{64}/u);
  assert.deepEqual(run.written, []);
});

test("FIX-2: a correctly hashed parent pointing at the wrong next task is rejected at stamp time", (t) => {
  const run = stampRun(t, "sequence");
  assert.equal(run.status, 5, run.stdout);
  assert.match(run.stdout, /REJECT gate: parent nextTaskId OTHER != T1/u);
  assert.deepEqual(run.written, []);
});

test("FIX-2: a valid parent chain stamps, and the stamping run itself prints the verification", (t) => {
  const run = stampRun(t, "valid");
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /gate=accepted/u);
  assert.deepEqual(run.written, ["T1.handoff.json"]);
  assert.equal(
    run.stdout.includes(`parent=E01 accepted ${run.declared.slice(0, 18)}`),
    true,
    "the verification is visible in the stamping log",
  );
});

// FIX-5: a parent handoff is only a valid base if its own `status` records an accepted result — the schema allows BLOCKED, so the chain must read it.
/** FIX-5: the one extra knob the FIX-5 parent fixtures need. The pre-existing `Stamp3` fixtures are untouched (their assertions may only be extended), so the knob rides on the same options object and is read back inside `stampRun`. */
type StampParentStatus = { parentStatus?: string | null };
const stampStatus = (status: string | null): Stamp3 => {
  const knob: Stamp3 & StampParentStatus = { parentStatus: status };
  return knob;
};

test("FIX-5: validateParentHandoff reads the parent's status — BLOCKED and absent are blockers, ALREADY_SATISFIED is a base", () => {
  const rehash = (parent: Record<string, unknown>): Record<string, unknown> => ({
    ...parent,
    handoffHash: canonicalHash(parent),
  }); // recomputed over the mutated parent, so only the status can reject it
  const blocked = rehash({ ...PARENT, status: "BLOCKED" });
  assert.deepEqual(
    validateParentHandoff({ ...MANIFEST, parentHandoffHash: canonicalHash(blocked) }, JSON.stringify(blocked)),
    ["parent handoff B03 reports status BLOCKED; only PASS or ALREADY_SATISFIED may be a base"],
  );
  const absent: Record<string, unknown> = { ...PARENT };
  delete absent.status;
  absent.handoffHash = canonicalHash(absent); // the status-less parent, hashed without its status
  assert.deepEqual(
    validateParentHandoff({ ...MANIFEST, parentHandoffHash: canonicalHash(absent) }, JSON.stringify(absent)),
    ["parent handoff B03 reports status undefined; only PASS or ALREADY_SATISFIED may be a base"],
  );
  const satisfied = rehash({ ...PARENT, status: "ALREADY_SATISFIED" });
  assert.deepEqual(
    validateParentHandoff({ ...MANIFEST, parentHandoffHash: canonicalHash(satisfied) }, JSON.stringify(satisfied)),
    [],
    "an already-satisfied unit is a legitimate base",
  );
  assert.equal(
    bootstrapOne(
      obs({
        manifestText: JSON.stringify({ ...MANIFEST, parentHandoffHash: canonicalHash(blocked) }),
        parentHandoffText: JSON.stringify(blocked),
      }),
    ).exitCode,
    4,
    "the plan path rejects it too, at the base commit",
  );
});

test("FIX-5: a parent whose status is BLOCKED blocks the gate, exits 5, is never logged accepted, writes no handoff", (t) => {
  const run = stampRun(t, "valid", stampStatus("BLOCKED"));
  assert.equal(run.status, 5, run.stdout);
  assert.match(
    run.stdout,
    /REJECT gate: parent handoff E01 reports status BLOCKED; only PASS or ALREADY_SATISFIED may be a base/u,
  );
  assert.doesNotMatch(run.stdout, /parent=E01 accepted/u, "a blocked parent may not be stamped as accepted");
  assert.doesNotMatch(run.stdout, /gate=accepted/u);
  assert.deepEqual(run.written, [], "the output directory holds no <taskId>.handoff.json");
});

test("FIX-5: a parent with no status key is rejected the same way, and the run fails closed rather than throwing", (t) => {
  const run = stampRun(t, "valid", stampStatus(null));
  assert.equal(run.status, 5, run.stdout);
  assert.match(
    run.stdout,
    /REJECT gate: parent handoff E01 reports status undefined; only PASS or ALREADY_SATISFIED may be a base/u,
  );
  assert.doesNotMatch(run.stdout, NO_TRACE, "must fail closed as a blocker, never as an uncaught exception");
  assert.doesNotMatch(run.stdout, /parent=E01 accepted/u);
  assert.deepEqual(run.written, []);
});

test("FIX-5: a parent whose status is ALREADY_SATISFIED is accepted, stamped, exit 0, and the acceptance line is unchanged", (t) => {
  const run = stampRun(t, "valid", stampStatus("ALREADY_SATISFIED"));
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /gate=accepted/u);
  assert.deepEqual(run.written, ["T1.handoff.json"]);
  assert.doesNotMatch(run.stdout, /REJECT gate/u);
  assert.equal(
    run.stdout.includes(`parent=E01 accepted ${run.declared.slice(0, 18)}`),
    true,
    "worded exactly as the PASS parent's acceptance line",
  );
});

// FIX-3C: `--emit-handoff` must schema-validate the record against the REAL protocol schema before anything is stamped.
// The flag resolves against --cwd, so the real templates/handoff.schema.json is copied byte-for-byte into the fixture repo.
const REAL_SCHEMA = (): string =>
  readFileSync(
    join(process.cwd(), "docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json"),
    "utf8",
  );
const CONFORMING = (authority: string): Record<string, unknown> => {
  const record: Record<string, unknown> = {
    specVersion: "1.2.0",
    taskId: "T1",
    status: "PASS",
    repo: "pi",
    baseSha: "a".repeat(40),
    resultSha: "b".repeat(40),
    taskAuthorityHash: authority,
    changedFiles: ["src/x.ts"],
    commands: [{ command: "npm run typecheck", exitCode: 0, outputArtifact: "fixtures/logs/01.txt" }],
    evidence: ["fixtures/logs/01.txt"],
    blockedReasons: [],
    nextTaskId: "T2",
    nextBaseSha: "d".repeat(40),
    operatorApproval: { required: false, approved: false, approvedBy: null, approvedAt: null },
  };
  return record;
};
const NO_TRACE = /\n\s{2,}at\s+\S+/u; // node renders an uncaught exception as "    at frame" lines on stderr

test("FIX-3C: --emit-handoff without --handoff-schema is a gate blocker, exit 5, nothing written", (t) => {
  const run = stampRun(t, "valid", { schemaArg: null });
  assert.equal(run.status, 5, run.stdout);
  assert.match(run.stdout, /REJECT gate: --emit-handoff requires --handoff-schema/u);
  assert.doesNotMatch(run.stdout, /gate=accepted/u);
  assert.deepEqual(run.written, [], "the output directory holds no <taskId>.handoff.json");
});

test("FIX-3C: a record violating the real handoff schema is rejected with the validator's path-named blocker", (t) => {
  const badStatus = stampRun(t, "valid", {
    schema: REAL_SCHEMA(),
    record: (authority) => ({ ...CONFORMING(authority), status: "DONE" }),
  });
  assert.equal(badStatus.status, 5, badStatus.stdout);
  assert.match(
    badStatus.stdout,
    /REJECT gate: \$\.status: "DONE" is not one of enum \["PASS","ALREADY_SATISFIED","BLOCKED"\]/u,
  );
  assert.deepEqual(badStatus.written, []);
  const noExit = stampRun(t, "valid", {
    schema: REAL_SCHEMA(),
    record: (authority) => ({
      ...CONFORMING(authority),
      commands: [{ command: "npm run typecheck", outputArtifact: "fixtures/logs/01.txt" }],
    }),
  }); // commands[].exitCode missing
  assert.equal(noExit.status, 5, noExit.stdout);
  assert.match(noExit.stdout, /REJECT gate: \$\.commands\[0\]\.exitCode: required property missing/u);
  assert.deepEqual(noExit.written, []);
});

test("FIX-3C: an unreadable or non-JSON --handoff-schema fails closed — blocker, exit 5, no stack trace, nothing written", (t) => {
  const unreadable = stampRun(t, "valid", { schemaArg: "fixtures/nope.schema.json" });
  assert.equal(unreadable.status, 5, unreadable.stdout);
  assert.match(unreadable.stdout, /REJECT gate: handoff schema fixtures\/nope\.schema\.json is unreadable/u);
  const nonJson = stampRun(t, "valid", { schema: "not json" });
  assert.equal(nonJson.status, 5, nonJson.stdout);
  assert.match(nonJson.stdout, /REJECT gate: handoff schema fixtures\/schema\.json is not valid JSON/u);
  for (const run of [unreadable, nonJson]) {
    assert.doesNotMatch(run.stdout, NO_TRACE, "must fail closed as a blocker, never as an uncaught exception");
    assert.doesNotMatch(run.stdout, /gate=accepted/u);
    assert.deepEqual(run.written, []);
  }
});

test("FIX-3C: a record conforming to the real schema stamps, and the log proves validation ran", (t) => {
  const run = stampRun(t, "valid", { schema: REAL_SCHEMA(), record: CONFORMING });
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /schema=T1 conforms fixtures\/schema\.json/u);
  assert.match(run.stdout, /gate=accepted/u);
  assert.deepEqual(run.written, ["T1.handoff.json"]);
  const stamped = run.stdout.match(/handoff=(\S+) checksum=/u)?.[1];
  assert.ok(stamped !== undefined, run.stdout); // the stamped file carries the checksum the writer computed
  assert.match(readFileSync(stamped, "utf8"), /"handoffHash": "sha256:[0-9a-f]{64}"/u);
});

// FIX-4A: the authority a handoff asserts is DERIVED from the task manifest at stamp time; a record may not name, invent or omit it.
/** The fixture manifest as the parser normalizes it, so tests can derive the authority from the same rule the CLI uses. */
function manifestOf(json: unknown): TaskManifest {
  const parsed = parseTaskManifest(json);
  if (!parsed.ok) throw new Error(`fixture manifest is invalid: ${parsed.errors.join("; ")}`);
  return parsed.manifest;
}

test("FIX-4A: taskAuthorityHash IS canonicalHash(parseTaskManifest(json).manifest) — defaults invisible, fields decisive", () => {
  const explicit = manifestOf({
    ...MANIFEST,
    limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 100 },
  }); // the parser's own DEFAULT_LIMITS, written out
  const defaulted = manifestOf({ ...MANIFEST, limits: undefined }); // the same manifest file with `limits` omitted -> defaults applied
  assert.deepEqual(defaulted, explicit, "defaults applied yields the identical normalized manifest");
  assert.equal(
    taskAuthorityHash(defaulted),
    canonicalHash(explicit),
    "the authority is the canonical hash of the PARSED manifest, computed independently in this test",
  );
  assert.equal(taskAuthorityHash(explicit), protocolHash(explicit), "and through the protocol canonicalization itself");
  assert.notEqual(
    taskAuthorityHash(manifestOf({ ...MANIFEST, objective: `${MANIFEST.objective} (reworded)` })),
    taskAuthorityHash(explicit),
    "changing a manifest field changes the authority",
  );
  assert.equal(
    parseTaskManifest({ ...MANIFEST, unknownKey: 1 }).ok,
    false,
    "an unknown key never reaches the hash: the parser rejects the manifest first",
  );
});

test("FIX-4A: an accepted stamp prints exactly one authority line, the derived value, before the schema line", (t) => {
  const run = stampRun(t, "valid", { schema: REAL_SCHEMA(), record: CONFORMING });
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.written, ["T1.handoff.json"]);
  const independent = canonicalHash(manifestOf(run.manifestJson)); // recomputed here, from the fixture manifest, without calling taskAuthorityHash
  assert.equal(run.derived, independent, "the fixture's derived authority equals the independently computed value");
  assert.equal(
    (run.stdout.match(/^authority=T1 sha256:[0-9a-f]{64}$/gmu) ?? []).length,
    1,
    "exactly one authority line in the log",
  );
  assert.match(run.stdout, new RegExp(`^authority=T1 ${independent}$`, "mu"), "it names the task and the derived hash");
  assert.equal(
    run.stdout.indexOf(`authority=T1 ${independent}`) < run.stdout.indexOf("schema=T1 conforms"),
    true,
    "printed before the schema line",
  );
  const stamped = run.stdout.match(/handoff=(\S+) checksum=/u)?.[1];
  assert.ok(stamped !== undefined, run.stdout);
  assert.match(
    readFileSync(stamped, "utf8"),
    new RegExp(`"taskAuthorityHash": "${independent}"`, "u"),
    "the stamped record carries the derived authority",
  );
});

test("FIX-4A: the permissive-schema accept path (the FIX-2 fixtures) stamps on the derived authority as well", (t) => {
  const run = stampRun(t, "valid");
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.written, ["T1.handoff.json"]);
  assert.match(run.stdout, new RegExp(`authority=T1 ${run.derived}`, "u"));
  assert.doesNotMatch(run.stdout, /REJECT gate/u);
});

test("FIX-4A: a record that names a different authority is rejected at stamp time — exit 5, nothing written", (t) => {
  const run = stampRun(t, "valid", {
    schema: REAL_SCHEMA(),
    record: (authority) => ({ ...CONFORMING(authority), taskAuthorityHash: `sha256:${"0".repeat(64)}` }),
  });
  assert.equal(run.status, 5, run.stdout);
  assert.match(
    run.stdout,
    new RegExp(
      `REJECT gate: \\$\\.taskAuthorityHash: the record says sha256:0{64} but manifest T1 derives ${run.derived}`,
      "u",
    ),
    "the blocker names both values",
  );
  assert.doesNotMatch(run.stdout, /gate=accepted|^authority=T1 /mu);
  assert.deepEqual(run.written, [], "no <taskId>.handoff.json is written");
});

test("FIX-4A: a record with no taskAuthorityHash is rejected — exit 5, nothing written", (t) => {
  const run = stampRun(t, "valid", {
    schema: REAL_SCHEMA(),
    record: (authority) => {
      const record = { ...CONFORMING(authority) };
      delete record.taskAuthorityHash;
      return record;
    },
  });
  assert.equal(run.status, 5, run.stdout);
  assert.match(run.stdout, /REJECT gate: \$\.taskAuthorityHash: required property missing/u); // the FIX-3C schema stage requires it
  assert.match(
    run.stdout,
    /REJECT gate: \$\.taskAuthorityHash: the record says undefined but manifest T1 derives sha256:[0-9a-f]{64}/u,
  ); // and the derivation stage says so too
  assert.doesNotMatch(run.stdout, /gate=accepted/u);
  assert.deepEqual(run.written, []);
});
