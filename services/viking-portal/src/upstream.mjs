import { createHash } from "node:crypto";
import { isIP } from "node:net";

const BODY_LIMIT = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
// Fail the complete operation on limits; never return a silently truncated memory set.
const RECORD_LIMIT = 1000;
const AGGREGATE_BYTE_LIMIT = 8 * 1024 * 1024;
// Each public operation, including provisioning/retries, has at most 30 seconds.
// Shorter request timeouts also reduce that total budget to three request windows.
const OPERATION_TIMEOUT_MS = 30000;

class UpstreamError extends Error {
  constructor(status = 0, code = "") {
    super(status ? `Memory upstream failed (HTTP ${status})` : "Memory upstream unavailable");
    this.status = status;
    this.code = code;
  }
}

const hash = (id) => createHash("sha256").update(id).digest("hex");
const conflict = (error) => error instanceof UpstreamError && error.status === 409 && error.code === "ALREADY_EXISTS";

/** Narrow adapter for OpenViking v0.4.20; never exposes the root API surface. */
export class UpstreamMemory {
  #base;
  #rootKey;
  #fetch;
  #timeout;

  constructor({ baseUrl, rootKey, fetch = globalThis.fetch, timeoutMs = 10000 }) {
    const base = new URL(baseUrl);
    const loopback =
      base.hostname === "localhost" ||
      base.hostname === "[::1]" ||
      (isIP(base.hostname) === 4 && base.hostname.startsWith("127."));
    if (
      !["http:", "https:"].includes(base.protocol) ||
      (base.protocol === "http:" && !loopback) ||
      base.pathname !== "/" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !rootKey ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      throw new Error("Invalid memory upstream configuration");
    }
    this.#base = base;
    this.#rootKey = rootKey;
    this.#fetch = fetch;
    this.#timeout = timeoutMs;
  }

