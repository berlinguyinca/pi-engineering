/**
 * Alternative implementation forks and their promotion (T13), the Pi half.
 *
 * Herdr proposes, a different room owner confirms, and Herdr delivers a typed `fork` or `promote` request on the same
 * keyed steering channel as T12 (see steering.ts). This module is what Pi does with such a request:
 *
 *  - FORK: an isolated branch and worktree at a commit the person chose (fenced by Herdr to what the origin node
 *    shows, re-checked here against the repository). The approach id, the branch name and the path are all DERIVED by
 *    Pi from the steering id; nothing in a request names a branch, a path or a command. The original branch, its
 *    worktree and its evidence are never touched: this module has no code path that deletes, resets, forces or prunes.
 *  - PROMOTE: push EXACTLY the commit the person reviewed (never forced) and open a draft pull request through the T05
 *    GitHub client, then record the link. It never merges. Siblings are only MARKED superseded in lineage (and in this
 *    registry); their branches and worktrees stay on disk. The ack says `applied` only after the push and the PR link
 *    really happened.
 *
 * Standalone Pi is unchanged: nothing here is constructed unless the GLOBAL engineering YAML enables `forks:` and a
 * Herdr control plane is configured (see runtime wiring), and promotion has its own, separate switch.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shortHash } from "../git/GitRepo.ts";
import { FORK_BRANCH, FULL_SHA, type ForkGit } from "../git/forkGit.ts";
import {
  type GhPullRequest,
  type GithubClient,
  type GithubLinkStore,
  type RefConfig,
  type RepoKey,
  emitLinkRecorded,
  linkPullRequest,
  normaliseRepo,
} from "../github/index.ts";
import type { LineageEmitter } from "../runtime/herdr/lineage.ts";
import { atomicWriteFile, withFileLock } from "../runtime/herdr/portableLock.ts";
import { type ForkParams, approachNodeId, clean, forkBranchFor, forkIdFor } from "./forkParams.ts";
import type { SteeringAck, SteeringItem } from "./steering.ts";

export { type ForkParams, approachNodeId, forkBranchFor, forkIdFor, parseForkParams } from "./forkParams.ts";

export type ForkLineage = Pick<LineageEmitter, "nodeUpsert" | "nodeState" | "edgeAdd" | "edgeRemove">;

export interface ForkOrigin {
  nodeId: string;
  missionId: string;
  taskId: string;
  repoRoot: string;
  baseBranch: string;
}
export type OriginResolution = ForkOrigin | { unresolvable: string } | null;

export type ForkStatus = "creating" | "active" | "promoting" | "selected" | "superseded" | "failed";

export interface ForkRecord {
  approachId: string;
  originNodeId: string;
  room: string;
  missionId: string;
  taskId: string;
  repoRoot: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
  label: string;
  status: ForkStatus;
  steeringId: string;
  createdAt: string;
  headSha: string | null;
  verifiedHead?: string | null;
  pushed?: boolean;
  pr?: string;
  promotedAt?: string;
  supersededBy?: string;
  note?: string;
}

export interface ForkLimits {
  maxTotal: number;
  maxPerOrigin: number;
  minFreeMb: number;
}
export const DEFAULT_FORK_LIMITS: ForkLimits = { maxTotal: 6, maxPerOrigin: 3, minFreeMb: 2048 };

const LIVE: ReadonlySet<ForkStatus> = new Set(["creating", "active", "promoting"]);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ─── durable registry ─────────────────────────────────────────────────────────────────────────────────────────

interface RegistryFile {
  version: 1;
  records: Record<string, ForkRecord>;
}

/**
 * One JSON file under the state dir. Every mutation runs under a cross-process file lock, re-reads the file and
 * writes atomically (0600), so two Pi processes sharing a state dir cannot both claim a promotion. A file that
 * does not parse is an ERROR (fail closed): it is never replaced by an empty one.
 */
export class ForkRegistry {
  private readonly file: string;
  private cache: RegistryFile | null = null;
  constructor(file: string) {
    this.file = file;
  }

  private read(): RegistryFile {
    if (!existsSync(this.file)) return { version: 1, records: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("the fork registry is unreadable; refusing to continue (it is not replaced)");
    }
    if (!isPlain(parsed) || parsed.version !== 1 || !isPlain(parsed.records)) {
      throw new Error("the fork registry has an unknown format; refusing to continue");
    }
    return parsed as unknown as RegistryFile;
  }

