/** Durable command receipts for same-user maintenance of one Pi conversation. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets } from "../platform/redact.ts";
import { type ProcessIdentity, assessProcess, currentProcessIdentity } from "../runtime/isolation/processIdentity.ts";
import { MutationLockBusyError, type MutationLockHandle, RuntimeMutationLock } from "../update/mutationLock.ts";

export interface RuntimeDescription {
  hostCommit: string | null;
  commit: string | null;
  generation: number | null;
  capabilities: string[];
  pending: boolean;
  interactiveIdle?: boolean;
}

export interface MaintenanceRequest {
  operationId: string;
  action: "describe" | "prepare" | "reload" | "resume" | "status";
  expectedInstanceId: string;
  expectedCommit?: string;
  sourceRoot?: string;
  missionId?: string;
  expectedRevision?: number;
  expectedResumptionGeneration?: number;
  timeoutMs?: number;
  selectedModel?: { provider: string; id: string };
}

export interface MaintenanceOutcome {
  status: "succeeded" | "failed" | "skipped";
  result?: Record<string, unknown>;
  error?: string;
}

export interface MaintenanceReceipt {
  operationId: string;
  action: MaintenanceRequest["action"];
  status: "running" | MaintenanceOutcome["status"];
  startedAt: string;
  completedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

interface StoredOperation {
  requestHash: string;
  pid: number;
  processIdentity?: ProcessIdentity;
  receipt: MaintenanceReceipt;
}

export function maintenanceStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.PI_ENGINEERING_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-engineering"),
    "maintenance",
  );
}

export function parseMaintenanceRequest(value: unknown): MaintenanceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_maintenance_request");
  const r = value as Record<string, unknown>;
  if (typeof r.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.operationId))
    throw new Error("invalid_operation_id");
  if (typeof r.expectedInstanceId !== "string" || !r.expectedInstanceId || r.expectedInstanceId.length > 128)
    throw new Error("invalid_instance_id");
  if (!["describe", "prepare", "reload", "resume", "status"].includes(String(r.action)))
    throw new Error("invalid_maintenance_action");
  const allowed = new Set([
    "operationId",
    "action",
    "expectedInstanceId",
    "expectedCommit",
    "sourceRoot",
    "missionId",
    "expectedRevision",
    "expectedResumptionGeneration",
    "timeoutMs",
    "selectedModel",
  ]);
  if (Object.keys(r).some((key) => !allowed.has(key))) throw new Error("unknown_maintenance_field");
  if (r.selectedModel !== undefined) {
    const model = r.selectedModel as Record<string, unknown> | null;
    if (
      r.action !== "resume" ||
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      Object.keys(model).some((key) => key !== "provider" && key !== "id") ||
      [model.provider, model.id].some(
        (part) => typeof part !== "string" || !part.trim() || part.length > 512 || /[\0\r\n]/.test(part),
      )
    )
      throw new Error("invalid_selected_model");
  }
  if (
    r.expectedCommit !== undefined &&
    (typeof r.expectedCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(r.expectedCommit))
  )
    throw new Error("invalid_commit");
  if (
    r.sourceRoot !== undefined &&
    (typeof r.sourceRoot !== "string" || !r.sourceRoot.startsWith("/") || /[\0\r\n]/.test(r.sourceRoot))
  )
    throw new Error("invalid_source_root");
  if (r.missionId !== undefined && (typeof r.missionId !== "string" || !/^MSN-[A-Za-z0-9_-]+$/.test(r.missionId)))
    throw new Error("invalid_mission_id");
  for (const key of ["expectedRevision", "expectedResumptionGeneration"])
    if (r[key] !== undefined && (!Number.isSafeInteger(r[key]) || Number(r[key]) < 0))
      throw new Error(`invalid_${key}`);
  if (
    r.timeoutMs !== undefined &&
    (!Number.isInteger(r.timeoutMs) || Number(r.timeoutMs) < 1 || Number(r.timeoutMs) > 120_000)
  )
    throw new Error("invalid_timeout");
  if ((r.action === "reload" || r.action === "resume") && !r.expectedCommit)
    throw new Error("expected_commit_required");
  if (
    r.action === "resume" &&
    (!r.missionId || r.expectedRevision === undefined || r.expectedResumptionGeneration === undefined)
  )
    throw new Error("mission_fence_required");
  return r as unknown as MaintenanceRequest;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** A persisted claim is never silently re-executed after an ambiguous process crash. */
