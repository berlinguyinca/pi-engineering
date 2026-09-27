import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import {
  WorkspaceManifestResolver,
  WorkspaceScopeError,
  createWorkspaceManifest,
} from "../../src/orchestration/workspaceManifest.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

describe("WorkspaceManifestResolver path policy", () => {
  const exec = promisify(execFile);
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  it("authorizes an explicitly named absolute repository instead of the launch cwd", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const repo = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), repo.cleanup);

    const resolved = await new WorkspaceManifestResolver().resolve(`Implement the change in ${repo.root}`, launchCwd);

    assert.equal(resolved.primaryRepoId, resolved.repositories[0]?.repoId);
    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
    assert.deepEqual(resolved.authorizedRoots, [
      { canonicalPath: repo.root, source: "explicit_user_path", access: "write" },
    ]);
  });

  it("deduplicates lexical aliases after canonicalization", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const repo = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), repo.cleanup);

    const resolved = await new WorkspaceManifestResolver().resolve(
      `Work in ${repo.root} and also ${repo.root}/.`,
      launchCwd,
    );

    assert.equal(resolved.repositories.length, 1);
    assert.equal(resolved.authorizedRoots.length, 1);
  });

  it("extracts a quoted absolute repository path containing spaces", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const container = await mkdtemp(join(tmpdir(), "pi-eng-spaced-"));
    const fixture = await makeFixtureRepo();
    const spacedRepo = join(container, "repository with spaces");
    await rename(fixture.root, spacedRepo);
    cleanup.push(
      () => rm(launchCwd, { recursive: true, force: true }),
      () => rm(container, { recursive: true, force: true }),
      fixture.cleanup,
    );

    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in "${spacedRepo}"`, launchCwd);

    assert.equal(resolved.repositories[0]?.canonicalRoot, spacedRepo);
  });

  it("does not include sentence-ending punctuation in an absolute path", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const repo = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), repo.cleanup);

    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in ${repo.root}.`, launchCwd);

    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
  });

  it("authorizes multiple explicitly named repositories while selecting one primary binding", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const first = await makeFixtureRepo();
    const second = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), first.cleanup, second.cleanup);

    const resolved = await new WorkspaceManifestResolver().resolve(
      `Coordinate ${first.root} with ${second.root}`,
      launchCwd,
    );

    assert.deepEqual(
      resolved.repositories.map((repository) => repository.canonicalRoot),
      [first.root, second.root],
    );
    assert.equal(resolved.primaryRepoId, resolved.repositories[0]?.repoId);
  });

  for (const [label, protectedPath] of [
    ["filesystem root", "/"],
    ["home directory", homedir()],
    ["Pi config", join(homedir(), ".pi")],
    ["Codex config", join(homedir(), ".codex")],
  ] as const) {
    it(`rejects the protected ${label}`, async () => {
      const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
      cleanup.push(() => rm(launchCwd, { recursive: true, force: true }));

      await assert.rejects(
        new WorkspaceManifestResolver().resolve(`Change files in ${protectedPath}`, launchCwd),
        (error: unknown) => error instanceof WorkspaceScopeError && error.category === "WORKSPACE_SCOPE_MISMATCH",
      );
    });
  }

  it("rejects nonexistent targets whose parent has not been authorized", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const unauthorizedParent = await mkdtemp(join(tmpdir(), "pi-eng-unauthorized-"));
    cleanup.push(
      () => rm(launchCwd, { recursive: true, force: true }),
      () => rm(unauthorizedParent, { recursive: true, force: true }),
    );

    await assert.rejects(
      new WorkspaceManifestResolver().resolve(
        `Create the project at ${join(unauthorizedParent, "missing", "repo")}`,
        launchCwd,
      ),
      /does not exist|unauthorized parent/i,
    );
  });

  it("rejects a symlink that escapes the explicitly named lexical root", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const workspace = await mkdtemp(join(tmpdir(), "pi-eng-workspace-"));
    const repo = await makeFixtureRepo();
    const link = join(workspace, "escaped-repo");
    await symlink(repo.root, link, "dir");
    cleanup.push(
      () => rm(launchCwd, { recursive: true, force: true }),
      () => rm(workspace, { recursive: true, force: true }),
      repo.cleanup,
    );

    await assert.rejects(new WorkspaceManifestResolver().resolve(`Implement in ${link}`, launchCwd), /symlink/i);
  });

  it("stops execution when an authorized subdirectory is replaced by a symlink after preflight", async () => {
    const repo = await makeFixtureRepo();
    const outside = await mkdtemp(join(tmpdir(), "pi-eng-outside-"));
    cleanup.push(repo.cleanup, () => rm(outside, { recursive: true, force: true }));
    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in ${join(repo.root, "src")}`, tmpdir());
    const registry = new RepositoryRegistry();
    const manifest = createWorkspaceManifest(resolved, "MSN-toctou");
    await registry.register(manifest);
    await registry.resolveForExecution(manifest.missionId, manifest.generation, manifest.hash, resolved.primaryRepoId, [
      "src/new-directory/**",
    ]);
    await rm(join(repo.root, "src"), { recursive: true, force: true });
    await symlink(outside, join(repo.root, "src"), "dir");

    await assert.rejects(
      registry.resolveForExecution(manifest.missionId, manifest.generation, manifest.hash, resolved.primaryRepoId, [
        "src/**",
      ]),
      /authorized root changed/i,
    );
  });

  it("uses a canonical Git launch cwd only when the request names no absolute path", async () => {
    const repo = await makeFixtureRepo();
    cleanup.push(repo.cleanup);

    const resolved = await new WorkspaceManifestResolver().resolve("Implement the requested change", repo.root);

    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
    assert.equal(resolved.authorizedRoots[0]?.source, "launch_cwd");
  });

  it("accepts an empty Git repository with a valid HEAD during role preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-empty-repo-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await exec("git", ["-C", root, "commit", "--allow-empty", "-q", "-m", "empty baseline"]);

    const resolved = await new WorkspaceManifestResolver().resolve(`Review ${root}`, tmpdir());
    const registry = new RepositoryRegistry();
    await registry.register(createWorkspaceManifest(resolved, "MSN-empty"));
    const probes = await registry.probe(resolved.primaryRepoId);

    assert.equal(resolved.repositories[0]?.canonicalRoot, root);
    assert.equal(probes.find((probe) => probe.role === "reviewer")?.ok, true);
  });

  it("isolates identical repo ids by mission and exposes a staged manifest only after activation", async () => {
    const first = await makeFixtureRepo();
    const second = await makeFixtureRepo();
    cleanup.push(first.cleanup, second.cleanup);
    const firstResolved = await new WorkspaceManifestResolver().resolve(`Implement in ${first.root}`, tmpdir());
    const secondResolved = await new WorkspaceManifestResolver().resolve(`Implement in ${second.root}`, tmpdir());
    const firstManifest = createWorkspaceManifest(firstResolved, "MSN-first");
    const secondManifest = {
      ...createWorkspaceManifest(secondResolved, "MSN-second"),
      repositories: createWorkspaceManifest(secondResolved, "MSN-second").repositories.map((binding) => ({
        ...binding,
        repoId: firstResolved.primaryRepoId,
      })),
      hash: "manifest-second-distinct",
    };
    const registry = new RepositoryRegistry();
    await registry.register(firstManifest);
    const staged = await registry.stage(secondManifest);
    await assert.rejects(
      registry.resolveForExecution(
        secondManifest.missionId,
        secondManifest.generation,
        secondManifest.hash,
        firstResolved.primaryRepoId,
      ),
      /inactive workspace manifest/i,
    );
    assert.equal(
      (
        await registry.resolveForExecution(
          firstManifest.missionId,
          firstManifest.generation,
          firstManifest.hash,
          firstResolved.primaryRepoId,
        )
      ).root,
      first.root,
    );
    staged.activate();
    assert.equal(
      (
        await registry.resolveForExecution(
          secondManifest.missionId,
          secondManifest.generation,
          secondManifest.hash,
          firstResolved.primaryRepoId,
        )
      ).root,
      second.root,
    );
  });

  it("removes repository membership when a newer exact manifest is activated", async () => {
    const repo = await makeFixtureRepo();
    cleanup.push(repo.cleanup);
    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in ${repo.root}`, tmpdir());
    const original = createWorkspaceManifest(resolved, "MSN-removal");
    const registry = new RepositoryRegistry();
    await registry.register(original);
    const replacement = {
      ...original,
      manifestId: "WM-removed",
      generation: original.generation + 1,
      hash: "manifest-with-repository-removed",
      repositories: [],
    };
    const staged = await registry.stage(replacement);
    staged.activate();
    await assert.rejects(
      registry.resolveForExecution(
        replacement.missionId,
        replacement.generation,
        replacement.hash,
        resolved.primaryRepoId,
      ),
      /unknown repository binding/i,
    );
    await assert.rejects(
      registry.resolveForExecution(original.missionId, original.generation, original.hash, resolved.primaryRepoId),
      /inactive workspace manifest/i,
    );
  });

  it("does not treat a repository path found in repository content as user authorization", async () => {
    const launchRepo = await makeFixtureRepo();
    const otherRepo = await makeFixtureRepo();
    await mkdir(join(launchRepo.root, "docs"), { recursive: true });
    cleanup.push(launchRepo.cleanup, otherRepo.cleanup);

    const resolved = await new WorkspaceManifestResolver().resolve("Implement the requested change", launchRepo.root);

    assert.equal(resolved.repositories.length, 1);
    assert.equal(resolved.repositories[0]?.canonicalRoot, launchRepo.root);
    assert.notEqual(resolved.repositories[0]?.canonicalRoot, otherRepo.root);
  });
});
