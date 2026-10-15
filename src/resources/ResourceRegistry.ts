import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExclusiveFileLock } from "../platform/eventstore/fileLock.ts";

/**
 * Crash-safe local registry of owned resources (autospec R-RES, issue #142).
 *
 * Ownership is recorded BEFORE a resource is created, so cleanup never guesses
 * what it may delete: a record names the owning mission and execution, the host
 * that created it and the lease that guards it. Release is refused for a
 * foreign owner, a foreign host and an owning mission that is still active.
 *
 * One JSON file per resource id under `<stateDir>/resources/`, created with
 * `link` (atomic create-once) and updated with temp-file plus `rename`, so a
 * crash leaves either the old record or the new one, never a torn one. Every
 * mutation runs under one cross-process lock. This module never deletes
 * anything on disk besides its own record bookkeeping; deleting the resource is
 * the caller's job between `beginRelease` and `completeRelease`.
 *
 * Field names mirror autospec `resource-record.v1` (camelCase here; see
 * {@link toProtocolResourceRecord} for the exact wire mapping). Two local
 * states are finer than the protocol's: `releasing` is the crash window
 * between beginRelease and completeRelease (wire: `releasable`) and `retained`
 * is a resource kept after a failed release (wire: `retained_for_diagnostics`).
 */