  /** Last state this process saw; always call `mutate` to decide anything. */
  get(approachId: string): ForkRecord | undefined {
    try {
      this.cache = this.read();
    } catch {
      return this.cache?.records[approachId];
    }
    return this.cache.records[approachId];
  }

  list(): ForkRecord[] {
    try {
      this.cache = this.read();
    } catch {
      /* keep the last good view */
    }
    return Object.values(this.cache?.records ?? {});
  }

  /** Read-modify-write under the lock. `fn` must be synchronous and must not throw after partial changes. */
  async mutate<T>(fn: (records: Record<string, ForkRecord>) => T): Promise<T> {
    mkdirSync(dirname(this.file), { recursive: true });
    return withFileLock(`${this.file}.lock`, async () => {
      const data = this.read();
      const result = fn(data.records);
      await atomicWriteFile(this.file, `${JSON.stringify(data)}\n`);
      this.cache = data;
      return result;
    });
  }
}

// ─── the manager ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PromoteDeps {
  client: GithubClient;
  store: GithubLinkStore;
  refCfg: RefConfig;
  draft: boolean;
  /** Used when the origin remote cannot be parsed. */
  defaultRepo?: RepoKey;
}

export interface ForkVerifier {
  (worktree: string, head: string): Promise<{ passed: boolean; summary: string }>;
}

export interface ForkManagerOptions {
  registry: ForkRegistry;
  git: (repoRoot: string) => ForkGit;
  lineage: ForkLineage | null;
  limits?: ForkLimits;
  /** Present only when promotion is enabled in the global YAML. */
  promote?: PromoteDeps | null;
  verify?: ForkVerifier | null;
  originUrl?: (repoRoot: string) => Promise<string | null>;
  now?: () => number;
  log?: (message: string) => void;
}

const ack = (outcome: SteeringAck["outcome"], note: string): SteeringAck => ({ outcome, note: note.slice(0, 280) });

