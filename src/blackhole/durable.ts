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
 *  - `HindsightProvider` — HTTP adapter for the Hindsight (herdr-memory)
 *    service, the long-term cross-machine engineering-memory system. The
 *    adapter maps `DurableMemoryProvider` onto the herdr-memory bank contract
 *    (retain → POST {bank}/memories, recall → POST {bank}/memories/recall,
 *    bank = /v1/default/banks/{project}-facts); it fails closed when
 *    unconfigured.
 *
 * Sharing is read-only from the perspective of a worker: workers hydrate their
 * context FROM shared durable memory, but only the evidence-gated promotion
 * pipeline WRITES to it. Session-local working memory stays strictly isolated.
 */
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { emitTelemetry } from "../telemetry/sink.ts";
import {
  type DurableMemoryProvider,
  type DurableMemoryRecord,
  HINDSIGHT_RECALL_ALL_QUERY,
  searchDurable,
} from "./durableProvider.ts";

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
function warnHindsight(
  baseUrl: string,
  op: "recall" | "search" | "retain",
  outcome: number | "unreachable" | "unexpected-body",
): void {
  const key = `${baseUrl}:${op}:${outcome}`;
  if (warnedAuth.has(key)) return;
  warnedAuth.add(key);
  const hint =
    outcome === 401 || outcome === 403
      ? "Check the bearer token (PI_HINDSIGHT_TOKEN / PI_HINDSIGHT_TOKEN_FILE)."
      : outcome === "unreachable"
        ? "Check the service is up and PI_HINDSIGHT_BASE_URL is correct."
        : outcome === "unexpected-body"
          ? "The service returned an unexpected recall body (e.g. an SSO/captive-portal page). Check PI_HINDSIGHT_BASE_URL points at the Hindsight (herdr-memory) service."
          : "Check PI_HINDSIGHT_BASE_URL and the service.";
  const what =
    outcome === "unreachable"
      ? "is unreachable"
      : outcome === "unexpected-body"
        ? "returned an unexpected recall body"
        : `returned ${outcome}`;
  emitTelemetry({
    level: "warning",
    // The ORIGIN, not the configured URL: a base URL may carry userinfo
    // (https://user:token@host), and this line is now shown to the operator
    // rather than buried in stderr — a surface is exactly where a credential
    // must not be repeated back. The origin is what identifies the endpoint
    // anyway, and it fits a panelled terminal.
    text: `Hindsight ${safeOrigin(baseUrl)} ${what} on ${op} (fail-closed to empty). ${hint}`,
  });
}

/** An endpoint's origin, with any credentials dropped. Never throws. */
function safeOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    // Not parseable as a URL, so it cannot be split into parts safely: report
    // that it was configured rather than echoing something unexamined.
    return "(configured endpoint)";
  }
}

/** Canonical Hindsight (herdr-memory) project/bank identifier. */
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const HARNESSES = ["pi", "claude", "codex", "opencode"] as const;
export type HindsightHarness = (typeof HARNESSES)[number];

export interface HindsightProviderOptions {
  baseUrl: string;
  token?: string;
  /** Project prefix of the Hindsight bank; durable memory uses `{project}-facts`. Defaults to "pi". */
  project?: string;
  /** Harness tag recorded on retained items. Defaults to "pi". */
  harness?: HindsightHarness;
  /** Injectable fetch (e.g. for tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Interactive callers need explicit failures instead of empty hydration. */
  strict?: boolean;
  /** Strict-mode deadline for the complete request, including body consumption. */
  timeoutMs?: number;
}

export type HindsightRequestErrorCode = "auth" | "forbidden" | "timeout" | "unreachable" | "response" | "http";

/** Safe to display: never includes transport errors, response bodies or credentials. */
export class HindsightRequestError extends Error {
  readonly code: HindsightRequestErrorCode;
  readonly status?: number;