export const RESOURCE_KINDS = ["worktree", "process", "build_dir", "cache", "container", "temp_file"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_STATES = ["active", "releasing", "released", "retained"] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const RESOURCE_SCHEMA_VERSION = 1;

export interface ResourceRecord {
  schemaVersion: number;
  id: string;
  kind: ResourceKind;
  ownerMissionId: string;
  ownerExecutionId: string;
  /** The host that created the resource; only that host may release it. */
  hostId: string;
  /** Filesystem path, or an opaque handle (pid, container id) for non-path kinds. */
  locator: string;
  createdAt: string;
  /** Id of the lease that guards the resource (protocol `lease_id`). */
  lease: string;
  state: ResourceState;
  bytes?: number;
  inodes?: number;
  /** Why a release failed and the resource was kept (set with state `retained`). */
  retainedReason?: string;
}

export type RegisterInput = Pick<
  ResourceRecord,
  "id" | "kind" | "ownerMissionId" | "ownerExecutionId" | "locator" | "lease"
> &
  Partial<Pick<ResourceRecord, "createdAt" | "bytes" | "inodes">>;

export interface ResourceOwner {
  missionId: string;
  executionId: string;
}

export type BeginReleaseResult =
  | { status: "ok"; record: ResourceRecord }
  | { status: "foreign"; record: ResourceRecord }
  | { status: "active"; record: ResourceRecord }
  | { status: "missing" };

export interface ReconcileDiagnostic {
  id: string;
  action: "completed" | "rolled_back" | "quarantined";
  reason: string;
}

/** Whether the owning mission is still using its resources. */
export type MissionActivity = (missionId: string) => boolean | Promise<boolean>;

const LOCK_WAIT_MS = 30_000;
/** Kinds whose `locator` is a filesystem path whose absence proves the deletion happened. */
const PATH_KINDS: ReadonlySet<ResourceKind> = new Set(["worktree", "build_dir", "cache", "temp_file"]);

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`resource ${label} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is ResourceRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.schemaVersion === RESOURCE_SCHEMA_VERSION &&
    typeof r.id === "string" &&
    r.id.length > 0 &&
    (RESOURCE_KINDS as readonly unknown[]).includes(r.kind) &&
    typeof r.ownerMissionId === "string" &&
    typeof r.ownerExecutionId === "string" &&
    typeof r.hostId === "string" &&
    typeof r.locator === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.lease === "string" &&
    (RESOURCE_STATES as readonly unknown[]).includes(r.state)
  );
}

function fileFor(id: string): string {
  return `res-${createHash("sha256").update(id).digest("hex")}.json`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
  );
}

export class ResourceRegistry {
  private readonly dir: string;
  private readonly hostId: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, hostId: string) {
    this.dir = join(stateDir, "resources");
    this.hostId = nonEmpty(hostId, "hostId");
  }

  /** Records ownership. Idempotent on id; a different owner for a known id is an error. */
  async register(input: RegisterInput): Promise<ResourceRecord> {
    nonEmpty(input.id, "id");
    if (!(RESOURCE_KINDS as readonly unknown[]).includes(input.kind)) {
      throw new Error(`resource kind must be one of ${RESOURCE_KINDS.join(", ")}`);
    }
    nonEmpty(input.ownerMissionId, "ownerMissionId");
    nonEmpty(input.ownerExecutionId, "ownerExecutionId");
    nonEmpty(input.locator, "locator");
    nonEmpty(input.lease, "lease");
    const record: ResourceRecord = {
      schemaVersion: RESOURCE_SCHEMA_VERSION,
      id: input.id,
      kind: input.kind,
      ownerMissionId: input.ownerMissionId,
      ownerExecutionId: input.ownerExecutionId,
      hostId: this.hostId,
      locator: input.locator,
      createdAt: input.createdAt ?? new Date().toISOString(),
      lease: input.lease,
      state: "active",
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      ...(input.inodes !== undefined ? { inodes: input.inodes } : {}),
    };
    return this.locked(async () => {
      const known = await this.read(record.id);
      if (known) {
        if (known.ownerMissionId !== record.ownerMissionId || known.ownerExecutionId !== record.ownerExecutionId) {
          throw new Error(
            `resource ${record.id} is already owned by mission ${known.ownerMissionId} execution ${known.ownerExecutionId}`,
          );
        }
        return known;
      }
      await this.createOnce(record);
      return record;
    });
  }

  /**
   * Starts a release. `ok` means the caller may now delete the resource and must
   * call {@link completeRelease}; `foreign` (different owner or host) and
   * `active` (the owning mission is still running per `isMissionActive`) leave
   * the record untouched. An owner releasing its own finished execution's
   * resource passes a predicate that reports the mission inactive; a garbage
   * collector passes the real one.
   */
  async beginRelease(id: string, owner: ResourceOwner, isMissionActive: MissionActivity): Promise<BeginReleaseResult> {
    return this.locked(async () => {
      const record = await this.read(id);
      if (!record) return { status: "missing" };
      if (
        record.hostId !== this.hostId ||
        record.ownerMissionId !== owner.missionId ||
        record.ownerExecutionId !== owner.executionId
      ) {
        return { status: "foreign", record };
      }
      if (record.state === "released" || record.state === "releasing") return { status: "ok", record };
      if (await isMissionActive(record.ownerMissionId)) return { status: "active", record };
      const next: ResourceRecord = { ...record, state: "releasing" };
      delete next.retainedReason;
      await this.replace(next);
      return { status: "ok", record: next };
    });
  }

  /** Marks a begun release finished. Idempotent once released. */
  async completeRelease(id: string): Promise<void> {
    await this.locked(async () => {
      const record = await this.read(id);
      if (!record) throw new Error(`resource ${id} is not registered`);
      if (record.state === "released") return;
      if (record.state !== "releasing") throw new Error(`resource ${id} is not releasing (state ${record.state})`);
      await this.replace({ ...record, state: "released" });
    });
  }

  /**
   * Keeps a resource whose release failed: the record stays registered as
   * `retained` with the reason, never silently dropped. A later
   * {@link beginRelease} may retry it. Idempotent for an already retained
   * record (the reason is updated); a released or unknown record is an error.
   */
  async markRetained(id: string, reason: string): Promise<void> {
    nonEmpty(reason, "retained reason");
    await this.locked(async () => {
      const record = await this.read(id);
      if (!record) throw new Error(`resource ${id} is not registered`);
      if (record.state === "released") throw new Error(`resource ${id} is already released`);
      await this.replace({ ...record, state: "retained", retainedReason: reason });
    });
  }

  /**
   * Finishes or rolls back records this host left in `releasing`: the resource
   * is gone from disk (finish), or still there (roll back to active so the
   * ownership is not lost). Non-path kinds cannot be probed and roll back.
   * Unreadable record files are moved aside to `quarantine/` and reported.
   * Other hosts' records are never touched.
   */
  async reconcile(): Promise<ReconcileDiagnostic[]> {
    return this.locked(async () => {
      const diagnostics: ReconcileDiagnostic[] = [];
      for (const name of await this.recordFiles()) {
        const parsed = await this.readFile(name);
        if (parsed === "gone") continue;
        if (parsed === undefined) {
          const qdir = join(this.dir, "quarantine");
          await mkdir(qdir, { recursive: true });
          await rename(join(this.dir, name), join(qdir, `${name}.${randomUUID()}`)).catch(() => {});
          diagnostics.push({ id: name, action: "quarantined", reason: "unreadable or invalid resource record" });
          continue;
        }
        if (parsed.state !== "releasing" || parsed.hostId !== this.hostId) continue;
        const gone = PATH_KINDS.has(parsed.kind) && !(await exists(parsed.locator));
        if (gone) {
          await this.replace({ ...parsed, state: "released" });
          diagnostics.push({ id: parsed.id, action: "completed", reason: "resource absent from disk" });
        } else {
          await this.replace({ ...parsed, state: "active" });
          diagnostics.push({
            id: parsed.id,
            action: "rolled_back",
            reason: PATH_KINDS.has(parsed.kind) ? "resource still present on disk" : "resource kind cannot be probed",
          });
        }
      }
      return diagnostics;
    });
  }

  async listOwned(missionId: string): Promise<ResourceRecord[]> {
    return this.locked(async () => {
      const owned: ResourceRecord[] = [];
      for (const name of await this.recordFiles()) {
        const record = await this.readFile(name);
        if (record && record !== "gone" && record.ownerMissionId === missionId) owned.push(record);
      }
      return owned.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }

  /**
   * Every readable record on this registry, oldest first. For housekeeping that
   * has no single owner (the pressure GC); unreadable files are skipped here and
   * are {@link reconcile}'s to quarantine.
   */
  async listAll(): Promise<ResourceRecord[]> {
    return this.locked(async () => {
      const all: ResourceRecord[] = [];
      for (const name of await this.recordFiles()) {
        const record = await this.readFile(name);
        if (record && record !== "gone") all.push(record);
      }
      return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }

  // --- storage -------------------------------------------------------------

  private async recordFiles(): Promise<string[]> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    return names.filter((n) => n.endsWith(".json")).sort();
  }

  private async readFile(name: string): Promise<ResourceRecord | undefined | "gone"> {
    let text: string;
    try {
      text = await readFile(join(this.dir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) && fileFor(parsed.id) === name ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async read(id: string): Promise<ResourceRecord | undefined> {
    const parsed = await this.readFile(fileFor(id));
    if (parsed === "gone") return undefined;
    if (parsed === undefined) throw new Error(`resource record for ${id} is corrupt; run reconcile`);
    return parsed;
  }

  /** Write to a temp file, then publish: `link` fails if the record already exists. */
  private async createOnce(record: ResourceRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${fileFor(record.id)}.tmp-${randomUUID()}`);
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(tmp, join(this.dir, fileFor(record.id)));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private async replace(record: ResourceRecord): Promise<void> {
    const tmp = join(this.dir, `.${fileFor(record.id)}.tmp-${randomUUID()}`);
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(tmp, join(this.dir, fileFor(record.id)));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /** Serialize in-process, then take the cross-process lock. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const lock = await this.acquire();
      try {
        return await fn();
      } finally {
        lock.release();
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async acquire(): Promise<ExclusiveFileLock> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        return await ExclusiveFileLock.acquire(join(this.dir, "registry"));
      } catch (error) {
        if (!/is held|is claimed/.test(error instanceof Error ? error.message : "")) throw error;
        if (Date.now() >= deadline) throw new Error("timed out waiting for the resource registry lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}

// --- autospec protocol mapping ----------------------------------------------

export interface ProtocolContext {
  idempotencyKey: string;
  sequence: number;
  protocolVersion?: number;
}

export interface ProtocolResourceRecord {
  schema: "autospec.protocol.resource-record.v1";
  protocol_version: number;
  idempotency_key: string;
  mission_id: string;
  sequence: number;
  required_extensions: string[];
  extensions: { host_id: string };
  resource_id: string;
  kind: ResourceKind;
  owner: { mission_id: string; execution_id: string };
  created_at: string;
  lease_id: string;
  state: "active" | "releasable" | "released" | "retained_for_diagnostics";
  path?: string;
  bytes?: number;
  inodes?: number;
}

const WIRE_STATE = {
  active: "active",
  releasing: "releasable",
  released: "released",
  retained: "retained_for_diagnostics",
} as const satisfies Record<ResourceState, ProtocolResourceRecord["state"]>;

/**
 * The record as autospec `resource-record.v1` (additionalProperties false, so
 * the local-only host id travels in `extensions`, which a reader may ignore).
 */
export function toProtocolResourceRecord(record: ResourceRecord, ctx: ProtocolContext): ProtocolResourceRecord {
  return {
    schema: "autospec.protocol.resource-record.v1",
    protocol_version: ctx.protocolVersion ?? 1,
    idempotency_key: ctx.idempotencyKey,
    mission_id: record.ownerMissionId,
    sequence: ctx.sequence,
    required_extensions: [],
    extensions: { host_id: record.hostId },
    resource_id: record.id,
    kind: record.kind,
    owner: { mission_id: record.ownerMissionId, execution_id: record.ownerExecutionId },
    created_at: record.createdAt,
    lease_id: record.lease,
    state: WIRE_STATE[record.state],
    ...(PATH_KINDS.has(record.kind) ? { path: record.locator } : {}),
    ...(record.bytes !== undefined ? { bytes: record.bytes } : {}),
    ...(record.inodes !== undefined ? { inodes: record.inodes } : {}),
  };
}
