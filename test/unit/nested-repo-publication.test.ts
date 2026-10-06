import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo, type NestedRepoPublication } from "../../src/git/GitRepo.ts";

const exec = promisify(execFile);

/** Acceptance rule for a nested publication as candidate evidence. */
function isAcceptable(record: NestedRepoPublication): boolean {
  return record.headSha !== record.baseSha && (record.publishedSha === null || record.publishedSha === record.headSha);
}

interface Harness {
  root: string;
  cleanup: () => Promise<void>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function makeAnchoredRepo(): Promise<Harness> {
  const root = await mkdir(join(tmpdir(), "pi-eng-nested-"), { recursive: true }).then(() =>
    import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "pi-eng-nested-"))),
  );
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "meta.md"), "# meta root\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "anchored base");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A standalone git repo nested inside the anchored tree, with a local bare remote. */
async function makeNestedRepo(anchoredRoot: string, relPath: string): Promise<{ path: string; remotePath: string }> {
  const remotePath = join(anchoredRoot, ".remotes", `${relPath.replace(/\//g, "-")}.git`);
  const path = join(anchoredRoot, relPath);
  await mkdir(remotePath, { recursive: true });
  await exec("git", ["init", "-q", "--bare", "-b", "main", remotePath]);
  await mkdir(path, { recursive: true });
  await git(path, "init", "-q", "-b", "main");
  await git(path, "config", "user.email", "test@example.com");
  await git(path, "config", "user.name", "Test");
  await writeFile(join(path, "product.txt"), "v1\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-q", "-m", "nested initial");
  await git(path, "remote", "add", "origin", remotePath);
  await git(path, "push", "-q", "origin", "main");
  return { path, remotePath };
}

async function advanceNestedRepo(path: string, version: string, push: boolean): Promise<void> {
  await writeFile(join(path, "product.txt"), `${version}\n`);
  await git(path, "add", "-A");
  await git(path, "commit", "-q", "-m", `nested ${version}`);
  if (push) await git(path, "push", "-q", "origin", "main");
}

test("nested repo publication: discovery, recording fields, and gate acceptance", async () => {
  const harness = await makeAnchoredRepo();
  try {
    const { path: nested, remotePath } = await makeNestedRepo(harness.root, "nested/product");
    const repo = (await GitRepo.open(harness.root))!;

    // Discovery finds the nested standalone repo (not the bare remote under .remotes,
    // which is a bare checkout with a .git directory but no worktree — see below).
    const discovered = await repo.discoverNestedRepos();
    const rel = discovered.map((ref) => ref.nestedPath);
    assert.ok(rel.includes("nested/product"), `expected nested/product in ${JSON.stringify(rel)}`);

    // Capture the nested HEAD at execution start, then publish new work.
    const baseHeads = await repo.captureNestedRepoHeads();
    const baseSha = baseHeads.get("nested/product");
    assert.ok(baseSha, "nested repo HEAD must be captured at execution start");
    await advanceNestedRepo(nested, "v2", true);
    const endSha = await git(nested, "rev-parse", "HEAD");
    assert.notEqual(endSha, baseSha, "nested HEAD must have advanced");

    const records = await repo.recordNestedRepoPublications({
      missionId: "MSN-test",
      anchoredRepoId: "REPO-anchored",
      baseHeads,
    });
    assert.equal(records.length, 1, `expected exactly one publication, got ${JSON.stringify(records)}`);
    const record = records[0]!;
    assert.equal(record.missionId, "MSN-test");
    assert.equal(record.anchoredRepoId, "REPO-anchored");
    assert.equal(record.nestedPath, "nested/product");
    assert.equal(record.remoteUrl, remotePath, "remoteUrl must be the origin remote");
    assert.equal(record.baseSha, baseSha);
    assert.equal(record.headSha, endSha);
    assert.equal(record.publishedSha, endSha, "publishedSha must equal headSha after push");
    assert.match(record.diffStat, /product\.txt/, "diffStat must summarize the nested change");
    assert.ok(!Number.isNaN(Date.parse(record.capturedAt)), "capturedAt must be a timestamp");

    // Gate acceptance: HEAD advanced and the work is on the nested remote.
    assert.ok(isAcceptable(record), "recorded publication must satisfy the gate acceptance rule");

    // Re-verification (validation step evidence) passes while HEAD is unchanged.
    const verification = await repo.verifyNestedRepoPublication(record);
    assert.equal(verification.verified, true);
  } finally {
    await harness.cleanup();
  }
});

test("nested repo publication: unpushed nested work is recorded but not gate-acceptable", async () => {
  const harness = await makeAnchoredRepo();
  try {
    const { path: nested } = await makeNestedRepo(harness.root, "nested/private");
    const repo = (await GitRepo.open(harness.root))!;
    const baseHeads = await repo.captureNestedRepoHeads();
    const baseSha = baseHeads.get("nested/private")!;
    await advanceNestedRepo(nested, "unpushed", false);

    const records = await repo.recordNestedRepoPublications({
      missionId: "MSN-test",
      anchoredRepoId: "REPO-anchored",
      baseHeads,
    });
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.headSha, await git(nested, "rev-parse", "HEAD"));
    assert.notEqual(record.publishedSha, record.headSha, "remote does not carry the new head");
    assert.ok(!isAcceptable(record), "unpublished nested work must NOT be accepted as candidate evidence");
  } finally {
    await harness.cleanup();
  }
});

