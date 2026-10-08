import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
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

  it("ignores a lone slash between two words instead of extracting a filesystem-root candidate", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const repo = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), repo.cleanup);

    // Build the slash with fromCharCode so no bare slash token is embedded in
    // this test source. The request contains "a" + slash + space (the case the
    // old extraction read as "/") and no absolute repository path.
    const slash = `a${String.fromCharCode(47)}`;
    const request = `Please use care or ${slash} it will not merge`;

    const resolved = await new WorkspaceManifestResolver().resolve(request, repo.root);

    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
    assert.equal(resolved.authorizedRoots[0]?.source, "launch_cwd");
    assert.equal(resolved.authorizedRoots[0]?.canonicalPath, repo.root);
  });

  it("ignores a prose token with a slash between two word characters instead of a nonexistent path", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const repo = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), repo.cleanup);

    // "a/b" between word characters used to be extracted as a short
    // nonexistent path and block resolution; it must be filtered out.
    const slash = String.fromCharCode(47);
    const request = `Pick option a${slash}b for the rollout`;

    const resolved = await new WorkspaceManifestResolver().resolve(request, repo.root);

    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
    assert.equal(resolved.authorizedRoots[0]?.source, "launch_cwd");
  });

  it("still extracts a genuine absolute repository path from the request text", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const repo = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), repo.cleanup);

    const resolved = await new WorkspaceManifestResolver().resolve(
      `Implement the requested change in ${repo.root}`,
      launchCwd,
    );

    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
    assert.equal(resolved.authorizedRoots[0]?.source, "explicit_user_path");
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

  it("authorizes a Pi-managed git checkout under the agent git root instead of refusing it as configuration", async () => {
    // The runtime installs itself under <home>/.pi/agent/git/<host>/<owner>/<repo>,
    // so a checkout there is a workspace, while the rest of <home>/.pi stays
    // protected. A fake HOME keeps the check hermetic.
    const fakeHome = await mkdtemp(join(tmpdir(), "pi-eng-fakehome-"));
    const agentRepo = join(fakeHome, ".pi", "agent", "git", "example.com", "acme", "fixture");
    const configRepo = join(fakeHome, ".pi", "other", "fixture");
    for (const root of [agentRepo, configRepo]) {
      await mkdir(root, { recursive: true });
      await exec("git", ["init", "-q", root]);
      await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await exec("git", ["-C", root, "config", "user.name", "Test"]);
      await exec("git", ["-C", root, "commit", "--allow-empty", "-q", "-m", "initial"]);
    }
    cleanup.push(() => rm(fakeHome, { recursive: true, force: true }));

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const resolver = new WorkspaceManifestResolver();
      const resolved = await resolver.resolve("Implement the requested change", agentRepo);

      assert.equal(resolved.repositories[0]?.canonicalRoot, agentRepo);
      assert.equal(resolved.authorizedRoots[0]?.source, "launch_cwd");

      await assert.rejects(
        resolver.resolve("Implement the requested change", configRepo),
        (error: unknown) =>
          error instanceof WorkspaceScopeError &&
          error.category === "WORKSPACE_SCOPE_MISMATCH" &&
          /Pi\/Codex configuration directory/.test(error.message),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("refuses a nonexistent filesystem target instead of falling back to the launch cwd", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const unauthorizedParent = await mkdtemp(join(tmpdir(), "pi-eng-unauthorized-"));
    cleanup.push(
      () => rm(launchCwd, { recursive: true, force: true }),
      () => rm(unauthorizedParent, { recursive: true, force: true }),
    );

    // A missing path under an existing directory is a filesystem path the
    // user meant (PR #106 final review): refused, never replaced by the launch cwd.
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(
        `Create the project at ${join(unauthorizedParent, "missing", "repo")}`,
        launchCwd,
      ),
      (error: unknown) => error instanceof WorkspaceScopeError,
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

    const resolved = await new WorkspaceManifestResolver().resolve(`target: ${root}\nReview it.`, tmpdir());
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

  it("rejects an async-local repository scope after a newer manifest replaces it", async () => {
    const repo = await makeFixtureRepo();
    cleanup.push(repo.cleanup);
    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in ${repo.root}`, tmpdir());
    const original = createWorkspaceManifest(resolved, "MSN-stale-als");
    const registry = new RepositoryRegistry();
    await registry.register(original);
    registry.activate(original.missionId, original.generation, original.hash, resolved.primaryRepoId);
    const replacement = {
      ...original,
      manifestId: "WM-stale-als-2",
      generation: 2,
      hash: "manifest-stale-als-2",
    };
    const staged = await registry.stage(replacement);
    staged.activate();

    assert.throws(() => registry.get(resolved.primaryRepoId), /inactive workspace manifest/i);
    await assert.rejects(registry.resolve(repo.root), /inactive workspace manifest/i);
  });

  it("fails closed when a path has no direct or common-Git active manifest match", async () => {
    const activeRepo = await makeFixtureRepo();
    const unmatchedRepo = await makeFixtureRepo();
    cleanup.push(activeRepo.cleanup, unmatchedRepo.cleanup);
    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in ${activeRepo.root}`, tmpdir());
    const manifest = createWorkspaceManifest(resolved, "MSN-unmatched-path");
    const registry = new RepositoryRegistry();
    await registry.register(manifest);
    registry.activate(manifest.missionId, manifest.generation, manifest.hash, resolved.primaryRepoId);

    await assert.rejects(registry.resolve(unmatchedRepo.root), /outside every active workspace manifest/i);
  });

  it("fails closed when a path matches more than one active manifest", async () => {
    const repo = await makeFixtureRepo();
    cleanup.push(repo.cleanup);
    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in ${repo.root}`, tmpdir());
    const registry = new RepositoryRegistry();
    await registry.register(createWorkspaceManifest(resolved, "MSN-ambiguous-a"));
    await registry.register(createWorkspaceManifest(resolved, "MSN-ambiguous-b"));

    await assert.rejects(registry.resolve(repo.root), /ambiguous across active mission manifests/i);
  });

  it("restages and activates a durable manifest after bind-before-activate crash", async () => {
    const repo = await makeFixtureRepo();
    cleanup.push(repo.cleanup);
    const resolved = await new WorkspaceManifestResolver().resolve(`Implement in ${repo.root}`, tmpdir());
    const manifest = createWorkspaceManifest(resolved, "MSN-bind-crash");
    const restartedRegistry = new RepositoryRegistry();

    await restartedRegistry.ensureActive(manifest, resolved.primaryRepoId);

    assert.equal(
      (
        await restartedRegistry.resolveForExecution(
          manifest.missionId,
          manifest.generation,
          manifest.hash,
          resolved.primaryRepoId,
        )
      ).root,
      repo.root,
    );
  });

  it("binds owner/repo request references to child git checkouts when launching from a non-git workspace parent", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-parent-"));
    const repoA = await makeFixtureRepo();
    const repoB = await makeFixtureRepo();
    // Move the fixture checkouts so they are immediate children of the parent.
    const dirA = join(launchCwd, "alpha");
    const dirB = join(launchCwd, "beta-gateway");
    await rename(repoA.root, dirA);
    await rename(repoB.root, dirB);
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }));

    const resolved = await new WorkspaceManifestResolver().resolve(
      "Implement the subsystem in some-org/alpha and integrate the GUI in beta-gateway, exposing /inferweave/v1 APIs",
      launchCwd,
    );

    const roots = resolved.authorizedRoots.map((root) => root.canonicalPath).sort();
    assert.deepEqual(roots, [dirA, dirB].sort());
    assert.ok(resolved.authorizedRoots.every((root) => root.source === "request_repo_reference"));
    assert.equal(resolved.repositories.length, 2);
  });

  it("never widens authority to the parent directory itself when request references do not match child checkouts", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-parent-"));
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }));

    await assert.rejects(
      new WorkspaceManifestResolver().resolve(
        "Implement the feature in some-org/does-not-exist and /inferweave/v1/events",
        launchCwd,
      ),
      (error: unknown) => error instanceof WorkspaceScopeError,
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

  it("ignores a quoted filesystem root in prose instead of refusing the mission (session review)", async () => {
    const repo = await makeFixtureRepo();
    cleanup.push(repo.cleanup);
    const root = String.fromCharCode(47);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Make the server mount the app at "${root}" and keep the existing routes`,
      repo.root,
    );
    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
    assert.equal(resolved.authorizedRoots[0]?.source, "launch_cwd");
  });

  it("refuses an existing non-repository write target instead of falling back to the launch cwd", async () => {
    const repo = await makeFixtureRepo();
    const dataDir = await mkdtemp(join(tmpdir(), "pi-eng-data-"));
    cleanup.push(repo.cleanup, () => rm(dataDir, { recursive: true, force: true }));
    // The request names a directory to write into; silently writing the
    // launch repository instead is the PR #106 review defect.
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Write the export files under ${dataDir} when the job runs`, repo.root),
      (error: unknown) => error instanceof WorkspaceScopeError && error.message.includes(dataDir),
    );
  });

  it("ignores paths named in a negation ('do not touch X')", async () => {
    const repo = await makeFixtureRepo();
    const other = await makeFixtureRepo();
    cleanup.push(repo.cleanup, other.cleanup);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Fix the flaky test in ${repo.root}. Do not touch ${other.root} at all.`,
      repo.root,
    );
    assert.deepEqual(
      resolved.repositories.map((r) => r.canonicalRoot),
      [repo.root],
    );
    assert.ok(!resolved.authorizedRoots.some((root) => root.canonicalPath === other.root && root.access === "write"));
  });

  it("refuses a target whose own sentence carries a restriction word, pointing at directives (final review C)", async () => {
    const launchCwd = await mkdtemp(join(tmpdir(), "pi-eng-meta-"));
    const repo = await makeFixtureRepo();
    cleanup.push(() => rm(launchCwd, { recursive: true, force: true }), repo.cleanup);
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`The build does not pass in ${repo.root}; fix it`, launchCwd),
      (error: unknown) => error instanceof WorkspaceScopeError && /writable: \/path/.test(error.message),
    );
    const resolved = await new WorkspaceManifestResolver().resolve(
      `writable: ${repo.root}\nThe build does not pass; fix it`,
      launchCwd,
    );
    assert.equal(resolved.repositories[0]?.canonicalRoot, repo.root);
    assert.equal(resolved.authorizedRoots[0]?.access, "write");
  });

  it("binds a second repository described as read-only as a read root, not a writable repository", async () => {
    const repo = await makeFixtureRepo();
    const evidence = await makeFixtureRepo();
    cleanup.push(repo.cleanup, evidence.cleanup);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Implement the importer in ${repo.root}. Use ${evidence.root} as read-only evidence for the expected format.`,
      repo.root,
    );
    assert.deepEqual(
      resolved.repositories.map((r) => r.canonicalRoot),
      [repo.root],
      "only one writable repository, so no cross-repository mutation",
    );
    assert.deepEqual(
      resolved.authorizedRoots.find((root) => root.canonicalPath === evidence.root),
      { canonicalPath: evidence.root, source: "explicit_user_path", access: "read" },
    );
  });
});

describe("WorkspaceManifestResolver per-clause path intent (PR #106 review)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function repos(count: number): Promise<string[]> {
    const roots: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const repo = await makeFixtureRepo();
      cleanup.push(repo.cleanup);
      roots.push(repo.root);
    }
    return roots;
  }

  function access(resolved: { authorizedRoots: Array<{ canonicalPath: string; access: string }> }, path: string) {
    return resolved.authorizedRoots.find((root) => root.canonicalPath === path)?.access ?? "none";
  }

  function writable(resolved: { repositories: Array<{ canonicalRoot: string }> }): string[] {
    return resolved.repositories.map((repository) => repository.canonicalRoot);
  }

  const isScopeError = (error: unknown) => error instanceof WorkspaceScopeError;

  it("reproduction: read-only reference and implement target in one sentence", async () => {
    const [launch, ref, target] = await repos(3);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Use ${ref} as read-only reference and implement the feature in ${target}`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [target]);
    assert.equal(access(resolved, ref!), "read");
    assert.equal(access(resolved, launch!), "none");
  });

  it("reproduction: target first, then 'keeping X read-only'", async () => {
    const [launch, ref, target] = await repos(3);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Implement the feature in ${target}, keeping ${ref} read-only`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [target]);
    assert.equal(access(resolved, ref!), "read");
  });

  for (const template of [
    (target: string) => `Do not stop until ${target} passes its tests`,
    (target: string) => `Don't just read ${target}, fix the bug there`,
    (target: string) => `Never leave ${target} broken: fix the failing build`,
    (target: string) => `Don’t just read ${target}, fix the bug there`,
  ]) {
    it(`a restriction word in the target's sentence refuses with the directive hint (${template("X")})`, async () => {
      // Final review C: any restriction word makes the sentence's paths
      // read-only; the launch directory is never substituted.
      const [launch, target] = await repos(2);
      await assert.rejects(
        new WorkspaceManifestResolver().resolve(template(target!), launch!),
        (error: unknown) => isScopeError(error) && /writable: \/path/.test(String(error)),
      );
      const resolved = await new WorkspaceManifestResolver().resolve(
        `writable: ${target}\n${template("the repository")}`,
        launch!,
      );
      assert.deepEqual(writable(resolved), [target]);
    });
  }

  it("refuses instead of falling back to the launch cwd when a named target is not a git repository", async () => {
    const [launch] = await repos(1);
    const plain = await mkdtemp(join(tmpdir(), "pi-eng-plain-"));
    cleanup.push(() => rm(plain, { recursive: true, force: true }));
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Implement the feature in ${plain}`, launch!),
      (error: unknown) => isScopeError(error) && /not inside a Git repository|no writable/i.test(String(error)),
    );
  });

  it("refuses instead of falling back when every named path is read-only", async () => {
    const [launch, ref] = await repos(2);
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Use ${ref} as read-only reference for the importer`, launch!),
      isScopeError,
    );
  });

  it("binds the repository of an explicitly named file instead of the launch cwd", async () => {
    const [launch, target] = await repos(2);
    const resolved = await new WorkspaceManifestResolver().resolve(`Fix the bug in ${target}/src/add.js`, launch!);
    assert.deepEqual(writable(resolved), [target]);
  });

  it("cannot smuggle a write target past 'do not touch' with a list", async () => {
    const [launch, a, b, target] = await repos(4);
    // Naming only excluded paths leaves no named target; the launch directory
    // is not silently substituted (PR #106 re-review).
    await assert.rejects(new WorkspaceManifestResolver().resolve(`Do not touch ${a} or ${b}`, launch!), isScopeError);

    const listed = await new WorkspaceManifestResolver().resolve(
      `Fix the bug in ${target}. Do not touch ${a}, ${b}`,
      launch!,
    );
    assert.deepEqual(writable(listed), [target]);

    const joined = await new WorkspaceManifestResolver().resolve(
      `Do not touch ${a} and do not modify ${b}; implement the feature in ${target}`,
      launch!,
    );
    assert.deepEqual(writable(joined), [target]);
    assert.equal(access(joined, b!), "read");
  });

  it("keeps every path in a read-only list read-only", async () => {
    const [launch, a, b, target] = await repos(4);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Keep ${a} and ${b} read-only and implement the feature in ${target}`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [target]);
    assert.equal(access(resolved, a!), "read");
    assert.equal(access(resolved, b!), "read");
  });

  it("does not let a read-only remark after a comma promote the path to writable", async () => {
    const [launch, ref, target] = await repos(3);
    // The remark has no path of its own, so every path in the sentence stays read-only.
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(
        `Use ${ref}, which is read-only, and implement the change in ${target}`,
        launch!,
      ),
      isScopeError,
    );
  });

  it("separates 'do not modify X' from a write target joined by 'but'", async () => {
    const [launch, ref, target] = await repos(3);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Do not modify ${ref} but refactor the parser in ${target}`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [target]);
    assert.equal(access(resolved, ref!), "read");
  });

  it("recognizes negation hidden behind zero-width or full-width characters", async () => {
    const [launch, ref, target] = await repos(3);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Do​ not ｔouch ${ref}. Implement the feature in ${target}`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [target]);
    assert.equal(access(resolved, ref!), "read");
  });

  it("classifies quoted paths per clause", async () => {
    const [launch, ref, target] = await repos(3);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `Use "${ref}" as read-only reference and implement the feature in '${target}'`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [target]);
    assert.equal(access(resolved, ref!), "read");
  });

  it("treats 'X must not be modified' as read-only", async () => {
    const [launch, ref, target] = await repos(3);
    const resolved = await new WorkspaceManifestResolver().resolve(
      `${ref} must not be modified; implement the feature in ${target}`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [target]);
    assert.equal(access(resolved, ref!), "read");
  });

  it("still refuses a directed mutation into the filesystem root", async () => {
    const [launch] = await repos(1);
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Modify files in "/"`, launch!),
      (error: unknown) => isScopeError(error) && /filesystem root/.test(String(error)),
    );
  });

  it("never makes a protected path writable even when it is listed with a real target", async () => {
    const [launch, target] = await repos(1).then(async (first) => [...first, ...(await repos(1))]);
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Change files in ${target} and ${homedir()}`, launch!),
      (error: unknown) => isScopeError(error) && /home directory/.test(String(error)),
    );
  });
});

describe("WorkspaceManifestResolver re-review (PR #106)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function repos(count: number): Promise<string[]> {
    const roots: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const repo = await makeFixtureRepo();
      cleanup.push(repo.cleanup);
      roots.push(repo.root);
    }
    return roots;
  }
  const writable = (resolved: { repositories: Array<{ canonicalRoot: string }> }) =>
    resolved.repositories.map((repository) => repository.canonicalRoot);
  const access = (resolved: { authorizedRoots: Array<{ canonicalPath: string; access: string }> }, path: string) =>
    resolved.authorizedRoots.find((root) => root.canonicalPath === path)?.access ?? "none";
  const isScopeError = (error: unknown) => error instanceof WorkspaceScopeError;

  it("never falls back to a launch directory the request excluded", async () => {
    const [launch] = await repos(1);
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Do not touch ${launch}. Build the feature.`, launch!),
      isScopeError,
    );
  });

  it("refuses a mutation-directed path that does not exist instead of writing the launch repo", async () => {
    const [launch, target] = await repos(2);
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Implement the feature in ${target}e`, launch!),
      (error: unknown) => isScopeError(error) && /does not exist/.test(String(error)),
    );
  });

  for (const template of [
    (ref: string, target: string) => `Leave ${ref} alone and fix ${target}`,
    (ref: string, target: string) => `Do not make any changes to ${ref}; fix ${target}`,
    (ref: string, target: string) => `${ref} must stay unchanged. Fix ${target}.`,
    (ref: string, target: string) => `Copy the approach of ${ref}, then implement it in ${target}`,
    (ref: string, target: string) => `Look at ${ref} and fix the same bug in ${target}`,
  ]) {
    it(`keeps a non-target path read-only: ${template("REF", "TARGET")}`, async () => {
      const [launch, ref, target] = await repos(3);
      const resolved = await new WorkspaceManifestResolver().resolve(template(ref!, target!), launch!);
      assert.deepEqual(writable(resolved), [target]);
      assert.equal(access(resolved, ref!), "read");
    });
  }

  it("a mutation verb with 'from' still targets the path", async () => {
    const [launch, target] = await repos(2);
    const resolved = await new WorkspaceManifestResolver().resolve(`Remove the dead code from ${target}`, launch!);
    assert.deepEqual(writable(resolved), [target]);
  });

  it("never makes a system or credential directory writable", async () => {
    const [launch] = await repos(1);
    for (const path of ["/etc/nginx", "/etc", join(homedir(), ".ssh"), "/proc/self", join(homedir(), ".claude")]) {
      await assert.rejects(
        new WorkspaceManifestResolver().resolve(`fix ${path}`, launch!),
        (error: unknown) => isScopeError(error) && /protected/i.test(String(error)),
        path,
      );
    }
  });

  it("an input file outside any repository keeps the launch repository as the target; another repository does not", async () => {
    const [launch, other] = await repos(2);
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-crash-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const log = join(dir, "crash.log");
    await writeFile(log, "boom\n");
    const input = await new WorkspaceManifestResolver().resolve(`Analyze ${log} and fix the bug`, launch!);
    assert.deepEqual(writable(input), [launch]);
    assert.equal(access(input, log), "read");
    // A different repository named only as a reference rules the launch default out.
    await assert.rejects(
      new WorkspaceManifestResolver().resolve(`Use ${other} for reference and fix the bug`, launch!),
      isScopeError,
    );
    const resolved = await new WorkspaceManifestResolver().resolve(
      `writable: ${launch}\nread-only: ${log}\nAnalyze the log and fix the bug`,
      launch!,
    );
    assert.deepEqual(writable(resolved), [launch]);
    assert.equal(access(resolved, log), "read");
  });
});
