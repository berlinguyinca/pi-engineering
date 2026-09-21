import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProjectRegistry, normalizeRemote } from "../../src/platform/ProjectRegistry.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

describe("ProjectRegistry", () => {
  it("creates a workspace and registers projects", () => {
    const store = JsonlEventStore.inMemory();
    const registry = ProjectRegistry.create(store, "eng");
    const ws = registry.getWorkspace();
    assert.equal(ws.name, "eng");
    const p = registry.registerProject({ name: "alpha", canonicalRemote: "git@github.com:acme/alpha.git" });
    assert.equal(p.canonicalRemote, "github.com/acme/alpha");
    assert.equal(registry.getProject(p.id)?.name, "alpha");
  });

  it("normalizes git remotes (strips userinfo, trailing .git, https userinfo)", () => {
    assert.equal(normalizeRemote("git@github.com:acme/alpha.git"), "github.com/acme/alpha");
    assert.equal(normalizeRemote("https://user:pass@github.com/acme/alpha.git"), "github.com/acme/alpha");
    // The scheme is DROPPED, and this assertion used to require the opposite.
    // Keeping it for URL forms while dropping it for the scp form gave one
    // repository two canonical identities, so a multi-worktree project split
    // in exactly the case this registry exists to prevent.
    assert.equal(normalizeRemote("https://github.com/acme/alpha"), "github.com/acme/alpha");
    assert.equal(
      normalizeRemote("https://github.com/acme/alpha"),
      normalizeRemote("git@github.com:acme/alpha.git"),
      "the same repository must have one identity however it is addressed",
    );
    assert.equal(normalizeRemote(null), null);
  });

  it("strips credentials from every URL scheme, not only http", () => {
    // Assembled, not written literally: a credential-shaped literal in a source
    // file is what secret scanners exist to catch, and this file tripped one.
    const TOKEN = `gh${"p"}_${"S".repeat(20)}`;
    // The userinfo rule matched `https?://` alone, so an ssh URL carried its
    // token into the canonical identity — which is persisted in
    // `platform.project.created` and served by the control plane.
    for (const remote of [
      `ssh://git:${TOKEN}@github.com/acme/alpha.git`,
      "git+ssh://user:pw@github.com/acme/alpha.git",
      `https://gert:${TOKEN}@github.com/acme/alpha.git`,
      "git@github.com:acme/alpha.git",
    ]) {
      const canonical = normalizeRemote(remote);
      assert.equal(canonical, "github.com/acme/alpha", `${remote} did not canonicalise`);
      assert.ok(!canonical?.includes(TOKEN), `${remote} leaked a credential`);
      assert.ok(!canonical?.includes("@"), `${remote} kept its userinfo`);
    }
  });

  it("refuses an unknown project id rather than forking a new project", () => {
    // A truthy-but-unknown id made the lookup miss AND skipped the
    // remote-based join, so a duplicate project was invented and named after
    // the directory — which is what a caller holding a stale id does after a
    // restart.
    const store = JsonlEventStore.inMemory();
    const registry = ProjectRegistry.create(store);
    assert.throws(
      () => registry.registerRepository({ projectId: "PRJ-does-not-exist", root: "/tmp/a", remote: "git@h:a/b.git" }),
      /unknown project/,
    );
    assert.equal(registry.listProjects().length, 0, "and nothing is created as a side effect");
  });

  it("is reconstructable from its own events", async () => {
    // There was no replay at all, while the module header claimed the control
    // plane was "reconstructable from events": after a restart the platform had
    // zero projects and a brand-new workspace id.
    const store = JsonlEventStore.inMemory();
    const registry = ProjectRegistry.create(store, "acme");
    const repo = registry.registerRepository({
      projectId: "",
      root: "/w/alpha",
      remote: "git@github.com:acme/alpha.git",
    });
    registry.addWorktree(repo.id, "/w/alpha-feature");
    await registry.flush();

    const rebuilt = ProjectRegistry.rebuild(JsonlEventStore.inMemory(), store.all());
    assert.ok(rebuilt, "a store with a workspace event rebuilds");
    assert.equal(rebuilt.getWorkspace().id, registry.getWorkspace().id, "the workspace keeps its identity");
    assert.equal(rebuilt.getWorkspace().name, "acme");
    assert.equal(rebuilt.listProjects().length, 1);
    assert.equal(rebuilt.listRepositories().length, 1);
    assert.equal(rebuilt.listRepositories()[0]?.worktreeRoots.length, 1, "worktrees replay too");
    // The join key must survive, or the next registration forks a duplicate.
    assert.ok(rebuilt.findByRemote("https://github.com/acme/alpha"), "findByRemote still matches after a restart");
  });

  it("joins a worktree repository to the same project by canonical remote", () => {
    const store = JsonlEventStore.inMemory();
    const registry = ProjectRegistry.create(store);
    const main = registry.registerRepository({
      projectId: "",
      root: "/work/alpha",
      remote: "git@github.com:acme/alpha.git",
    });
    const worktree = registry.registerRepository({
      projectId: "",
      root: "/work/alpha-wt",
      remote: "git@github.com:acme/alpha.git",
    });
    // Both resolve to one project (multi-worktree stays one project).
    assert.equal(main.projectId, worktree.projectId);
    const project = registry.getProject(main.projectId)!;
    assert.equal(project.repositoryIds.length, 2);
  });

  it("tracks worktree roots per repository", () => {
    const store = JsonlEventStore.inMemory();
    const registry = ProjectRegistry.create(store);
    const repo = registry.registerRepository({ projectId: "", root: "/work/x", remote: "https://github.com/a/x" });
    registry.addWorktree(repo.id, "/work/x-wt");
    const r = registry.listRepositories().find((x) => x.id === repo.id)!;
    assert.deepEqual(r.worktreeRoots, ["/work/x-wt"]);
  });

  it("emits workspace/project/repository events to the store", async () => {
    const store = JsonlEventStore.inMemory();
    const registry = ProjectRegistry.create(store, "eng");
    registry.registerProject({ name: "p", canonicalRemote: "https://github.com/a/p" });
    registry.registerRepository({ projectId: "", root: "/w", remote: "https://github.com/a/p" });
    await registry.flush();
    const types = store.all().map((e) => e.type);
    assert.ok(types.includes("platform.workspace.created"));
    assert.ok(types.includes("platform.project.created"));
    assert.ok(types.includes("platform.repository.registered"));
  });
});