  constructor(code: HindsightRequestErrorCode, status?: number) {
    const messages: Record<HindsightRequestErrorCode, string> = {
      auth: "Hindsight authentication failed. Check your access key.",
      forbidden: "Hindsight denied access. Check your access key permissions.",
      timeout: "Hindsight request timed out.",
      unreachable: "Hindsight could not be reached securely.",
      response: "Hindsight configuration or response is invalid.",
      http: "Hindsight returned an unsuccessful HTTP response.",
    };
    super(messages[code]);
    this.name = "HindsightRequestError";
    this.code = code;
    this.status = status;
  }
}

const maxResponseBytes = 8 * 1024 * 1024;
const maxResponseRecords = 1000;

/**
 * Map a herdr-memory recall item to a durable record. Recall items carry
 * `document_id` and `content` (the retain contract); `id`/`text` are accepted
 * as fallbacks for older recall payloads. Items without a usable id or text
 * are dropped, never guessed at.
 */
export function mapRecallItem(item: unknown): DurableMemoryRecord | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const row = item as Record<string, unknown>;
  const id =
    typeof row.document_id === "string" && row.document_id
      ? row.document_id
      : typeof row.id === "string" && row.id
        ? row.id
        : "";
  const text =
    typeof row.content === "string" && row.content ? row.content : typeof row.text === "string" ? row.text : "";
  if (!id || !text) return undefined;
  return {
    id,
    text,
    sourceRefs: [],
    promotedFrom: "hindsight",
    evidenceIds: [],
    promotedAt: typeof row.promotedAt === "string" ? row.promotedAt : "",
    promotedBy: "hindsight",
  };
}

/** Strict-mode recall validation: the herdr-memory recall body is `{results: [...]}`. */
function strictRecall(body: string): DurableMemoryRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new HindsightRequestError("response");
  }
  if (data === null || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
    throw new HindsightRequestError("response");
  }
  const results = (data as { results: unknown[] }).results;
  if (results.length > maxResponseRecords) throw new HindsightRequestError("response");
  if (results.some((item) => mapRecallItem(item) === undefined)) throw new HindsightRequestError("response");
  return results.map((item) => mapRecallItem(item) as DurableMemoryRecord);
}

/**
 * HTTP adapter for the Hindsight (herdr-memory) service.
 *
 * CONTRACT NOTE: Hindsight is external infrastructure; the reference client is
 * the `herdr-memory` package (Python), and this adapter targets the same bank
 * contract: retain → POST {base}/v1/default/banks/{project}-facts/memories,
 * recall → POST {base}/v1/default/banks/{project}-facts/memories/recall.
 * Recall is semantic; there is no list-all endpoint, so `recallAll()` is a
 * best-effort semantic recall (see HINDSIGHT_RECALL_ALL_QUERY). Bearer token
 * auth, HTTPS required except loopback. Unconfigured (empty baseUrl) ⇒ fails
 * closed (recall returns nothing; store throws).
 */
export class HindsightProvider implements DurableMemoryProvider {
  readonly kind = "hindsight";
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly project: string;
  private readonly harness: HindsightHarness;
  private readonly factsBank: string;
  private readonly strict: boolean;
  private readonly timeoutMs: number;