export class ForkManager {
  private readonly o: ForkManagerOptions;
  private readonly limits: ForkLimits;
  private refreshing = false;
  constructor(opts: ForkManagerOptions) {
    this.o = opts;
    this.limits = opts.limits ?? DEFAULT_FORK_LIMITS;
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  get promotionEnabled(): boolean {
    return !!this.o.promote;
  }

  /** Is this approach node one of ours? (used to decide whether a promote request is for this instance) */
  knowsApproach(nodeId: string): boolean {
    if (!nodeId.startsWith("approach:")) return false;
    return this.o.registry.get(nodeId.slice("approach:".length)) !== undefined;
  }

  private scope(rec: ForkRecord) {
    return { mission_id: rec.missionId, task_id: rec.taskId };
  }

  private emitApproach(
    rec: ForkRecord,
    extra: Record<string, unknown> = {},
    state: "running" | "selected" | "superseded" | "failed" = "running",
  ): void {
    const id = approachNodeId(rec.approachId);
    this.o.lineage?.nodeUpsert(
      id,
      {
        label: rec.label || rec.approachId,
        state,
        attrs: {
          approach_id: rec.approachId,
          origin_id: rec.originNodeId,
          mission_id: rec.missionId,
          task_id: rec.taskId,
          base_sha: rec.baseSha,
          branch: rec.branch,
          worktree_id: rec.approachId,
          ...(rec.headSha ? { head_sha: rec.headSha } : {}),
          ...extra,
        },
      },
      `fork:${rec.approachId}:${state}:${rec.headSha?.slice(0, 12) ?? "-"}:${String(extra.pr ?? "")}`,
      this.scope(rec),
    );
  }

  // ── fork ──────────────────────────────────────────────────────────────────────────────────────────────────

  async create(item: SteeringItem, origin: ForkOrigin | { unresolvable: string }): Promise<SteeringAck> {
    const baseSha = item.params?.baseSha;
    if (!baseSha || !FULL_SHA.test(baseSha)) return ack("refused", "a fork needs a full base commit");
    if ("unresolvable" in origin) return ack("refused", `cannot fork here: ${origin.unresolvable}`);
    const id = forkIdFor(item.steeringId);
    const existing = this.o.registry.get(id);
    if (existing?.status === "active" || existing?.status === "selected" || existing?.status === "superseded") {
      return ack("applied", `already created as ${approachNodeId(id)} (branch ${existing.branch})`);
    }
    const git = this.o.git(origin.repoRoot);
    if (!(await git.commitExists(baseSha))) return ack("refused", "that commit is not in this repository");
    const path = join(dirname(origin.repoRoot), `pi-fork-${shortHash(origin.repoRoot)}-${id}`);
    const free = git.freeDiskMb(path);
    if (free < this.limits.minFreeMb)
      return ack("refused", `not enough free disk (${free} MB, need ${this.limits.minFreeMb})`);
    const branch = forkBranchFor(id);
    if (!FORK_BRANCH.test(branch)) return ack("refused", "internal: derived branch name is invalid");
    const rec: ForkRecord = {
      approachId: id,
      originNodeId: item.nodeId,
      room: item.room,
      missionId: origin.missionId,
      taskId: origin.taskId,
      repoRoot: origin.repoRoot,
      baseBranch: origin.baseBranch,
      baseSha,
      branch,
      worktreePath: path,
      label: item.params?.label ?? "",
      status: "creating",
      steeringId: item.steeringId,
      createdAt: new Date(this.now()).toISOString(),
      headSha: null,
    };
    const admitted = await this.o.registry.mutate((records) => {
      if (records[id]?.status === "creating") return { ok: true as const, resume: true };
      const live = Object.values(records).filter((r) => LIVE.has(r.status));
      if (live.length >= this.limits.maxTotal) return { ok: false as const, why: "the host's fork limit is reached" };
      if (live.filter((r) => r.originNodeId === item.nodeId).length >= this.limits.maxPerOrigin) {
        return { ok: false as const, why: "this origin has reached its fork limit on this host" };
      }
      records[id] = rec;
      return { ok: true as const, resume: false };
    });
    if (!admitted.ok) return ack("refused", admitted.why);
    try {
      if (!(admitted.resume && existsSync(path) && (await git.head(path)) === baseSha))
        await git.addWorktree(path, branch, baseSha);
    } catch (err) {
      await this.o.registry.mutate((records) => {
        const r = records[id];
        if (r) records[id] = { ...r, status: "failed", note: (err as Error).message.slice(0, 200) };
      });
      return ack("refused", `could not create the worktree: ${(err as Error).message}`);
    }
    const created = await this.o.registry.mutate((records) => {
      const r = records[id];
      if (r) records[id] = { ...r, status: "active", headSha: baseSha };
      return records[id];
    });
    if (!created) return ack("refused", "the fork record disappeared");
    this.emitApproach(created, { files_changed: 0, insertions: 0, deletions: 0, touched_paths: [], elapsed_s: 0 });
    this.o.lineage?.edgeAdd(
      "fork",
      item.nodeId,
      approachNodeId(id),
      `fork:${id}`,
      { base_sha: baseSha },
      this.scope(created),
    );
    this.o.lineage?.nodeUpsert(
      `worktree:${id}`,
      { label: id, state: "running", attrs: { branch, base_sha: baseSha } },
      `fork:${id}`,
      this.scope(created),
    );
    this.o.lineage?.edgeAdd(
      "produced",
      approachNodeId(id),
      `worktree:${id}`,
      `fork:${id}`,
      undefined,
      this.scope(created),
    );
    return ack(
      "applied",
      `created ${approachNodeId(id)} on branch ${branch}; start work in its worktree. The original is untouched.`,
    );
  }

  // ── comparison data ───────────────────────────────────────────────────────────────────────────────────────

  /** Re-read each live fork's head and diff and report changes. Cheap when nothing moved. Never throws. */
  async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const rec of this.o.registry.list()) {
        if (rec.status !== "active" && rec.status !== "selected") continue;
        try {
          await this.refresh(rec);
        } catch (err) {
          this.o.log?.(`fork refresh ${rec.approachId}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async refresh(initial: ForkRecord): Promise<void> {
    let rec = initial;
    if (!existsSync(rec.worktreePath)) return;
    const git = this.o.git(rec.repoRoot);
    const head = await git.head(rec.worktreePath);
    if (head === rec.headSha && rec.status !== "active") return;
    if (head !== rec.headSha) {
      const stat = await git.diffStat(rec.baseSha, head);
      const next = await this.o.registry.mutate((records) => {
        const r = records[rec.approachId];
        if (r) records[rec.approachId] = { ...r, headSha: head };
        return records[rec.approachId];
      });
      if (!next) return;
      this.emitApproach(
        next,
        {
          files_changed: stat.files,
          insertions: stat.insertions,
          deletions: stat.deletions,
          touched_paths: stat.paths,
          elapsed_s: Math.max(0, Math.round((this.now() - Date.parse(next.createdAt)) / 1000)),
        },
        next.status === "selected" ? "selected" : "running",
      );
      rec = next;
    }
    if (
      this.o.verify &&
      rec.status === "active" &&
      rec.verifiedHead !== head &&
      (await git.isClean(rec.worktreePath))
    ) {
      const result = await this.o.verify(rec.worktreePath, head);
      await this.o.registry.mutate((records) => {
        const r = records[rec.approachId];
        if (r) records[rec.approachId] = { ...r, verifiedHead: head };
      });
      const gate = `gate:fork-verify-${rec.approachId}-${head.slice(0, 12)}`;
      this.o.lineage?.nodeUpsert(
        gate,
        { label: clean(result.summary, 120), state: result.passed ? "done" : "failed", attrs: { commit: head } },
        `verify:${head}`,
        this.scope(rec),
      );
      if (result.passed)
        this.o.lineage?.edgeAdd(
          "validated",
          gate,
          approachNodeId(rec.approachId),
          `verify:${head}`,
          { commit: head },
          this.scope(rec),
        );
    }
  }

  // ── promote ───────────────────────────────────────────────────────────────────────────────────────────────

  async promote(item: SteeringItem): Promise<SteeringAck> {
    const deps = this.o.promote;
    if (!deps) return ack("unsupported", "promotion is not enabled on this host");
    const id = item.nodeId.startsWith("approach:") ? item.nodeId.slice("approach:".length) : "";
    const expected = item.params?.expectedHead;
    if (!id || !expected || !FULL_SHA.test(expected))
      return ack("refused", "a promotion needs an approach and the exact head");
    const rec0 = this.o.registry.get(id);
    if (!rec0) return ack("refused", "this host does not know that approach");
    if (rec0.room !== item.room) return ack("refused", "the fork belongs to a different room");
    if (item.params?.origin && item.params.origin !== rec0.originNodeId)
      return ack("stale", "the approach belongs to another origin");
    if (rec0.status === "selected" && rec0.pr) return ack("applied", `already promoted as ${rec0.pr}`);
    if (rec0.status !== "active" && rec0.status !== "promoting") return ack("refused", `the fork is ${rec0.status}`);

    // Compare-and-set: one promotion per origin, across processes. A leftover `promoting` claim of THIS approach
    // (a retry after a failed pull request) is resumable; anyone else's claim is not.
    const claim = await this.o.registry.mutate((records) => {
      const me = records[id];
      if (!me || (me.status !== "active" && me.status !== "promoting"))
        return { ok: false as const, why: "the fork is not promotable" };
      const other = Object.values(records).find(
        (r) =>
          r.approachId !== id &&
          r.originNodeId === me.originNodeId &&
          (r.status === "promoting" || r.status === "selected"),
      );
      if (other)
        return {
          ok: false as const,
          why: `${approachNodeId(other.approachId)} already holds the promotion for this origin`,
        };
      records[id] = { ...me, status: "promoting" };
      return { ok: true as const };
    });
    if (!claim.ok) return ack("refused", claim.why);
    const release = async (note: string): Promise<void> => {
      await this.o.registry.mutate((records) => {
        const r = records[id];
        if (r && r.status === "promoting") records[id] = { ...r, status: "active", note: note.slice(0, 200) };
      });
    };
    try {
      const rec = this.o.registry.get(id) as ForkRecord;
      const git = this.o.git(rec.repoRoot);
      const head = await git.head(rec.worktreePath);
      if (head !== expected) {
        await release("head moved");
        return ack("stale", "the fork head is not the commit that was confirmed; nothing was pushed");
      }
      if (!(await git.isClean(rec.worktreePath))) {
        await release("uncommitted changes");
        return ack(
          "refused",
          "the fork worktree has uncommitted changes; commit them and propose again. Nothing was pushed",
        );
      }
      if (!(await git.isAncestor(rec.baseSha, head))) {
        await release("not based on base");
        return ack("refused", "the fork no longer descends from its base commit; nothing was pushed");
      }
      const repo = await this.repoOf(rec, deps);
      if (!repo) {
        await release("no repo");
        return ack("refused", "cannot tell which GitHub repository this is; set forks.promote.github.default_repo");
      }
      if (!deps.client.createPullRequest || !deps.client.findOpenPullRequestByHead) {
        await release("client");
        return ack("unsupported", "the GitHub client on this host cannot open pull requests");
      }
      // Remote check BEFORE pushing: an existing remote branch with other content is never overwritten.
      const remote = await git.remoteBranchHead(rec.branch);
      if (remote !== null && remote !== head) {
        await release("remote differs");
        return ack("refused", "the branch already exists on origin with different content; nothing was changed");
      }
      if (remote === null) {
        const pushed = await git.push(rec.branch, head);
        if (!pushed.ok) {
          await release("push refused");
          return ack("refused", `push refused: ${pushed.reason ?? "unknown"}`);
        }
      }
      await this.o.registry.mutate((records) => {
        const r = records[id];
        if (r) records[id] = { ...r, pushed: true };
      });
      // Reuse the PR if one is already open for this exact branch; otherwise open a DRAFT. Never merge.
      let pr: GhPullRequest | null = await deps.client.findOpenPullRequestByHead(repo, rec.branch);
      if (!pr) {
        pr = await deps.client.createPullRequest({
          repo,
          head: rec.branch,
          base: rec.baseBranch,
          title: clean(`Fork: ${rec.label || rec.approachId}`, 120),
          body: [
            `Alternative implementation ${approachNodeId(rec.approachId)} of ${rec.originNodeId}.`,
            `Base ${rec.baseSha}, head ${head}.`,
            `Promoted in Herdr: proposed by ${item.proposedBy}, confirmed by ${item.confirmedBy} (room ${item.room}).`,
            "Opened as a draft by Pi after that confirmation. Nothing here merges automatically.",
          ].join("\n"),
          draft: deps.draft,
        });
      }
      if (pr.headSha !== head) {
        await release("pr head differs");
        return ack(
          "refused",
          `the pull request head (${pr.headSha.slice(0, 12)}) is not the confirmed commit; not linked`,
        );
      }
      const links = await linkPullRequest(deps.client, deps.store, {
        missionId: rec.missionId,
        prRef: pr.ref,
        subjects: [{ kind: "task", id: rec.taskId }],
        headSha: head,
        provenance: "pr_create_output",
      });
      if (this.o.lineage) for (const l of links) emitLinkRecorded(this.o.lineage, l);
      const prNode = `pr:${pr.ref.host}/${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`.toLowerCase();
      const final = await this.o.registry.mutate((records) => {
        const r = records[id];
        if (r) records[id] = { ...r, status: "selected", pr: prNode, promotedAt: new Date(this.now()).toISOString() };
        const marked: string[] = [];
        for (const s of Object.values(records)) {
          if (
            s.approachId !== id &&
            s.originNodeId === rec.originNodeId &&
            (s.status === "active" || s.status === "creating")
          ) {
            records[s.approachId] = { ...s, status: "superseded", supersededBy: id };
            marked.push(s.approachId);
          }
        }
        return { rec: records[id], marked };
      });
      const winner = approachNodeId(id);
      this.emitApproach(final.rec as ForkRecord, { pr: prNode, pushed_head: head }, "selected");
      this.o.lineage?.edgeAdd("produced", winner, prNode, `promote:${id}`, { commit: head }, this.scope(rec));
      const siblings = new Set<string>([...final.marked.map(approachNodeId), ...(item.params?.siblings ?? [])]);
      siblings.delete(winner);
      for (const s of siblings) {
        this.o.lineage?.edgeAdd("supersession", winner, s, `promote:${id}`, { by: id }, this.scope(rec));
        if (final.marked.map(approachNodeId).includes(s)) {
          this.o.lineage?.nodeState(
            s,
            "superseded",
            `promote:${id}`,
            { reason: `superseded by ${winner}` },
            this.scope(rec),
          );
        }
      }
      return ack(
        "applied",
        `pushed ${head.slice(0, 12)} to ${rec.branch}; draft PR ${prNode}; ${siblings.size} sibling(s) marked superseded in lineage only (branches and worktrees kept). Nothing was merged.`,
      );
    } catch (err) {
      await release("failed").catch(() => undefined);
      const m = (err as Error).message ?? "error";
      return ack(
        "refused",
        `promotion stopped: ${m}. Nothing was merged or deleted${this.o.registry.get(id)?.pushed ? "; the branch was pushed" : ""}`,
      );
    }
  }

  private async repoOf(rec: ForkRecord, deps: PromoteDeps): Promise<RepoKey | undefined> {
    const url = this.o.originUrl ? await this.o.originUrl(rec.repoRoot).catch(() => null) : null;
    const m = url
      ? /^(?:https:\/\/|ssh:\/\/git@|git@)([A-Za-z0-9.\-]+)[/:]([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+?)(?:\.git)?\/?$/.exec(
          url,
        )
      : null;
    if (m) {
      const parsed = normaliseRepo(m[1] as string, m[2] as string, m[3] as string, deps.refCfg);
      if (parsed) return parsed;
    }
    return deps.defaultRepo;
  }
}
