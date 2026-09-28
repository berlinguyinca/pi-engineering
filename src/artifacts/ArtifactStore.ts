import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArtifactMeta } from "../core/types.ts";

type StoredArtifactMeta = ArtifactMeta & { immutable?: true };
const CANONICAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

/**
 * Filesystem-backed artifact store (spec §25, AC-010).
 *
 * Large outputs (logs, diffs, reports) live on disk outside model prompts.
 * Tools return compact summaries plus stable `artifact://<category>/<id>`
 * references that can be lazily expanded.
 */
export class ArtifactStore {
  private readonly root: string;
  private readonly index = new Map<string, Readonly<ArtifactMeta>>();
  private readonly immutableKeys = new Set<string>();

  private constructor(root: string) {
    this.root = resolve(root);
  }

  static async create(root: string): Promise<ArtifactStore> {
    const store = new ArtifactStore(root);
    await store.scan();
    return store;
  }

  private async scan(): Promise<void> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          assertCanonicalSegment(entry.name, "artifact category");
        } catch {
          continue;
        }
        const dir = this.categoryPath(entry.name);
        try {
          const files = await readdir(dir);
          for (const f of files) {
            if (!f.endsWith(".json")) continue;
            const id = f.slice(0, -".json".length);
            try {
              assertCanonicalSegment(id, "artifact id");
            } catch {
              continue;
            }
            const full = join(dir, f);
            try {
              const meta = JSON.parse(await readFile(full, "utf-8")) as StoredArtifactMeta;
              if (
                meta?.id === id &&
                meta.category === entry.name &&
                meta.uri === this.uri(entry.name, id) &&
                typeof meta.size === "number" &&
                typeof meta.created_at === "string" &&
                typeof meta.summary === "string"
              ) {
                const key = this.key(entry.name, id);
                this.index.set(key, publicMeta(meta));
                if (meta.immutable === true) this.immutableKeys.add(key);
              }
            } catch {
              // ignore unparseable meta files
            }
          }
        } catch {
          // ignore unreadable subdirectories
        }
      }
    } catch {
      // No artifacts yet.
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
    if (dirname(path) !== this.root) throw new Error("artifact category escapes the artifact root");
    return path;
  }

  private metaPath(category: string, id: string): string {
    this.key(category, id);
    const categoryPath = this.categoryPath(category);
    const path = resolve(categoryPath, `${id}.json`);
    if (dirname(path) !== categoryPath) throw new Error("artifact metadata path escapes its exact category");
    return path;
  }

  private contentPath(category: string, id: string): string {
    this.key(category, id);
    const categoryPath = this.categoryPath(category);
    const path = resolve(categoryPath, `${id}.txt`);
    if (dirname(path) !== categoryPath) throw new Error("artifact content path escapes its exact category");
    return path;
  }

  /** Store an artifact; content stays on disk, meta (incl. summary) is indexed. */
  async put(category: string, id: string, content: string, summary: string): Promise<ArtifactMeta> {
    const key = this.key(category, id);
    if (this.immutableKeys.has(key)) {
      throw new Error(`cannot overwrite immutable checkpoint artifact ${this.uri(category, id)}`);
    }
    await mkdir(this.categoryPath(category), { recursive: true });
    const contentPath = this.contentPath(category, id);
    await writeFile(contentPath, content, "utf-8");
    const meta: StoredArtifactMeta = {
      id,
      category,
      uri: this.uri(category, id),
      size: Buffer.byteLength(content, "utf-8"),
      created_at: new Date().toISOString(),
      summary,
    };
    await writeFile(this.metaPath(category, id), JSON.stringify(meta, null, 2), "utf-8");
    const indexed = publicMeta(meta);
    this.index.set(key, indexed);
    return publicMeta(indexed);
  }

  /**
   * Store a uniquely named, content-addressed artifact without an overwrite
   * path. The owner prefix keeps checkpoint evidence attributable while the
   * digest and nonce preserve one URI per claim, even for equal content.
   */
  async putImmutable(category: string, ownerId: string, content: string, summary: string): Promise<ArtifactMeta> {
    assertCanonicalSegment(ownerId, "artifact owner id");
    await mkdir(this.categoryPath(category), { recursive: true });
    const digest = createHash("sha256").update(content).digest("hex");
    const artifactId = `${ownerId}-${digest}-${randomUUID()}`;
    const key = this.key(category, artifactId);
    const contentPath = this.contentPath(category, artifactId);
    const metaPath = this.metaPath(category, artifactId);
    const meta: StoredArtifactMeta = {
      id: artifactId,
      category,
      uri: this.uri(category, artifactId),
      size: Buffer.byteLength(content, "utf-8"),
      created_at: new Date().toISOString(),
      summary,
      immutable: true,
    };
    await writeFile(contentPath, content, { encoding: "utf-8", flag: "wx" });
    try {
      await writeFile(metaPath, JSON.stringify(meta, null, 2), { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      await unlink(contentPath).catch(() => {});
      throw error;
    }
    this.immutableKeys.add(key);
    const indexed = publicMeta(meta);
    this.index.set(key, indexed);
    return publicMeta(indexed);
  }

  /**
   * Return an artifact's metadata (compact; never injects full content).
   * Accepts the composite 'category/id' index key, or a bare id that is unique
   * across categories (the index is keyed by 'category/id', so a raw-id lookup
   * would otherwise always miss).
   */
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

  /** Lazily expand full artifact content. */
  async readContent(category: string, id: string): Promise<string | undefined> {
    const path = this.contentPath(category, id);
    try {
      return await readFile(path, "utf-8");
    } catch {
      return undefined;
    }
  }

  async readContentByUri(uri: string): Promise<string | undefined> {
    const meta = this.getByUri(uri);
    if (!meta) return undefined;
    return this.readContent(meta.category, meta.id);
  }

  /**
   * Lazily read a bounded slice of artifact content directly from disk, without
   * loading the whole file into memory. Supports paging through large outputs
   * (logs/diffs/reports) with an explicit offset. Returns undefined when the
   * content file is missing.
   */
  async readSlice(
    category: string,
    id: string,
    offset = 0,
    maxChars = 12000,
  ): Promise<{ content: string; nextOffset: number } | undefined> {
    const path = this.contentPath(category, id);
    try {
      const handle = await open(path, "r");
      try {
        const { bytesRead, buffer } = await handle.read({
          position: Math.max(0, offset),
          length: Math.max(1, maxChars),
        });
        return {
          content: buffer.subarray(0, bytesRead).toString("utf-8"),
          nextOffset: offset + bytesRead,
        };
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  /** Bounded lazy read of an artifact by its artifact:// URI. */
  async readSliceByUri(
    uri: string,
    offset = 0,
    maxChars = 12000,
  ): Promise<{ content: string; nextOffset: number } | undefined> {
    const meta = this.getByUri(uri);
    if (!meta) return undefined;
    return this.readSlice(meta.category, meta.id, offset, maxChars);
  }

  async delete(uri: string): Promise<void> {
    const parsed = this.parseUri(uri);
    const meta = this.index.get(parsed.key);
    if (!meta) return;
    if (this.immutableKeys.has(parsed.key)) {
      throw new Error(`cannot delete immutable checkpoint artifact ${uri}`);
    }
    await unlink(this.contentPath(meta.category, meta.id)).catch(() => {});
    await unlink(this.metaPath(meta.category, meta.id)).catch(() => {});
    this.index.delete(parsed.key);
  }

  list(category?: string): ArtifactMeta[] {
    if (category) assertCanonicalSegment(category, "artifact category");
    let metas = [...this.index.values()];
    if (category) metas = metas.filter((m) => m.category === category);
    return metas.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((meta) => publicMeta(meta));
  }

  get rootDir(): string {
    return this.root;
  }
}
