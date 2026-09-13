import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactMeta } from "../core/types.ts";

/**
 * Filesystem-backed artifact store (spec §25, AC-010).
 *
 * Large outputs (logs, diffs, reports) live on disk outside model prompts.
 * Tools return compact summaries plus stable `artifact://<category>/<id>`
 * references that can be lazily expanded.
 */
export class ArtifactStore {
  private readonly root: string;
  private readonly index = new Map<string, ArtifactMeta>();

  private constructor(root: string) {
    this.root = root;
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
        const dir = join(this.root, entry.name);
        try {
          const files = await readdir(dir);
          for (const f of files) {
            if (!f.endsWith(".json")) continue;
            const full = join(dir, f);
            try {
              const meta = JSON.parse(await readFile(full, "utf-8")) as ArtifactMeta;
              if (meta?.id && meta?.uri) {
                this.index.set(`${entry.name}/${meta.id}`, meta);
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

  private uri(category: string, id: string): string {
    return `artifact://${category}/${id}`;
  }

  private metaPath(category: string, id: string): string {
    return join(this.root, category, `${id}.json`);
  }

  private contentPath(category: string, id: string): string {
    return join(this.root, category, `${id}.txt`);
  }

  /** Store an artifact; content stays on disk, meta (incl. summary) is indexed. */
  async put(category: string, id: string, content: string, summary: string): Promise<ArtifactMeta> {
    await mkdir(join(this.root, category), { recursive: true });
    const contentPath = this.contentPath(category, id);
    await writeFile(contentPath, content, "utf-8");
    const meta: ArtifactMeta = {
      id,
      category,
      uri: this.uri(category, id),
      size: Buffer.byteLength(content, "utf-8"),
      created_at: new Date().toISOString(),
      summary,
    };
    await writeFile(this.metaPath(category, id), JSON.stringify(meta, null, 2), "utf-8");
    this.index.set(`${category}/${id}`, meta);
    return meta;
  }

  /** Return the artifact summary (compact; never injects full content). */
  async get(id: string): Promise<ArtifactMeta | undefined> {
    return this.index.get(id);
  }

  getByUri(uri: string): ArtifactMeta | undefined {
    const prefix = "artifact://";
    if (!uri.startsWith(prefix)) return undefined;
    return this.index.get(uri.slice(prefix.length));
  }

  /** Lazily expand full artifact content. */
  async readContent(category: string, id: string): Promise<string | undefined> {
    try {
      return await readFile(this.contentPath(category, id), "utf-8");
    } catch {
      return undefined;
    }
  }

  async readContentByUri(uri: string): Promise<string | undefined> {
    const meta = this.getByUri(uri);
    if (!meta) return undefined;
    return this.readContent(meta.category, meta.id);
  }

  async delete(uri: string): Promise<void> {
    const meta = this.getByUri(uri);
    if (!meta) return;
    await unlink(this.contentPath(meta.category, meta.id)).catch(() => {});
    await unlink(this.metaPath(meta.category, meta.id)).catch(() => {});
    this.index.delete(`${meta.category}/${meta.id}`);
  }

  list(category?: string): ArtifactMeta[] {
    let metas = [...this.index.values()];
    if (category) metas = metas.filter((m) => m.category === category);
    return metas.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  get rootDir(): string {
    return this.root;
  }
}