  #identity(owner) {
    if (typeof owner !== "string" || !/^[a-f0-9]{64}$/.test(owner)) throw new Error("Invalid memory owner");
    return {
      account: `pi-${owner}`,
      user: `pi-${owner}`,
      directory: `viking://user/pi-${owner}/resources/pi-memories`,
    };
  }

  #deadline() {
    return Date.now() + Math.min(OPERATION_TIMEOUT_MS, this.#timeout * 3);
  }

  #remaining(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UpstreamError();
    return remaining;
  }

  async #request(path, { identity, body, query, deadline } = {}) {
    const timeoutMs = Math.min(this.#timeout, this.#remaining(deadline));
    const url = new URL(path, this.#base);
    if (query) url.search = new URLSearchParams(query).toString();
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new UpstreamError());
      }, timeoutMs);
    });
    const headers = { "X-API-Key": this.#rootKey, Accept: "application/json" };
    if (identity)
      Object.assign(headers, {
        "X-OpenViking-Account": identity.account,
        "X-OpenViking-User": identity.user,
        "X-OpenViking-Role": "user",
      });
    if (body) headers["Content-Type"] = "application/json";
    try {
      return await Promise.race([
        timeout,
        (async () => {
          const response = await this.#fetch(url, {
            method: body ? "POST" : "GET",
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
            redirect: "error",
          });
          const reader = response.body?.getReader();
          if (!reader || Number(response.headers.get("content-length")) > BODY_LIMIT) {
            controller.abort();
            throw new UpstreamError();
          }
          let bytes = 0;
          const chunks = [];
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > BODY_LIMIT) {
                controller.abort();
                void reader.cancel().catch(() => {});
                throw new UpstreamError();
              }
              chunks.push(Buffer.from(value));
            }
          } finally {
            reader.releaseLock();
          }
          const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!response.ok || json?.status !== "ok") {
            const code = ["ALREADY_EXISTS", "CONFLICT", "NOT_FOUND"].includes(json?.error?.code) ? json.error.code : "";
            throw new UpstreamError(response.status, code);
          }
          this.#remaining(deadline);
          return json.result;
        })(),
      ]);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError();
    } finally {
      clearTimeout(timer);
    }
  }

  async #provision(identity, deadline) {
    // No cache: a failed/removed account can recover without stale process state.
    for (const [path, options] of [
      ["/api/v1/admin/accounts", { body: { account_id: identity.account, admin_user_id: "portal-admin" } }],
      [`/api/v1/admin/accounts/${identity.account}/users`, { body: { user_id: identity.user, role: "user" } }],
    ]) {
      try {
        await this.#request(path, { ...options, deadline });
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    try {
      await this.#request("/api/v1/fs/mkdir", { identity, deadline, body: { uri: identity.directory } });
    } catch (error) {
      // AGFS existing-directory errors map to CONFLICT, not ALREADY_EXISTS.
      // A conflict alone does not prove provisioning succeeded: stat that exact directory.
      if (!(error instanceof UpstreamError) || error.status !== 409 || error.code !== "CONFLICT") throw error;
      const stat = await this.#request("/api/v1/fs/stat", { identity, deadline, query: { uri: identity.directory } });
      if (stat?.uri !== identity.directory || stat?.isDir !== true) throw error;
    }
  }

  async health() {
    await this.#request("/health", { deadline: this.#deadline() });
    return true;
  }

  async store(owner, record) {
    const deadline = this.#deadline();
    const identity = this.#identity(owner);
    if (!record || typeof record.id !== "string" || !record.id) throw new Error("Invalid memory record");
    const content = JSON.stringify(record);
    if (Buffer.byteLength(content) > BODY_LIMIT / 2) throw new Error("Memory record too large");
    await this.#provision(identity, deadline);
    const body = {
      uri: `${identity.directory}/${hash(record.id)}.json`,
      content,
      mode: "create",
      processing_mode: "vectors_only",
      wait: true,
      timeout: Math.max(1, Math.floor(this.#timeout / 1000) - 1),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#request("/api/v1/content/write", { identity, deadline, body });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        if (body.mode === "create" && conflict(error)) body.mode = "replace";
        else if (
          body.mode === "replace" &&
          error instanceof UpstreamError &&
          error.status === 404 &&
          error.code === "NOT_FOUND"
        )
          body.mode = "create";
        else throw error;
      }
    }
  }

  async recallAll(owner) {
    const deadline = this.#deadline();
    const identity = this.#identity(owner);
    await this.#provision(identity, deadline);
    const records = [];
    let bytes = 0;
    const seen = new Set();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const entries = await this.#request("/api/v1/fs/ls", {
        identity,
        deadline,
        query: {
          uri: identity.directory,
          output: "original",
          offset,
          limit: PAGE_SIZE,
          sort_by: "name",
          sort_order: "asc",
        },
      });
      if (!Array.isArray(entries) || entries.length > PAGE_SIZE) throw new UpstreamError();
      if (records.length + entries.length > RECORD_LIMIT) throw new UpstreamError();
      for (const entry of entries) {
        const uri = entry?.uri;
        const prefix = `${identity.directory}/`;
        if (typeof uri !== "string" || !uri.startsWith(prefix)) throw new UpstreamError();
        const name = uri.slice(prefix.length);
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new UpstreamError();
        if (entry.isDir || entry.access === "denied" || seen.has(uri)) throw new UpstreamError();
        seen.add(uri);
        const raw = await this.#request("/api/v1/content/read", { identity, deadline, query: { uri, raw: true } });
        if (typeof raw !== "string") throw new UpstreamError();
        bytes += Buffer.byteLength(raw);
        if (bytes > AGGREGATE_BYTE_LIMIT) throw new UpstreamError();
        let record;
        try {
          record = JSON.parse(raw);
        } catch {
          throw new UpstreamError();
        }
        if (!record || typeof record.id !== "string" || `${hash(record.id)}.json` !== name) throw new UpstreamError();
        records.push(record);
      }
      this.#remaining(deadline);
      if (entries.length < PAGE_SIZE) return records;
    }
  }

  async search(owner, query) {
    const deadline = this.#deadline();
    const tokens = (query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length >= 2);
    const matches = (await this.recallAll(owner)).filter((record) => {
      const refs = Array.isArray(record.sourceRefs) ? record.sourceRefs.join(" ") : "";
      const haystack = `${record.text || ""} ${refs}`.toLowerCase();
      this.#remaining(deadline);
      return tokens.length === 0 || tokens.some((token) => haystack.includes(token));
    });
    this.#remaining(deadline);
    return matches;
  }
}
