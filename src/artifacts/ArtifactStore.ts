import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArtifactMeta } from "../core/types.ts";
import { ExclusiveFileLock } from "../platform/eventstore/fileLock.ts";

type StoredArtifactMeta = ArtifactMeta & { sha256: string; immutable?: true };
type ArtifactTransaction =
  | { version: 1; operation: "put"; category: string; id: string; content: string; meta: StoredArtifactMeta }
  | { version: 1; operation: "delete"; category: string; id: string };
type ArtifactOperation = "scan" | "recovery" | "read" | "write" | "delete" | "verify";

export interface ArtifactStoreHooks {
  /** Deterministic directory-swap injection point used by integrity tests. */
  afterCategoryOpened?: (operation: ArtifactOperation, category: string) => void;
  /** Deterministic lock-owner injection point used by integrity tests. */
  afterKeyLockAcquired?: (key: string) => Promise<void> | void;
  /** Deterministic lock-directory swap injection after its descriptor is pinned. */
  afterLockDirectoryOpened?: () => void;
  /** Crash boundaries for the root-authoritative lock-domain bootstrap. */
  afterLockBootstrapPrepared?: () => void;
  afterLockDirectoryCreated?: () => void;
  afterLockBootstrapBound?: () => void;
  afterLockDomainPublished?: () => void;
  /** Deterministic crash injection after the durable journal is published. */
  afterJournalCommitted?: (key: string) => Promise<void> | void;
  /** Deterministic delete crash injection after final-file removals are durable. */
  afterDeleteFilesSynced?: (key: string) => Promise<void> | void;
  /** Deterministic delete crash injection after journal removal, before its directory fsync. */
  afterDeleteJournalRemoved?: (key: string) => Promise<void> | void;
}

const CANONICAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMMUTABLE_ID = /^.+-([a-f0-9]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const LOCK_WAIT_MS = 10_000;
const LOCK_BOOTSTRAP_BIND_WAIT_MS = 1_000;
const LOCK_DOMAIN_RECORD = ".artifact-lock-domain.json";
const LOCK_BOOTSTRAP_RECORD = ".artifact-lock-bootstrap.json";
const LOCK_DOMAIN_TOKEN = ".domain-token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function integrityError(message: string): Error {
  return new Error(`ARTIFACT INTEGRITY: ${message}`);
}

