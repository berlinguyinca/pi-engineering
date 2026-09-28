import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ArtifactMeta } from "../core/types.ts";

type StoredArtifactMeta = ArtifactMeta & { immutable?: true };
const CANONICAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMMUTABLE_ID = /^.+-[a-f0-9]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Filesystem-backed lazy artifact store (spec §25, AC-010). */
export class ArtifactStore {
  private readonly root: string;
  private readonly rootReal: string;
  private readonly lockRoot: string;
  private readonly index = new Map<string, Readonly<ArtifactMeta>>();
  private readonly immutableKeys = new Set<string>();

  private constructor(root: string, rootReal: string) {
    this.root = root;
    this.rootReal = rootReal;
    this.lockRoot = resolve(root, ".artifact-locks");
  }

  static async create(root: string): Promise<ArtifactStore> {
    const canonicalRoot = resolve(root);
    await mkdir(canonicalRoot, { recursive: true });
    const rootStat = await lstat(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw integrityError("artifact root must be a real directory, not a symlink");
    }
    const store = new ArtifactStore(canonicalRoot, await realpath(canonicalRoot));
    await store.ensureLockRoot();
    await store.scan();
    return store;
  }

  private async scan(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".artifact-locks") continue;
      try {
        assertCanonicalSegment(entry.name, "artifact category");
      } catch {
        continue;
      }
      if (entry.isSymbolicLink()) throw integrityError(`artifact category ${entry.name} is a symlink`);
      if (!entry.isDirectory()) continue;
      const dir = await this.existingCategory(entry.name);
      if (!dir) continue;
      const files = await readdir(dir, { withFileTypes: true });
      const metadataIds = new Set<string>();
      for (const file of files) {
        if (!file.name.endsWith(".json")) continue;
        const id = file.name.slice(0, -".json".length);
        try {
          assertCanonicalSegment(id, "artifact id");
        } catch {
          continue;
        }
        if (file.isSymbolicLink()) throw integrityError(`artifact metadata ${entry.name}/${id} is a symlink`);
        const meta = await this.readDurableMeta(entry.name, id);
        if (!meta) throw integrityError(`artifact metadata disappeared during replay for ${entry.name}/${id}`);
        metadataIds.add(id);
        const key = this.key(entry.name, id);
        this.index.set(key, publicMeta(meta));
        if (meta.immutable === true) this.immutableKeys.add(key);
      }
      for (const file of files) {
        if (!file.name.endsWith(".txt")) continue;
        const id = file.name.slice(0, -".txt".length);
        try {
          assertCanonicalSegment(id, "artifact id");
        } catch {
          continue;
        }
        if (file.isSymbolicLink()) throw integrityError(`artifact content ${entry.name}/${id} is a symlink`);
        if (!metadataIds.has(id)) throw integrityError(`orphan artifact content reserves ${entry.name}/${id}`);
      }
    }
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

  private categoryPath(category: string): string {
    assertCanonicalSegment(category, "artifact category");
    const path = resolve(this.root, category);
    if (dirname(path) !== this.root) throw integrityError("artifact category escapes the artifact root");
    return path;
  }

  private metaPath(category: string, id: string): string {
    this.key(category, id);
    const categoryPath = this.categoryPath(category);
    const path = resolve(categoryPath, `${id}.json`);
    if (dirname(path) !== categoryPath) throw integrityError("artifact metadata escapes its exact category");
    return path;
  }

  private contentPath(category: string, id: string): string {
    this.key(category, id);
    const categoryPath = this.categoryPath(category);
    const path = resolve(categoryPath, `${id}.txt`);
    if (dirname(path) !== categoryPath) throw integrityError("artifact content escapes its exact category");
    return path;
  }

  private async ensureLockRoot(): Promise<void> {
    await mkdir(this.lockRoot, { recursive: true });
    const stat = await lstat(this.lockRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw integrityError("artifact lock root is not a real directory");
    if ((await realpath(this.lockRoot)) !== resolve(this.rootReal, ".artifact-locks")) {
      throw integrityError("artifact lock root escapes the artifact root");
    }
  }

  private async existingCategory(category: string): Promise<string | undefined> {
    const path = this.categoryPath(category);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw integrityError(`artifact category ${category} is a symlink`);
    if (!stat.isDirectory()) throw integrityError(`artifact category ${category} is not a real directory`);
    const resolved = await realpath(path);
    if (dirname(resolved) !== this.rootReal) throw integrityError(`artifact category ${category} escapes containment`);
    return path;
  }

  private async ensureCategory(category: string): Promise<string> {
    const path = this.categoryPath(category);
    await mkdir(path, { recursive: true });
    const existing = await this.existingCategory(category);
    if (!existing) throw integrityError(`artifact category ${category} was not created`);
    return existing;
  }

  private async assertRegularOrMissing(path: string, label: string): Promise<"regular" | "missing"> {
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
      !Number.isFinite(candidate.size) ||
      candidate.size < 0 ||
      typeof candidate.created_at !== "string" ||
      typeof candidate.summary !== "string"
    ) {
      throw integrityError(`artifact metadata identity mismatch for ${category}/${id}`);
    }
    if (IMMUTABLE_ID.test(id) && candidate.immutable !== true) {
      throw integrityError(`immutable marker missing for reserved artifact ${category}/${id}`);
    }
    if (candidate.immutable !== undefined && candidate.immutable !== true) {
      throw integrityError(`invalid immutable marker for ${category}/${id}`);
    }
    return candidate as StoredArtifactMeta;
  }

  private async readDurableMeta(category: string, id: string): Promise<StoredArtifactMeta | undefined> {
    const categoryPath = await this.existingCategory(category);
    if (!categoryPath) return undefined;
    const metaPath = this.metaPath(category, id);
    const contentPath = this.contentPath(category, id);
    const metaState = await this.assertRegularOrMissing(metaPath, `artifact metadata ${category}/${id}`);
    const contentState = await this.assertRegularOrMissing(contentPath, `artifact content ${category}/${id}`);
    if (metaState === "missing") {
      if (contentState === "regular") throw integrityError(`orphan artifact content reserves ${category}/${id}`);
      return undefined;
    }
    const handle = await open(metaPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      raw = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw integrityError(`artifact metadata is corrupt for ${category}/${id}`);
    }
    const meta = this.validateStoredMeta(parsed, category, id);
    if (contentState === "missing") throw integrityError(`artifact content is missing for ${category}/${id}`);
    return meta;
  }

  private async reapStaleLock(lockPath: string): Promise<void> {
    try {
      const stat = await lstat(lockPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw integrityError("artifact key lock is not a regular file");
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return;
      const owner = Number.parseInt(await readFile(lockPath, "utf8"), 10);
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
        }
      }
      await unlink(lockPath).catch(() => {});
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async withKeyLock<T>(category: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = this.key(category, id);
    await this.ensureLockRoot();
    const lockPath = resolve(this.lockRoot, `${createHash("sha256").update(key).digest("hex")}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let lock;
    while (!lock) {
      try {
        lock = await open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.reapStaleLock(lockPath);
        if (Date.now() >= deadline) throw integrityError(`timed out waiting for artifact key lock ${key}`);
        await delay(5);
      }
    }
    try {
      await lock.writeFile(String(process.pid), "utf8");
      return await operation();
    } finally {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }

  private async writeRegular(path: string, content: string, exclusive = false): Promise<void> {
    await this.assertRegularOrMissing(path, `artifact file ${path}`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    try {
      if (exclusive && (await this.assertRegularOrMissing(path, `artifact file ${path}`)) !== "missing") {
        throw integrityError(`artifact collision at ${path}`);
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async put(category: string, id: string, content: string, summary: string): Promise<ArtifactMeta> {
    return this.withKeyLock(category, id, async () => {
      await this.ensureCategory(category);
      const durable = await this.readDurableMeta(category, id);
      if (durable?.immutable === true || this.immutableKeys.has(this.key(category, id))) {
        throw new Error(`cannot overwrite immutable checkpoint artifact ${this.uri(category, id)}`);
      }
      const meta: StoredArtifactMeta = {
        id,
        category,
        uri: this.uri(category, id),
        size: Buffer.byteLength(content, "utf8"),
        created_at: new Date().toISOString(),
        summary,
      };
      await this.writeRegular(this.contentPath(category, id), content);
      await this.writeRegular(this.metaPath(category, id), JSON.stringify(meta, null, 2));
      const indexed = publicMeta(meta);
      this.index.set(this.key(category, id), indexed);
      return publicMeta(indexed);
    });
  }

  async putImmutable(category: string, ownerId: string, content: string, summary: string): Promise<ArtifactMeta> {
    assertCanonicalSegment(ownerId, "artifact owner id");
    const digest = createHash("sha256").update(content).digest("hex");
    const artifactId = `${ownerId}-${digest}-${randomUUID()}`;
    return this.withKeyLock(category, artifactId, async () => {
      await this.ensureCategory(category);
      if (await this.readDurableMeta(category, artifactId)) {
        throw integrityError(`immutable artifact collision at ${category}/${artifactId}`);
      }
      const meta: StoredArtifactMeta = {
        id: artifactId,
        category,
        uri: this.uri(category, artifactId),
        size: Buffer.byteLength(content, "utf8"),
        created_at: new Date().toISOString(),
        summary,
        immutable: true,
      };
      await this.writeRegular(this.contentPath(category, artifactId), content, true);
      try {
        await this.writeRegular(this.metaPath(category, artifactId), JSON.stringify(meta, null, 2), true);
      } catch (error) {
        await unlink(this.contentPath(category, artifactId)).catch(() => {});
        throw error;
      }
      const key = this.key(category, artifactId);
      this.immutableKeys.add(key);
      const indexed = publicMeta(meta);
      this.index.set(key, indexed);
      return publicMeta(indexed);
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
    if (!(await this.existingCategory(category))) return undefined;
    const path = this.contentPath(category, id);
    if ((await this.assertRegularOrMissing(path, `artifact content ${category}/${id}`)) === "missing") return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
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
    this.key(category, id);
    if (!(await this.existingCategory(category))) return undefined;
    const path = this.contentPath(category, id);
    if ((await this.assertRegularOrMissing(path, `artifact content ${category}/${id}`)) === "missing") return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { bytesRead, buffer } = await handle.read({
        position: Math.max(0, offset),
        length: Math.max(1, maxChars),
      });
      return { content: buffer.subarray(0, bytesRead).toString("utf8"), nextOffset: offset + bytesRead };
    } finally {
      await handle.close();
    }
  }

  async readSliceByUri(
    uri: string,
    offset = 0,
    maxChars = 12000,
  ): Promise<{ content: string; nextOffset: number } | undefined> {
    const parsed = this.parseUri(uri);
    return this.readSlice(parsed.category, parsed.id, offset, maxChars);
  }

  verifyAndDispatch<T>(refs: readonly string[], hashes: readonly string[], dispatch: () => T): T {
    if (refs.length !== hashes.length) throw integrityError("artifact references and hashes are not aligned");
    for (const [index, ref] of refs.entries()) {
      const { category, id } = this.parseUri(ref);
      const categoryPath = this.categoryPath(category);
      const categoryStat = lstatSync(categoryPath);
      if (categoryStat.isSymbolicLink() || !categoryStat.isDirectory()) {
        throw integrityError(`artifact category ${category} is not a real directory`);
      }
      if (dirname(realpathSync(categoryPath)) !== this.rootReal) {
        throw integrityError(`artifact category ${category} escapes containment`);
      }
      const path = this.contentPath(category, id);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw integrityError(`artifact content ${category}/${id} is unsafe`);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        content = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (actual !== hashes[index]) throw integrityError(`artifact content hash mismatch for ${ref}`);
    }
    return dispatch();
  }

  async delete(uri: string): Promise<void> {
    const parsed = this.parseUri(uri);
    await this.withKeyLock(parsed.category, parsed.id, async () => {
      const durable = await this.readDurableMeta(parsed.category, parsed.id);
      if (!durable) return;
      if (durable.immutable === true || this.immutableKeys.has(parsed.key)) {
        throw new Error(`cannot delete immutable checkpoint artifact ${uri}`);
      }
      await this.assertRegularOrMissing(this.contentPath(parsed.category, parsed.id), `artifact content ${parsed.key}`);
      await this.assertRegularOrMissing(this.metaPath(parsed.category, parsed.id), `artifact metadata ${parsed.key}`);
      await unlink(this.contentPath(parsed.category, parsed.id));
      await unlink(this.metaPath(parsed.category, parsed.id));
      this.index.delete(parsed.key);
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
