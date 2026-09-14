/**
 * Shared durable memory providers — the cross-worker memory surface.
 *
 * Promoted knowledge lives in a `DurableMemoryProvider`. The default is
 * single-process in-memory. To let SEVERAL pi workers share their promoted
 * memory, point the provider at a shared backend:
 *
 *  - `SharedFileDurableMemory` — dependency-free, append-only JSONL on a shared
 *    path. Safe for concurrent processes on one host (O_APPEND per line) and
 *    for CI. Cross-host sharing is better served by the remote provider.
 *  - `OpenVikingProvider` — HTTP adapter for the external OpenViking service.
 *    OpenViking is the long-term cross-machine engineering-memory system; this
 *    adapter maps `DurableMemoryProvider` onto a generic REST contract. The
 *    exact paths/headers MUST be matched to the real service (see the contract
 *    note below); it fails closed when unconfigured.
 *
 * Sharing is read-only from the perspective of a worker: workers hydrate their
 * context FROM shared durable memory, but only the evidence-gated promotion
 * pipeline WRITES to it. Session-local working memory stays strictly isolated.
 */
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type DurableMemoryProvider, type DurableMemoryRecord, searchDurable } from "./OpenViking.ts";

/** Dependency-free cross-process shared store backed by append-only JSONL. */
export class SharedFileDurableMemory implements DurableMemoryProvider {
  readonly kind = "shared-file";
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async store(record: DurableMemoryRecord): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    // appendFile via writeSync on an O_APPEND fd keeps each record a single
    // atomic-ish line so concurrent writers do not interleave within a record.
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  async recallAll(): Promise<DurableMemoryRecord[]> {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const records: DurableMemoryRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as DurableMemoryRecord);
      } catch {
        // ignore a corrupt/partial trailing line; keep the rest
      }
    }
    return records;
  }

  async search(query: string): Promise<DurableMemoryRecord[]> {
    const all = await this.recallAll();
    return searchDurable(query, all);
  }
}

/** Warn once per baseUrl+op+outcome so an operator isn't left with silent empty hydration. */
const warnedAuth = new Set<string>();
function warnOpenViking(
  baseUrl: string,
  op: "recall" | "search",
  outcome: number | "unreachable" | "unexpected-body",
): void {
  const key = `${baseUrl}:${op}:${outcome}`;
  if (warnedAuth.has(key)) return;
  warnedAuth.add(key);
  const hint =
    outcome === 401 || outcome === 403
      ? "Check the bearer token (PI_OPENVIKING_TOKEN / PI_OPENVIKING_TOKEN_FILE)."
      : outcome === "unreachable"
        ? "Check the service is up and PI_OPENVIKING_BASE_URL is correct."
        : outcome === "unexpected-body"
          ? "The service returned a non-array body (e.g. an SSO/captive-portal page). Check PI_OPENVIKING_BASE_URL points at the OpenViking service."
          : "Check PI_OPENVIKING_BASE_URL and the service.";
  const what =
    outcome === "unreachable"
      ? "is unreachable"
      : outcome === "unexpected-body"
        ? "returned an unexpected (non-array) body"
        : `returned ${outcome}`;
  console.warn(`[pi-engineering-runtime] OpenViking ${baseUrl} ${what} on ${op} (fail-closed to empty). ${hint}`);
}

export interface OpenVikingEndpointPaths {
  promote: string;
  recall: string;
  search: string;
}

export interface OpenVikingProviderOptions {
  baseUrl: string;
  token?: string;
  /** Injectable fetch (e.g. for tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Custom endpoint paths. Defaults to a documented generic contract. */
  paths?: Partial<OpenVikingEndpointPaths>;
}

/**
 * HTTP adapter for the external OpenViking service.
 *
 * CONTRACT NOTE: OpenViking is external infrastructure. This adapter targets a
 * generic REST contract (POST {base}/memory to promote, GET {base}/memory to
 * recall all, GET {base}/memory/search?q= to search). A reference tier-1
 * implementation of exactly this contract ships at `services/openviking/`
 * (thin HTTP layer + PostgreSQL backing store; `docker compose up` deploys it
 * on a single host). If a different OpenViking deployment is used, the concrete
 * paths and auth header must be reconciled with that service. Unconfigured
 * (empty baseUrl) ⇒ fails closed (recall returns nothing; store throws).
 */
export class OpenVikingProvider implements DurableMemoryProvider {
  readonly kind = "openviking";
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly paths: OpenVikingEndpointPaths;

  constructor(opts: OpenVikingProviderOptions) {
    if (!opts.baseUrl) {
      throw new Error("OpenVikingProvider requires a baseUrl; refusing to run unconfigured.");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.paths = {
      promote: opts.paths?.promote ?? "/memory",
      recall: opts.paths?.recall ?? "/memory",
      search: opts.paths?.search ?? "/memory/search",
    };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async store(record: DurableMemoryRecord): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}${this.paths.promote}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      throw new Error(`OpenViking promote failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  async recallAll(): Promise<DurableMemoryRecord[]> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${this.paths.recall}`, { headers: this.headers() });
    } catch {
      warnOpenViking(this.baseUrl, "recall", "unreachable");
      return [];
    }
    if (!res.ok) {
      warnOpenViking(this.baseUrl, "recall", res.status);
      return [];
    }
    const data = (await res.json().catch(() => [])) as unknown;
    if (!Array.isArray(data)) {
      warnOpenViking(this.baseUrl, "recall", "unexpected-body");
      return [];
    }
    return data;
  }

  async search(query: string): Promise<DurableMemoryRecord[]> {
    let res: Response;
    try {
      const url = `${this.baseUrl}${this.paths.search}?q=${encodeURIComponent(query)}`;
      res = await this.fetchFn(url, { headers: this.headers() });
    } catch {
      warnOpenViking(this.baseUrl, "search", "unreachable");
      return [];
    }
    if (!res.ok) {
      warnOpenViking(this.baseUrl, "search", res.status);
      return [];
    }
    const data = (await res.json().catch(() => [])) as unknown;
    if (!Array.isArray(data)) {
      warnOpenViking(this.baseUrl, "search", "unexpected-body");
      return [];
    }
    return data;
  }
}