function assertCanonicalSegment(value: string, field: string): void {
  if (
    !CANONICAL_SEGMENT.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("%") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${field} must be one canonical artifact path segment`);
  }
}

function publicMeta(meta: StoredArtifactMeta | ArtifactMeta): Readonly<ArtifactMeta> {
  return Object.freeze({
    id: meta.id,
    category: meta.category,
    uri: meta.uri,
    size: meta.size,
    created_at: meta.created_at,
    summary: meta.summary,
  });
}

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function procFd(fd: number): string {
  if (process.platform !== "linux") throw integrityError("secure descriptor-relative artifact access requires Linux");
  return `/proc/self/fd/${fd}`;
}

function assertTrustedDirectory(stat: { isDirectory(): boolean; uid: number; mode: number }, label: string): void {
  if (!stat.isDirectory()) throw integrityError(`${label} is not a directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw integrityError(`${label} is not owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) throw integrityError(`${label} is writable by another user`);
}

interface OpenCategory {
  root: FileHandle;
  category: FileHandle;
  path: string;
}

interface DirectoryIdentity {
  device: bigint;
  inode: bigint;
}

interface LockDomainRecord extends DirectoryIdentity {
  version: 1;
  token: string;
}

type LockBootstrapRecord =
  | { version: 1; phase: "prepared"; token: string }
  | ({ version: 1; phase: "bound"; token: string } & DirectoryIdentity);

/** Filesystem-backed lazy artifact store (spec §25, AC-010). */
export class ArtifactStore {
  private readonly root: string;
  private readonly rootReal: string;
  private readonly hooks: ArtifactStoreHooks;
  private readonly index = new Map<string, Readonly<ArtifactMeta>>();
  private readonly immutableKeys = new Set<string>();
  private lockDomain?: LockDomainRecord;

  private constructor(root: string, rootReal: string, hooks: ArtifactStoreHooks) {
    this.root = root;
    this.rootReal = rootReal;
    this.hooks = hooks;
  }

  static async create(root: string, hooks: ArtifactStoreHooks = {}): Promise<ArtifactStore> {
    const canonicalRoot = resolve(root);
    await mkdir(canonicalRoot, { recursive: true, mode: 0o700 });
    const rootHandle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let rootReal: string;
    try {
      assertTrustedDirectory(await rootHandle.stat(), "artifact root");
      rootReal = await realpath(procFd(rootHandle.fd));
    } finally {
      await rootHandle.close();
    }
    const store = new ArtifactStore(canonicalRoot, rootReal, hooks);
    await store.ensureLockRoot();
    await store.scan();
    return store;
  }

  private key(category: string, id: string): string {
    assertCanonicalSegment(category, "artifact category");
    assertCanonicalSegment(id, "artifact id");
    return `${category}/${id}`;
  }

  private uri(category: string, id: string): string {
    return `artifact://${this.key(category, id)}`;
  }

  private parseUri(uri: string): { category: string; id: string; key: string } {
    const match = /^artifact:\/\/([^/]+)\/([^/]+)$/.exec(uri);
    if (!match) throw new Error("artifact URI must contain exactly two canonical artifact path segments");
    const category = match[1]!;
    const id = match[2]!;
    return { category, id, key: this.key(category, id) };
  }

  private async openRoot(): Promise<FileHandle> {
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      assertTrustedDirectory(await handle.stat(), "artifact root");
      if ((await realpath(procFd(handle.fd))) !== this.rootReal) throw integrityError("artifact root identity changed");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async openCategory(
    category: string,
    create: boolean,
    operation: ArtifactOperation,
    suppliedRoot?: FileHandle,
  ): Promise<OpenCategory | undefined> {
    assertCanonicalSegment(category, "artifact category");
    const root = suppliedRoot ?? (await this.openRoot());
    const ownsRoot = !suppliedRoot;
    const path = `${procFd(root.fd)}/${category}`;
    try {
      if (create) {
        try {
          await mkdir(path, { mode: 0o700 });
          await root.sync();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      let categoryHandle: FileHandle;
      try {
        categoryHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (!create && isMissing(error)) {
          if (ownsRoot) await root.close();
          return undefined;
        }
        if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          throw integrityError(`artifact category ${category} is a symlink or unsafe path`);
        }
        throw error;
      }
      try {
        assertTrustedDirectory(await categoryHandle.stat(), `artifact category ${category}`);
        if ((await realpath(procFd(categoryHandle.fd))) !== resolve(this.rootReal, category)) {
          throw integrityError(`artifact category ${category} identity changed`);
        }
        this.hooks.afterCategoryOpened?.(operation, category);
        return { root, category: categoryHandle, path: procFd(categoryHandle.fd) };
      } catch (error) {
        await categoryHandle.close();
        throw error;
      }
    } catch (error) {
      if (ownsRoot) await root.close();
      throw error;
    }
  }

  private async closeCategory(opened: OpenCategory): Promise<void> {
    await opened.category.close();
    await opened.root.close();
  }

  private async ensureLockRoot(): Promise<void> {
    const root = await this.openRoot();
    try {
      const path = `${procFd(root.fd)}/.artifact-locks`;
      const existingRecord = await this.readLockDomainRecord(root);
      let bootstrap = await this.readLockBootstrapRecord(root);
      if (!existingRecord && !bootstrap) {
        try {
          await lstat(path);
          throw integrityError("artifact lock root is unproven without a durable bootstrap marker");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        bootstrap = { version: 1, phase: "prepared", token: randomUUID() };
        await this.writeLockBootstrapRecord(root, bootstrap);
        this.hooks.afterLockBootstrapPrepared?.();
      }
      let createdLockRoot = false;
      if (!existingRecord && bootstrap?.phase === "prepared") {
        try {
          await mkdir(path, { mode: 0o700 });
          createdLockRoot = true;
          await root.sync();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      let handle: FileHandle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (existingRecord && isMissing(error)) throw integrityError("artifact lock root identity changed");
        throw error;
      }
      try {
        assertTrustedDirectory(await handle.stat(), "artifact lock root");
        if ((await realpath(procFd(handle.fd))) !== resolve(this.rootReal, ".artifact-locks")) {
          throw integrityError("artifact lock root identity changed");
        }
        const identity = await handle.stat({ bigint: true });
        let record = existingRecord;
        if (!record) {
          if (!bootstrap) throw integrityError("artifact lock root bootstrap marker disappeared");
          // A prepared marker authorizes creating one new domain. It cannot
          // authorize adopting a directory that appeared after the marker.
          const token = createdLockRoot
            ? await this.ensureLockDomainToken(handle, bootstrap.token)
            : bootstrap.phase === "prepared"
              ? await this.waitForPreparedLockDomainToken(handle)
              : await this.readLockDomainToken(handle);
          if (token !== bootstrap.token) throw integrityError("artifact lock root bootstrap token changed");
          if (bootstrap.phase === "prepared") {
            await root.sync();
            this.hooks.afterLockDirectoryCreated?.();
            bootstrap = {
              version: 1,
              phase: "bound",
              token,
              device: identity.dev,
              inode: identity.ino,
            };
            await this.writeLockBootstrapRecord(root, bootstrap);
            this.hooks.afterLockBootstrapBound?.();
          } else if (bootstrap.device !== identity.dev || bootstrap.inode !== identity.ino) {
            throw integrityError("artifact lock root bootstrap identity changed");
          }
          record = await this.publishLockDomainRecord(root, {
            version: 1,
            token,
            device: identity.dev,
            inode: identity.ino,
          });
          this.hooks.afterLockDomainPublished?.();
        }
        await this.validateLockDomain(handle, record, identity);
        if (bootstrap) {
          if (
            bootstrap.token !== record.token ||
            (bootstrap.phase === "bound" && (bootstrap.device !== record.device || bootstrap.inode !== record.inode))
          ) {
            throw integrityError("artifact lock root bootstrap does not match the durable domain");
          }
          await rm(`${procFd(root.fd)}/${LOCK_BOOTSTRAP_RECORD}`, { force: true });
          await root.sync();
        }
        const namedIdentity = await lstat(path, { bigint: true });
        if (namedIdentity.dev !== record.device || namedIdentity.ino !== record.inode) {
          throw integrityError("artifact lock root identity changed");
        }
        this.lockDomain = record;
      } finally {
        await handle.close();
      }
    } finally {
      await root.close();
    }
  }

  private async readLockBootstrapRecord(root: FileHandle): Promise<LockBootstrapRecord | undefined> {
    const path = `${procFd(root.fd)}/${LOCK_BOOTSTRAP_RECORD}`;
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw integrityError("artifact lock bootstrap marker is unsafe");
      let value: unknown;
      try {
        value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      } catch {
        throw integrityError("artifact lock bootstrap marker is corrupt");
      }
      const candidate = value as Partial<{
        version: number;
        phase: string;
        token: string;
        device: string;
        inode: string;
      }>;
      if (candidate.version !== 1 || !UUID.test(candidate.token ?? "")) {
        throw integrityError("artifact lock bootstrap marker is corrupt");
      }
      if (candidate.phase === "prepared" && candidate.device === undefined && candidate.inode === undefined) {
        return { version: 1, phase: "prepared", token: candidate.token! };
      }
      if (
        candidate.phase === "bound" &&
        typeof candidate.device === "string" &&
        /^\d+$/.test(candidate.device) &&
        typeof candidate.inode === "string" &&
        /^\d+$/.test(candidate.inode)
      ) {
        return {
          version: 1,
          phase: "bound",
          token: candidate.token!,
          device: BigInt(candidate.device),
          inode: BigInt(candidate.inode),
        };
      }
      throw integrityError("artifact lock bootstrap marker is corrupt");
    } finally {
      await handle.close();
    }
  }

  private async writeLockBootstrapRecord(root: FileHandle, record: LockBootstrapRecord): Promise<void> {
    const finalPath = `${procFd(root.fd)}/${LOCK_BOOTSTRAP_RECORD}`;
    const temporary = `${procFd(root.fd)}/.${LOCK_BOOTSTRAP_RECORD}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        `${JSON.stringify({
          ...record,
          ...(record.phase === "bound" ? { device: record.device.toString(), inode: record.inode.toString() } : {}),
        })}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, finalPath);
      await root.sync();
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async readLockDomainRecord(root: FileHandle): Promise<LockDomainRecord | undefined> {
    const path = `${procFd(root.fd)}/${LOCK_DOMAIN_RECORD}`;
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw integrityError("artifact lock domain record is unsafe");
      let value: unknown;
      try {
        value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      } catch {
        throw integrityError("artifact lock domain record is corrupt");
      }
      const candidate = value as Partial<{ version: number; token: string; device: string; inode: string }>;
      if (
        candidate.version !== 1 ||
        typeof candidate.token !== "string" ||
        !UUID.test(candidate.token) ||
        typeof candidate.device !== "string" ||
        !/^\d+$/.test(candidate.device) ||
        typeof candidate.inode !== "string" ||
        !/^\d+$/.test(candidate.inode)
      ) {
        throw integrityError("artifact lock domain record is corrupt");
      }
      return {
        version: 1,
        token: candidate.token,
        device: BigInt(candidate.device),
        inode: BigInt(candidate.inode),
      };
    } finally {
      await handle.close();
    }
  }

  private async ensureLockDomainToken(lockRoot: FileHandle, expectedToken?: string): Promise<string> {
    const path = `${procFd(lockRoot.fd)}/${LOCK_DOMAIN_TOKEN}`;
    const token = expectedToken ?? randomUUID();
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(`${token}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await lockRoot.sync();
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.readLockDomainToken(lockRoot);
    }
  }

  private async readLockDomainToken(lockRoot: FileHandle): Promise<string> {
    let handle: FileHandle;
    try {
      handle = await open(`${procFd(lockRoot.fd)}/${LOCK_DOMAIN_TOKEN}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) throw integrityError("artifact lock domain token is missing");
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw integrityError("artifact lock domain token is unsafe");
      const token = (await handle.readFile({ encoding: "utf8" })).trim();
      if (!UUID.test(token)) throw integrityError("artifact lock domain token is corrupt");
      return token;
    } finally {
      await handle.close();
    }
  }

  private async waitForPreparedLockDomainToken(lockRoot: FileHandle): Promise<string> {
    const deadline = Date.now() + LOCK_BOOTSTRAP_BIND_WAIT_MS;
    while (true) {
      try {
        return await this.readLockDomainToken(lockRoot);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("artifact lock domain token is missing")) throw error;
        if (Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
  }

  private async publishLockDomainRecord(root: FileHandle, record: LockDomainRecord): Promise<LockDomainRecord> {
    const finalPath = `${procFd(root.fd)}/${LOCK_DOMAIN_RECORD}`;
    const candidate = `${procFd(root.fd)}/.${LOCK_DOMAIN_RECORD}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(
      candidate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        `${JSON.stringify({
          version: record.version,
          token: record.token,
          device: record.device.toString(),
          inode: record.inode.toString(),
        })}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(candidate, finalPath);
      await root.sync();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readLockDomainRecord(root);
      if (!existing) throw integrityError("artifact lock domain record disappeared during publication");
      return existing;
    } finally {
      await rm(candidate, { force: true });
    }
  }

  private async validateLockDomain(
    lockRoot: FileHandle,
    record: LockDomainRecord,
    suppliedIdentity?: { dev: bigint; ino: bigint },
  ): Promise<void> {
    const identity = suppliedIdentity ?? (await lockRoot.stat({ bigint: true }));
    const token = await this.readLockDomainToken(lockRoot).catch(() => {
      throw integrityError("artifact lock root identity changed");
    });
    if (identity.dev !== record.device || identity.ino !== record.inode || token !== record.token) {
      throw integrityError("artifact lock root identity changed");
    }
  }

  private async openLockRoot(root: FileHandle): Promise<FileHandle> {
    const handle = await open(
      `${procFd(root.fd)}/.artifact-locks`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      assertTrustedDirectory(await handle.stat(), "artifact lock root");
      if ((await realpath(procFd(handle.fd))) !== resolve(this.rootReal, ".artifact-locks")) {
        throw integrityError("artifact lock root identity changed");
      }
      const identity = await handle.stat({ bigint: true });
      const durable = await this.readLockDomainRecord(root);
      if (
        !durable ||
        !this.lockDomain ||
        durable.device !== this.lockDomain.device ||
        durable.inode !== this.lockDomain.inode ||
        durable.token !== this.lockDomain.token
      ) {
        throw integrityError("artifact lock root identity changed");
      }
      await this.validateLockDomain(handle, durable, identity);
      this.hooks.afterLockDirectoryOpened?.();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async withKeyLock<T>(category: string, id: string, operation: (root: FileHandle) => Promise<T>): Promise<T> {
    const key = this.key(category, id);
    const root = await this.openRoot();
    let lockRoot: FileHandle | undefined;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let lock: ExclusiveFileLock | undefined;
    let result: T | undefined;
    let operationError: unknown;
    try {
      lockRoot = await this.openLockRoot(root);
      const lockTarget = `${procFd(lockRoot.fd)}/${digest(key)}`;
      while (!lock) {
        try {
          lock = await ExclusiveFileLock.acquire(lockTarget);
        } catch (error) {
          if (!/writer lock.*(?:held|recovery.*(?:claimed|blocked))/i.test(String(error)) || Date.now() >= deadline) {
            throw error;
          }
          await delay(5);
        }
      }
      await this.hooks.afterKeyLockAcquired?.(key);
      result = await operation(root);
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    try {
      lock?.release();
    } catch (error) {
      releaseError = error;
    }
    await lockRoot?.close();
    await root.close();
    if (operationError && releaseError) {
      throw new AggregateError([operationError, releaseError], "artifact operation and lock release both failed");
    }
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return result as T;
  }

  private filePath(opened: OpenCategory, id: string, suffix: "json" | "txt" | "txn.json"): string {
    assertCanonicalSegment(id, "artifact id");
    return `${opened.path}/${id}.${suffix}`;
  }

  private async regularState(path: string, label: string): Promise<"regular" | "missing"> {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw integrityError(`${label} is a symlink`);
      if (!stat.isFile()) throw integrityError(`${label} is not a regular file`);
      return "regular";
    } catch (error) {
      if (isMissing(error)) return "missing";
      throw error;
    }
  }

  private validateStoredMeta(meta: unknown, category: string, id: string): StoredArtifactMeta {
    const candidate = meta as Partial<StoredArtifactMeta> | null;
    if (
      !candidate ||
      candidate.id !== id ||
      candidate.category !== category ||
      candidate.uri !== this.uri(category, id) ||
      typeof candidate.size !== "number" ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0 ||
      typeof candidate.sha256 !== "string" ||
      !DIGEST.test(candidate.sha256) ||
      typeof candidate.created_at !== "string" ||
      typeof candidate.summary !== "string"
    ) {
      throw integrityError(`artifact metadata identity, size, or digest mismatch for ${category}/${id}`);
    }
    const embeddedDigest = IMMUTABLE_ID.exec(id)?.[1]?.toLowerCase();
    if (embeddedDigest && candidate.immutable !== true) {
      throw integrityError(`immutable marker missing for reserved artifact ${category}/${id}`);
    }
    if (candidate.immutable !== undefined && candidate.immutable !== true) {
      throw integrityError(`invalid immutable marker for ${category}/${id}`);
    }
    if (embeddedDigest && embeddedDigest !== candidate.sha256) {
      throw integrityError(`immutable ID digest mismatch for ${category}/${id}`);
    }
    return candidate as StoredArtifactMeta;
  }

  private validateContent(meta: StoredArtifactMeta, content: Buffer, category: string, id: string): void {
    if (content.byteLength !== meta.size) throw integrityError(`artifact content size mismatch for ${category}/${id}`);
    if (digest(content) !== meta.sha256) throw integrityError(`artifact content digest mismatch for ${category}/${id}`);
  }

  private async readFileNoFollow(path: string, label: string): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw integrityError(`${label} is not a regular file`);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  private async readDurableFromCategory(
    opened: OpenCategory,
    category: string,
    id: string,
  ): Promise<{ meta: StoredArtifactMeta; content: Buffer } | undefined> {
    const transactionPath = this.filePath(opened, id, "txn.json");
    if ((await this.regularState(transactionPath, `artifact transaction ${category}/${id}`)) === "regular") {
      throw integrityError(`artifact transaction is incomplete for ${category}/${id}`);
    }
    const metaPath = this.filePath(opened, id, "json");
    const contentPath = this.filePath(opened, id, "txt");
    const metaState = await this.regularState(metaPath, `artifact metadata ${category}/${id}`);
    const contentState = await this.regularState(contentPath, `artifact content ${category}/${id}`);
    if (metaState === "missing") {
      if (contentState === "regular") throw integrityError(`orphan artifact content reserves ${category}/${id}`);
      return undefined;
    }
    if (contentState === "missing") throw integrityError(`artifact content file is missing for ${category}/${id}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        (await this.readFileNoFollow(metaPath, `artifact metadata ${category}/${id}`)).toString("utf8"),
      );
    } catch (error) {
      if (String(error).includes("ARTIFACT INTEGRITY")) throw error;
      throw integrityError(`artifact metadata is corrupt for ${category}/${id}`);
    }
    const meta = this.validateStoredMeta(parsed, category, id);
    const content = await this.readFileNoFollow(contentPath, `artifact content ${category}/${id}`);
    this.validateContent(meta, content, category, id);
    return { meta, content };
  }

  private async writeAtomic(opened: OpenCategory, name: string, content: string, exclusive = false): Promise<void> {
    const path = `${opened.path}/${name}`;
    await this.regularState(path, `artifact file ${name}`);
    const temporary = `${opened.path}/.${name}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (exclusive && (await this.regularState(path, `artifact file ${name}`)) !== "missing") {
        throw integrityError(`artifact collision at ${name}`);
      }
      await rename(temporary, path);
      await opened.category.sync();
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private validateTransaction(value: unknown, category: string, id: string): ArtifactTransaction {
    const transaction = value as Partial<ArtifactTransaction> | null;
    if (
      !transaction ||
      transaction.version !== 1 ||
      transaction.category !== category ||
      transaction.id !== id ||
      (transaction.operation !== "put" && transaction.operation !== "delete")
    ) {
      throw integrityError(`artifact transaction identity mismatch for ${category}/${id}`);
    }
    if (transaction.operation === "put") {
      if (typeof transaction.content !== "string") {
        throw integrityError(`artifact transaction content is corrupt for ${category}/${id}`);
      }
      const meta = this.validateStoredMeta(transaction.meta, category, id);
      this.validateContent(meta, Buffer.from(transaction.content, "utf8"), category, id);
      return { ...transaction, meta } as ArtifactTransaction;
    }
    return transaction as ArtifactTransaction;
  }

  private async recoverTransaction(opened: OpenCategory, category: string, id: string): Promise<void> {
    const transactionPath = this.filePath(opened, id, "txn.json");
    if ((await this.regularState(transactionPath, `artifact transaction ${category}/${id}`)) === "missing") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        (await this.readFileNoFollow(transactionPath, `artifact transaction ${category}/${id}`)).toString("utf8"),
      );
    } catch (error) {
      if (String(error).includes("ARTIFACT INTEGRITY")) throw error;
      throw integrityError(`artifact transaction is corrupt for ${category}/${id}`);
    }
    const transaction = this.validateTransaction(parsed, category, id);
    if (transaction.operation === "put") {
      await this.writeAtomic(opened, `${id}.txt`, transaction.content);
      await this.writeAtomic(opened, `${id}.json`, JSON.stringify(transaction.meta, null, 2));
    } else {
      await unlink(this.filePath(opened, id, "txt")).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await unlink(this.filePath(opened, id, "json")).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await opened.category.sync();
      await this.hooks.afterDeleteFilesSynced?.(this.key(category, id));
    }
    await unlink(transactionPath);
    if (transaction.operation === "delete") {
      await this.hooks.afterDeleteJournalRemoved?.(this.key(category, id));
    }
    await opened.category.sync();
  }

  private async commitTransaction(opened: OpenCategory, transaction: ArtifactTransaction): Promise<void> {
    await this.writeAtomic(opened, `${transaction.id}.txn.json`, JSON.stringify(transaction), true);
    await this.hooks.afterJournalCommitted?.(this.key(transaction.category, transaction.id));
    await this.recoverTransaction(opened, transaction.category, transaction.id);
  }

  private async scan(): Promise<void> {
    const root = await this.openRoot();
    let entries;
    try {
      entries = await readdir(procFd(root.fd), { withFileTypes: true });
    } finally {
      await root.close();
    }
    for (const entry of entries) {
      if (entry.name === ".artifact-locks") continue;
      try {
        assertCanonicalSegment(entry.name, "artifact category");
      } catch {
        continue;
      }
      if (entry.isSymbolicLink()) throw integrityError(`artifact category ${entry.name} is a symlink`);
      if (!entry.isDirectory()) continue;
      const opened = await this.openCategory(entry.name, false, "scan");
      if (!opened) continue;
      let files;
      try {
        files = await readdir(opened.path, { withFileTypes: true });
      } finally {
        await this.closeCategory(opened);
      }
      for (const file of files.filter((candidate) => candidate.name.endsWith(".txn.json"))) {
        const id = file.name.slice(0, -".txn.json".length);
        this.key(entry.name, id);
        await this.withKeyLock(entry.name, id, async (lockedRoot) => {
          const category = await this.openCategory(entry.name, false, "recovery", lockedRoot);
          if (!category) throw integrityError(`artifact category disappeared during recovery for ${entry.name}/${id}`);
          try {
            await this.recoverTransaction(category, entry.name, id);
          } finally {
            await category.category.close();
          }
        });
      }
      const rescanned = await this.openCategory(entry.name, false, "scan");
      if (!rescanned) continue;
      try {
        const current = await readdir(rescanned.path, { withFileTypes: true });
        const metadataIds = new Set<string>();
        for (const file of current) {
          if (!file.name.endsWith(".json") || file.name.endsWith(".txn.json")) continue;
          const id = file.name.slice(0, -".json".length);
          this.key(entry.name, id);
          if (file.isSymbolicLink()) throw integrityError(`artifact metadata ${entry.name}/${id} is a symlink`);
          const durable = await this.readDurableFromCategory(rescanned, entry.name, id);
          if (!durable) throw integrityError(`artifact metadata disappeared during replay for ${entry.name}/${id}`);
          metadataIds.add(id);
          const key = this.key(entry.name, id);
          this.index.set(key, publicMeta(durable.meta));
          if (durable.meta.immutable === true) this.immutableKeys.add(key);
        }
        for (const file of current) {
          if (!file.name.endsWith(".txt")) continue;
          const id = file.name.slice(0, -".txt".length);
          this.key(entry.name, id);
          if (file.isSymbolicLink()) throw integrityError(`artifact content ${entry.name}/${id} is a symlink`);
          if (!metadataIds.has(id)) throw integrityError(`orphan artifact content reserves ${entry.name}/${id}`);
        }
      } finally {
        await this.closeCategory(rescanned);
      }
    }
  }

  async put(category: string, id: string, content: string, summary: string): Promise<ArtifactMeta> {
    return this.withKeyLock(category, id, async (root) => {
      const opened = await this.openCategory(category, true, "write", root);
      if (!opened) throw integrityError(`artifact category ${category} was not created`);
      try {
        await this.recoverTransaction(opened, category, id);
        const durable = await this.readDurableFromCategory(opened, category, id);
        if (durable?.meta.immutable === true || this.immutableKeys.has(this.key(category, id))) {
          throw new Error(`cannot overwrite immutable checkpoint artifact ${this.uri(category, id)}`);
        }
        const meta: StoredArtifactMeta = {
          id,
          category,
          uri: this.uri(category, id),
          size: Buffer.byteLength(content, "utf8"),
          sha256: digest(content),
          created_at: new Date().toISOString(),
          summary,
        };
        await this.commitTransaction(opened, { version: 1, operation: "put", category, id, content, meta });
        const indexed = publicMeta(meta);
        this.index.set(this.key(category, id), indexed);
        return publicMeta(indexed);
      } finally {
        await opened.category.close();
      }
    });
  }

  async putImmutable(category: string, ownerId: string, content: string, summary: string): Promise<ArtifactMeta> {
    assertCanonicalSegment(ownerId, "artifact owner id");
    const contentDigest = digest(content);
    const artifactId = `${ownerId}-${contentDigest}-${randomUUID()}`;
    return this.withKeyLock(category, artifactId, async (root) => {
      const opened = await this.openCategory(category, true, "write", root);
      if (!opened) throw integrityError(`artifact category ${category} was not created`);
      try {
        await this.recoverTransaction(opened, category, artifactId);
        if (await this.readDurableFromCategory(opened, category, artifactId)) {
          throw integrityError(`immutable artifact collision at ${category}/${artifactId}`);
        }
        const meta: StoredArtifactMeta = {
          id: artifactId,
          category,
          uri: this.uri(category, artifactId),
          size: Buffer.byteLength(content, "utf8"),
          sha256: contentDigest,
          created_at: new Date().toISOString(),
          summary,
          immutable: true,
        };
        await this.commitTransaction(opened, {
          version: 1,
          operation: "put",
          category,
          id: artifactId,
          content,
          meta,
        });
        const key = this.key(category, artifactId);
        this.immutableKeys.add(key);
        const indexed = publicMeta(meta);
        this.index.set(key, indexed);
        return publicMeta(indexed);
      } finally {
        await opened.category.close();
      }
    });
  }

  async get(id: string): Promise<ArtifactMeta | undefined> {
    if (id.includes("/")) {
      const parts = id.split("/");
      if (parts.length !== 2) throw new Error("artifact key must contain exactly two canonical artifact path segments");
      const direct = this.index.get(this.key(parts[0]!, parts[1]!));
      return direct ? publicMeta(direct) : undefined;
    }
    assertCanonicalSegment(id, "artifact id");
    for (const [key, meta] of this.index) {
      if (key.endsWith(`/${id}`)) return publicMeta(meta);
    }
    return undefined;
  }

  getByUri(uri: string): ArtifactMeta | undefined {
    const parsed = this.parseUri(uri);
    const meta = this.index.get(parsed.key);
    return meta ? publicMeta(meta) : undefined;
  }

  async readContent(category: string, id: string): Promise<string | undefined> {
    this.key(category, id);
    const opened = await this.openCategory(category, false, "read");
    if (!opened) return undefined;
    try {
      const durable = await this.readDurableFromCategory(opened, category, id);
      return durable?.content.toString("utf8");
    } finally {
      await this.closeCategory(opened);
    }
  }

  async readContentByUri(uri: string): Promise<string | undefined> {
    const parsed = this.parseUri(uri);
    return this.readContent(parsed.category, parsed.id);
  }

  async readSlice(
    category: string,
    id: string,
    offset = 0,
    maxChars = 12000,
  ): Promise<{ content: string; nextOffset: number } | undefined> {
    const content = await this.readContent(category, id);
    if (content === undefined) return undefined;
    const start = Math.max(0, offset);
    const slice = content.slice(start, start + Math.max(1, maxChars));
    return { content: slice, nextOffset: start + slice.length };
  }

  async readSliceByUri(
    uri: string,
    offset = 0,
    maxChars = 12000,
  ): Promise<{ content: string; nextOffset: number } | undefined> {
    const parsed = this.parseUri(uri);
    return this.readSlice(parsed.category, parsed.id, offset, maxChars);
  }

  private openSyncCategory(
    category: string,
    operation: ArtifactOperation,
  ): { rootFd: number; categoryFd: number; path: string } {
    assertCanonicalSegment(category, "artifact category");
    const rootFd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      assertTrustedDirectory(fstatSync(rootFd), "artifact root");
      if (realpathSync(procFd(rootFd)) !== this.rootReal) throw integrityError("artifact root identity changed");
      const categoryFd = openSync(
        `${procFd(rootFd)}/${category}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        assertTrustedDirectory(fstatSync(categoryFd), `artifact category ${category}`);
        if (realpathSync(procFd(categoryFd)) !== resolve(this.rootReal, category)) {
          throw integrityError(`artifact category ${category} identity changed`);
        }
        this.hooks.afterCategoryOpened?.(operation, category);
        return { rootFd, categoryFd, path: procFd(categoryFd) };
      } catch (error) {
        closeSync(categoryFd);
        throw error;
      }
    } catch (error) {
      closeSync(rootFd);
      throw error;
    }
  }

  verifyAndDispatch<T>(refs: readonly string[], hashes: readonly string[], dispatch: () => T): T {
    if (refs.length !== hashes.length) throw integrityError("artifact references and hashes are not aligned");
    for (const [index, ref] of refs.entries()) {
      const { category, id } = this.parseUri(ref);
      const opened = this.openSyncCategory(category, "verify");
      try {
        try {
          const transactionFd = openSync(`${opened.path}/${id}.txn.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
          closeSync(transactionFd);
          throw integrityError(`artifact transaction is incomplete for ${category}/${id}`);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        const metaFd = openSync(`${opened.path}/${id}.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
        let meta: StoredArtifactMeta;
        try {
          if (!fstatSync(metaFd).isFile()) throw integrityError(`artifact metadata ${category}/${id} is unsafe`);
          let parsed: unknown;
          try {
            parsed = JSON.parse(readFileSync(metaFd, "utf8"));
          } catch {
            throw integrityError(`artifact metadata is corrupt for ${category}/${id}`);
          }
          meta = this.validateStoredMeta(parsed, category, id);
          const embeddedDigest = IMMUTABLE_ID.exec(id)?.[1]?.toLowerCase();
          if (meta.immutable !== true || !embeddedDigest || embeddedDigest !== meta.sha256) {
            throw integrityError(`dispatch artifact ${category}/${id} is not immutable or digest-bound`);
          }
        } finally {
          closeSync(metaFd);
        }
        const contentFd = openSync(`${opened.path}/${id}.txt`, constants.O_RDONLY | constants.O_NOFOLLOW);
        let content: Buffer;
        try {
          if (!fstatSync(contentFd).isFile()) throw integrityError(`artifact content ${category}/${id} is unsafe`);
          content = readFileSync(contentFd);
        } finally {
          closeSync(contentFd);
        }
        this.validateContent(meta, content, category, id);
        if (`sha256:${digest(content)}` !== hashes[index]) {
          throw integrityError(`artifact content hash mismatch for ${ref}`);
        }
      } finally {
        closeSync(opened.categoryFd);
        closeSync(opened.rootFd);
      }
    }
    return dispatch();
  }

  async delete(uri: string): Promise<void> {
    const parsed = this.parseUri(uri);
    await this.withKeyLock(parsed.category, parsed.id, async (root) => {
      const opened = await this.openCategory(parsed.category, false, "delete", root);
      if (!opened) return;
      try {
        await this.recoverTransaction(opened, parsed.category, parsed.id);
        const durable = await this.readDurableFromCategory(opened, parsed.category, parsed.id);
        if (!durable) return;
        if (durable.meta.immutable === true || this.immutableKeys.has(parsed.key)) {
          throw new Error(`cannot delete immutable checkpoint artifact ${uri}`);
        }
        await this.commitTransaction(opened, {
          version: 1,
          operation: "delete",
          category: parsed.category,
          id: parsed.id,
        });
        this.index.delete(parsed.key);
      } finally {
        await opened.category.close();
      }
    });
  }

  list(category?: string): ArtifactMeta[] {
    if (category) assertCanonicalSegment(category, "artifact category");
    let metas = [...this.index.values()];
    if (category) metas = metas.filter((meta) => meta.category === category);
    return metas.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((meta) => publicMeta(meta));
  }

  get rootDir(): string {
    return this.root;
  }
}
