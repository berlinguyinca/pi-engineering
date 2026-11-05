import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ContextBroker } from "../../src/context/ContextBroker.ts";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import { type OpenedRepository, RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import type { RepositoryBinding, WorkspaceManifest } from "../../src/orchestration/types.ts";
import { WorkspaceScopeError } from "../../src/orchestration/workspaceManifest.ts";

/**
 * Regression: a workspace with many missions binding the SAME repositories
 * must open each repository once per runtime, not once per mission manifest.
 * Each open runs the full safeGit prepare (shadow + LFS scan) of synchronous
 * git subprocesses; before the shared-open cache, 46 manifests x 4 repos
 * measured ~10s of event-loop-blocking spawns on one runtime open.
 */

interface OpenCall {
  root: string;
}

function countingOpenRepo(results: Array<OpenedRepository | null>, calls: OpenCall[]) {
  return async (root: string): Promise<OpenedRepository | null> => {
    calls.push({ root });
    const result = results.shift() ?? null;
    if (!result) return null;
    return result;
  };
}

function fakeOpened(root: string): OpenedRepository {
  return {
    git: { root } as unknown as GitRepo,
    contextBroker: { __fakeRoot: root } as unknown as ContextBroker,
  };
}

function binding(repoId: string, root: string, domains: string[] = ["src/**"]): RepositoryBinding {
  return {
    repoId,
    canonicalRoot: root,
    baseRef: "main",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    writableDomains: domains,
  };
}

function manifest(missionId: string, bindings: RepositoryBinding[]): WorkspaceManifest {
  return {
    manifestId: `WM-${missionId}`,
    missionId,
    generation: 1,
    authorizedRoots: [],
    repositories: bindings,
    dependencyEdges: [],
    hash: `hash-${missionId}`,
    createdAt: new Date(0).toISOString(),
  };
}

describe("RepositoryRegistry shared repository opens", () => {
  it("opens a repository bound by many manifests once per runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-registry-"));
    const opened = fakeOpened(root);
    const calls: OpenCall[] = [];
    const registry = new RepositoryRegistry({
      openRepo: async () => {
        calls.push({ root });
        return opened;
      },
    });

    // 46 is the real-world count of manifests observed in one workspace
    // store; use a smaller number that still proves N>1 sharing.
    for (let i = 0; i < 5; i += 1) {
      await registry.register(manifest(`MSN-${i}`, [binding("repo-shared", root)]));
    }

    assert.equal(calls.length, 1, `expected one open, got ${calls.length}`);
  });

  it("still opens distinct roots separately and keeps per-binding context", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "pi-eng-registry-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "pi-eng-registry-b-"));
    const calls: OpenCall[] = [];
    const registry = new RepositoryRegistry({
      openRepo: countingOpenRepo([fakeOpened(rootA), fakeOpened(rootB), fakeOpened(rootA), fakeOpened(rootB)], calls),
    });

    await registry.register(manifest("MSN-A", [binding("repo-a", rootA, ["a/**"])]));
    await registry.register(manifest("MSN-B", [binding("repo-b", rootB, ["b/**"])]));
    // Same roots again under a different mission: no new opens.
    await registry.register(
      manifest("MSN-C", [binding("repo-a", rootA, ["a/**"]), binding("repo-b", rootB, ["b/**"])]),
    );

    assert.equal(calls.length, 2, `expected two opens, got ${calls.length}: ${JSON.stringify(calls)}`);
    assert.deepEqual(calls.map((c) => c.root).sort(), [rootA, rootB].sort(), "one open per distinct root");

    // Per-binding fields stay binding-specific even though the open is shared.
    registry.activate("MSN-C", 1, "hash-MSN-C", "repo-a");
    const ctxA = registry.current();
    assert.deepEqual(ctxA.writableDomains, ["a/**"]);
    assert.equal(ctxA.verifierCwd, rootA);
  });

  it("retries a failed open instead of caching the failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-registry-retry-"));
    let attempts = 0;
    const registry = new RepositoryRegistry({
      openRepo: async () => {
        attempts += 1;
        return attempts === 1 ? null : fakeOpened(root);
      },
    });

    await assert.rejects(() => registry.register(manifest("MSN-X", [binding("repo-x", root)])), WorkspaceScopeError);
    // A later register must retry the open (the repository may have appeared).
    await registry.register(manifest("MSN-Y", [binding("repo-x", root)]));
    assert.equal(attempts, 2, `expected two attempts, got ${attempts}`);
  });

  it("rejects registration when the repository cannot be opened (unchanged semantics)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-registry-fail-"));
    const registry = new RepositoryRegistry({ openRepo: async () => null });
    await assert.rejects(
      () => registry.register(manifest("MSN-Z", [binding("repo-z", root)])),
      (error: unknown) =>
        error instanceof WorkspaceScopeError && error.message.includes("Repository binding cannot be opened"),
    );
  });

  it("concurrent registers for the same root share one in-flight open", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-registry-conc-"));
    let opens = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new RepositoryRegistry({
      openRepo: async () => {
        opens += 1;
        await gate;
        return fakeOpened(root);
      },
    });

    const first = registry.register(manifest("MSN-P", [binding("repo-p", root)]));
    const second = registry.register(manifest("MSN-Q", [binding("repo-p", root)]));
    // Let both registers reach the shared in-flight open before releasing it.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(opens, 1, `second register must join the in-flight open, opens=${opens}`);
    release();
    await Promise.all([first, second]);
    assert.equal(opens, 1, `expected one in-flight open, got ${opens}`);
  });
});