  constructor(opts: HindsightProviderOptions) {
    this.strict = opts.strict ?? false;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.project = opts.project ?? "pi";
    this.harness = opts.harness ?? "pi";
    if (!PROJECT_PATTERN.test(this.project) || !(HARNESSES as readonly string[]).includes(this.harness)) {
      throw new HindsightRequestError("response");
    }
    if (this.strict) {
      try {
        const url = new URL(opts.baseUrl);
        const loopback =
          url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
        if (
          (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
          url.username ||
          url.password ||
          opts.baseUrl.includes("?") ||
          opts.baseUrl.includes("#") ||
          !Number.isFinite(this.timeoutMs) ||
          this.timeoutMs <= 0 ||
          this.timeoutMs > 2_147_483_647
        ) {
          throw new HindsightRequestError("response");
        }
      } catch {
        throw new HindsightRequestError("response");
      }
    }
    if (!opts.baseUrl) {
      throw new Error("HindsightProvider requires a baseUrl; refusing to run unconfigured.");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.factsBank = `/v1/default/banks/${this.project}-facts`;
  }

  private retainBody(record: DurableMemoryRecord): string {
    // Mirror the herdr-memory client's retain item: the document id is the
    // durable record id, evidence travels as JSON in metadata, and the
    // explicit flag marks promotion as an intentional save.
    return JSON.stringify({
      items: [
        {
          content: record.text,
          document_id: record.id,
          metadata: {
            project: this.project,
            harness: this.harness,
            kind: "fact",
            explicit: "true",
            evidence: JSON.stringify(record.evidenceIds),
          },
          tags: ["herdr:fact", `harness:${this.harness}`],
        },
      ],
      async: false,
    });
  }

  private recallBody(query: string): string {
    return JSON.stringify({ query, budget: "low", max_tokens: 2000, types: ["world", "experience"] });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async strictRequest(path: string, body?: string): Promise<string> {
    const controller = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelBody = () => {
      // A broken stream's cancel hook can itself hang; cleanup must not extend the deadline.
      void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new HindsightRequestError("timeout"));
        controller.abort();
        cancelBody();
      }, this.timeoutMs);
    });
    const request = async () => {
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: this.headers(),
          body,
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        throw new HindsightRequestError("unreachable");
      }
      if (controller.signal.aborted) {
        cancelBody();
        throw new HindsightRequestError("timeout");
      }
      if (!response.ok || response.redirected) {
        const code = response.status === 401 ? "auth" : response.status === 403 ? "forbidden" : "http";
        throw new HindsightRequestError(code, response.status);
      }
      if (Number(response.headers.get("content-length")) > maxResponseBytes) {
        throw new HindsightRequestError("response");
      }
      if (!response.body) return "";
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let text = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxResponseBytes) throw new HindsightRequestError("response");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    };
    try {
      return await Promise.race([request(), deadline]);
    } catch (error) {
      cancelBody();
      if (error instanceof HindsightRequestError) throw error;
      throw new HindsightRequestError("response");
    } finally {
      clearTimeout(timer);
    }
  }

  async store(record: DurableMemoryRecord): Promise<void> {
    if (this.strict) {
      await this.strictRequest(`${this.factsBank}/memories`, this.retainBody(record));
      return;
    }
    const res = await this.fetchFn(`${this.baseUrl}${this.factsBank}/memories`, {
      method: "POST",
      headers: this.headers(),
      body: this.retainBody(record),
    });
    if (!res.ok) {
      throw new Error(`Hindsight retain failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  /**
   * Hindsight has no list endpoint: this is a best-effort semantic recall, so
   * the count it reports is what the bank recalled, not a literal total.
   */
  async recallAll(): Promise<DurableMemoryRecord[]> {
    return this.search(HINDSIGHT_RECALL_ALL_QUERY);
  }

  async search(query: string): Promise<DurableMemoryRecord[]> {
    if (this.strict)
      return strictRecall(await this.strictRequest(`${this.factsBank}/memories/recall`, this.recallBody(query)));
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${this.factsBank}/memories/recall`, {
        method: "POST",
        headers: this.headers(),
        body: this.recallBody(query),
      });
    } catch {
      warnHindsight(this.baseUrl, "search", "unreachable");
      return [];
    }
    if (!res.ok) {
      warnHindsight(this.baseUrl, "search", res.status);
      return [];
    }
    const data = (await res.json().catch(() => undefined)) as { results?: unknown } | undefined;
    if (!data || !Array.isArray(data.results) || data.results.length > maxResponseRecords) {
      warnHindsight(this.baseUrl, "search", "unexpected-body");
      return [];
    }
    return data.results
      .map((item) => mapRecallItem(item))
      .filter((record): record is DurableMemoryRecord => record !== undefined);
  }
}
