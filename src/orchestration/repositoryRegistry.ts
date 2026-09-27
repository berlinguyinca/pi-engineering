import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ContextBroker } from "../context/ContextBroker.ts";
import { GitRepo } from "../git/GitRepo.ts";
import type { RepositoryBinding, WorkspaceManifest } from "./types.ts";
import { WorkspaceScopeError } from "./workspaceManifest.ts";

export interface RepositoryExecutionContext {
  repoId: string;
  root: string;
  git: GitRepo;
  contextBroker: ContextBroker;
  verifierCwd: string;
}

export type RepositoryRole = "implementer" | "validator" | "integrator" | "reviewer";

export interface RoleAccessProbe {
  role: RepositoryRole;
  repoId: string;
  root: string;
  ok: boolean;
  reason?: string;
}

function contains(root: string, cwd: string): boolean {
  const parent = resolve(root);
  const child = resolve(cwd);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** Repository-scoped Git, semantic-context, and verifier dependencies. */
export class RepositoryRegistry {
  private readonly contexts = new Map<string, RepositoryExecutionContext>();
  private readonly activeRepo = new AsyncLocalStorage<string>();

  async register(manifest: WorkspaceManifest): Promise<void> {
    for (const binding of manifest.repositories) await this.registerBinding(binding);
  }

  private async registerBinding(binding: RepositoryBinding): Promise<void> {
    if (this.contexts.has(binding.repoId)) return;
    const git = await GitRepo.open(binding.canonicalRoot);
    const contextBroker = await ContextBroker.open(binding.canonicalRoot);
    if (!git || !contextBroker) {
      throw new WorkspaceScopeError(
        `Repository binding cannot be opened: ${binding.repoId} (${binding.canonicalRoot})`,
      );
    }
    const canonicalRoot = await realpath(git.root);
    if (canonicalRoot !== binding.canonicalRoot) {
      throw new WorkspaceScopeError(
        `Repository binding changed during preflight: ${binding.canonicalRoot} -> ${canonicalRoot}`,
      );
    }
    this.contexts.set(binding.repoId, {
      repoId: binding.repoId,
      root: canonicalRoot,
      git,
      contextBroker,
      verifierCwd: canonicalRoot,
    });
  }

  get(repoId: string): RepositoryExecutionContext {
    const context = this.contexts.get(repoId);
    if (!context) throw new WorkspaceScopeError(`Unknown repository binding: ${repoId}`);
    return context;
  }

  current(): RepositoryExecutionContext {
    const repoId = this.activeRepo.getStore();
    if (!repoId) throw new WorkspaceScopeError("No repository binding is active for this execution");
    return this.get(repoId);
  }

  activate(repoId: string): void {
    this.get(repoId);
    this.activeRepo.enterWith(repoId);
  }

  async resolve(cwd: string): Promise<RepositoryExecutionContext | null> {
    let canonical = resolve(cwd);
    try {
      canonical = await realpath(cwd);
    } catch {
      // Candidate worktrees can disappear during cleanup; the active binding is
      // still the only authority and is safer than falling back to launch cwd.
    }
    for (const context of this.contexts.values()) {
      if (contains(context.root, canonical)) return context;
    }
    const active = this.activeRepo.getStore();
    return active ? this.get(active) : null;
  }

  async probe(repoId: string): Promise<RoleAccessProbe[]> {
    const context = this.get(repoId);
    const roles: RepositoryRole[] = ["implementer", "validator", "integrator", "reviewer"];
    const probes = await Promise.all(
      roles.map(async (role): Promise<RoleAccessProbe> => {
        try {
          await access(
            context.root,
            role === "implementer" || role === "integrator" ? constants.R_OK | constants.W_OK : constants.R_OK,
          );
          if (role === "integrator" && context.git.root !== context.root)
            throw new Error("Git root differs from binding");
          if (role === "validator" && context.verifierCwd !== context.root)
            throw new Error("verifier cwd differs from binding");
          if (role === "reviewer" && !(await context.contextBroker.repoMap(1)).length) {
            throw new Error("semantic repository context is empty");
          }
          return { role, repoId, root: context.root, ok: true };
        } catch (error) {
          return {
            role,
            repoId,
            root: context.root,
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return probes;
  }

  /** Git facade selected from the async repository binding of the mission. */
  gitFacade(): GitRepo {
    return new Proxy({} as GitRepo, {
      get: (_target, property) => {
        const value = (this.current().git as unknown as Record<PropertyKey, unknown>)[property];
        return typeof value === "function" ? value.bind(this.current().git) : value;
      },
    });
  }
}