test("nested repo without new commits produces no publication record", async () => {
  const harness = await makeAnchoredRepo();
  try {
    await makeNestedRepo(harness.root, "nested/quiet");
    const repo = (await GitRepo.open(harness.root))!;
    const baseHeads = await repo.captureNestedRepoHeads();
    const records = await repo.recordNestedRepoPublications({
      missionId: "MSN-test",
      anchoredRepoId: "REPO-anchored",
      baseHeads,
    });
    assert.deepEqual(records, [], "no HEAD advancement means no publication record");
  } finally {
    await harness.cleanup();
  }
});

test("a worktree of the anchored repo found in the tree is excluded from discovery", async () => {
  const harness = await makeAnchoredRepo();
  try {
    const { path: nested } = await makeNestedRepo(harness.root, "nested/real");
    // Add a linked worktree of the ANCHORED repo inside its own working tree.
    await git(harness.root, "worktree", "add", "-q", join(harness.root, "inner-wt"), "-b", "inner-branch");
    const repo = (await GitRepo.open(harness.root))!;
    const discovered = await repo.discoverNestedRepos().then((refs) => refs.map((ref) => ref.nestedPath));
    assert.ok(!discovered.includes("inner-wt"), `anchored worktree must be excluded: ${JSON.stringify(discovered)}`);
    assert.ok(discovered.includes("nested/real"), "the genuine nested repo must still be discovered");
    // The worktree's common dir equals the anchored common dir — the exclusion is
    // structural, not an accident of path ordering.
    const heads = await repo.captureNestedRepoHeads();
    assert.equal(heads.has("inner-wt"), false);
    assert.ok(heads.has("nested/real"));
  } finally {
    await harness.cleanup();
  }
});

test("dependency and build directories are skipped during discovery", async () => {
  const harness = await makeAnchoredRepo();
  try {
    await makeNestedRepo(harness.root, "nested/real");
    // A git repo hidden inside node_modules and a repo beyond the bounded depth.
    const inDeps = join(harness.root, "node_modules", "pkg");
    await mkdir(inDeps, { recursive: true });
    await git(inDeps, "init", "-q");
    const deep = join(harness.root, "a", "b", "c", "d", "e");
    await mkdir(deep, { recursive: true });
    await git(deep, "init", "-q");
    const repo = (await GitRepo.open(harness.root))!;
    const discovered = (await repo.discoverNestedRepos()).map((ref) => ref.nestedPath);
    assert.ok(!discovered.some((path) => path.startsWith("node_modules")), "node_modules must be skipped");
    assert.ok(!discovered.some((path) => path.startsWith("a/b/c")), "depth beyond the bound must not be scanned");
    assert.deepEqual(discovered, ["nested/real"]);
  } finally {
    await harness.cleanup();
  }
});

test("nested publication record is durable and re-readable by a fresh GitRepo instance", async () => {
  const harness = await makeAnchoredRepo();
  try {
    const { path: nested } = await makeNestedRepo(harness.root, "nested/product");
    const repo = (await GitRepo.open(harness.root))!;
    const baseHeads = await repo.captureNestedRepoHeads();
    await advanceNestedRepo(nested, "v2", true);
    const written = await repo.recordNestedRepoPublications({
      missionId: "MSN-durable",
      anchoredRepoId: "REPO-anchored",
      baseHeads,
    });
    assert.equal(written.length, 1);

    // Fresh instantiation (same pattern as candidate-store durability tests).
    const reopened = (await GitRepo.open(harness.root))!;
    const inventory = await reopened.loadNestedRepoPublications("MSN-durable", "REPO-anchored");
    assert.equal(inventory.diagnostics.length, 0, JSON.stringify(inventory.diagnostics));
    assert.equal(inventory.records.length, 1);
    const reloaded = inventory.records[0]!;
    assert.equal(reloaded.missionId, "MSN-durable");
    assert.equal(reloaded.anchoredRepoId, "REPO-anchored");
    assert.equal(reloaded.nestedPath, "nested/product");
    assert.equal(reloaded.baseSha, written[0]!.baseSha);
    assert.equal(reloaded.headSha, written[0]!.headSha);
    assert.equal(reloaded.publishedSha, written[0]!.publishedSha);
    assert.equal(reloaded.remoteUrl, written[0]!.remoteUrl);
    assert.equal(reloaded.diffStat, written[0]!.diffStat);
    assert.equal(reloaded.capturedAt, written[0]!.capturedAt);
    // Re-verification still works on the fresh instance.
    assert.equal((await reopened.verifyNestedRepoPublication(reloaded)).verified, true);

    // A different mission must not see the record.
    const other = await reopened.loadNestedRepoPublications("MSN-other", "REPO-anchored");
    assert.equal(other.records.length, 0);

    // No partial files: the candidate store holds only the canonical record.
    const commonDir = await reopened.commonDir();
    const store = join(commonDir, "pi-engineering-candidates");
    const names = await readdir(store);
    assert.ok(!names.some((name) => name.endsWith(".tmp")), `no tmp files may remain: ${JSON.stringify(names)}`);
    assert.ok(names.some((name) => name.startsWith("nestedpub.") && name.endsWith(".json")));

    // The nested publication must not pollute the anchored candidate inventory.
    const candidates = await reopened.loadCandidateLifecycleInventory("MSN-durable", "REPO-anchored");
    assert.equal(candidates.diagnostics.length, 0, JSON.stringify(candidates.diagnostics));
  } finally {
    await harness.cleanup();
  }
});
