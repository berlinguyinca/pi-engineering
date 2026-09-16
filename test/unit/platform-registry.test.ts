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
    // URL-form keeps its scheme (distinguishes http vs https in canonical identity).
    assert.equal(normalizeRemote("https://github.com/acme/alpha"), "https://github.com/acme/alpha");
    assert.equal(normalizeRemote(null), null);
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