export class MaintenanceOperations {
  private readonly directory: string;
  private readonly execute: (request: MaintenanceRequest) => Promise<MaintenanceOutcome>;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();

  constructor(root: string, sessionId: string, execute: (request: MaintenanceRequest) => Promise<MaintenanceOutcome>) {
    this.directory = join(root, digest(sessionId));
    this.execute = execute;
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("insecure_maintenance_directory");
    await syncDirectory(dirname(this.directory));
  }

  private path(operationId: string): string {
    return join(this.directory, `${digest(operationId)}.json`);
  }

  private async read(operationId: string): Promise<StoredOperation | null> {
    try {
      const path = this.path(operationId);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 64 * 1024 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("invalid_maintenance_receipt");
      const record = JSON.parse(await readFile(path, "utf8")) as StoredOperation;
      if (
        record.receipt?.operationId !== operationId ||
        typeof record.requestHash !== "string" ||
        !Number.isInteger(record.pid)
      )
        throw new Error("invalid_maintenance_receipt");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async get(operationId: string): Promise<MaintenanceReceipt | null> {
    const record = await this.read(operationId);
    if (!record) return null;
    if (record.receipt.status === "running") {
      if (record.processIdentity && assessProcess(record.processIdentity).state === "dead")
        return { ...record.receipt, status: "failed", error: "operation_interrupted_reconcile_before_retry" };
      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          return { ...record.receipt, status: "failed", error: "operation_interrupted_reconcile_before_retry" };
      }
    }
    return record.receipt;
  }

  private async executeExclusive(request: MaintenanceRequest): Promise<MaintenanceOutcome> {
    if (request.action === "describe") return this.execute(request);
    let lock: MutationLockHandle;
    try {
      lock = new RuntimeMutationLock(join(this.directory, "active.lock")).acquire(request.operationId);
    } catch (error) {
      if (!(error instanceof MutationLockBusyError)) throw error;
      return {
        status: "skipped",
        result: { status: "busy", reason: "maintenance_operation_in_flight_or_requires_reconciliation" },
      };
    }
    try {
      return await this.execute(request);
    } finally {
      lock.release();
    }
  }

  submit(request: MaintenanceRequest): Promise<MaintenanceReceipt> {
    const result = this.chain.then(() => this.claim(request));
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async claim(input: MaintenanceRequest): Promise<MaintenanceReceipt> {
    const request = parseMaintenanceRequest(input);
    if (request.action === "status") {
      const receipt = await this.get(request.operationId);
      if (!receipt) throw new Error("operation_not_found");
      return receipt;
    }
    await this.prepare();
    const requestHash = digest(
      JSON.stringify(
        Object.keys(request)
          .sort()
          .map((key) => [key, request[key as keyof MaintenanceRequest]]),
      ),
    );
    const previous = await this.read(request.operationId);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new Error("operation_id_conflict");
      return (await this.get(request.operationId))!;
    }
    const record: StoredOperation = {
      requestHash,
      pid: process.pid,
      processIdentity: currentProcessIdentity(),
      receipt: {
        operationId: request.operationId,
        action: request.action,
        status: "running",
        startedAt: new Date().toISOString(),
      },
    };
    const path = this.path(request.operationId);
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.read(request.operationId);
      if (existing?.requestHash !== requestHash) throw new Error("operation_id_conflict");
      return existing.receipt;
    }
    const flight = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        let outcome: MaintenanceOutcome;
        try {
          outcome = await this.executeExclusive(request);
        } catch (error) {
          outcome = {
            status: "failed",
            error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000),
          };
        }
        const completed: StoredOperation = {
          ...record,
          receipt: { ...record.receipt, ...outcome, completedAt: new Date().toISOString() },
        };
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temp, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(completed));
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temp, path);
          await syncDirectory(this.directory);
        } finally {
          await unlink(temp).catch(() => {});
        }
      })
      .finally(() => this.pending.delete(flight));
    this.pending.add(flight);
    // Persistence errors remain visible as an unfinished receipt, never a fabricated success.
    void flight.catch(() => undefined);
    return record.receipt;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
