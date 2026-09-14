/**
 * OpenViking storage backends.
 *
 * Two providers implementing the same interface:
 *   - MemoryStore   — in-memory Map (dev / tests; no dependencies).
 *   - PostgresStore — durable PostgreSQL backing store (tier-1 production).
 *
 * `pg` (node-postgres) is loaded lazily ONLY when a Postgres URL is configured,
 * so the in-memory mode has zero dependencies and can run anywhere.
 */

/**
 * Token-based relevance matcher shared by both stores. A record matches when ANY
 * whitespace-delimited token (length >= 2) appears in the text or a source ref.
 */
export function matchesTokens(record, query) {
  const tokens = (query || "").toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  // Tolerate a malformed record: a non-array sourceRefs must never poison search.
  const refs = Array.isArray(record.sourceRefs) ? record.sourceRefs.join(" ") : "";
  const hay = `${record.text || ""} ${refs}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

/** In-memory store (single process, dev/tests). */
export class MemoryStore {
  constructor() {
    this.records = new Map();
  }

  async init() {
    // nothing to prepare
  }

  async store(record) {
    this.records.set(record.id, { ...record, sourceRefs: record.sourceRefs || [], evidenceIds: record.evidenceIds || [] });
  }

  async recallAll() {
    return [...this.records.values()];
  }

  async search(query) {
    return this.recallAll().then((all) => all.filter((r) => matchesTokens(r, query)));
  }
}

/** PostgreSQL-backed store (tier-1 production). */
export class PostgresStore {
  /**
   * @param {string} url  postgres:// connection string
   */
  constructor(url) {
    this.url = url;
    this.pool = null;
  }

  async init() {
    const { default: pg } = await import("pg");
    this.pool = new pg.Pool({ connectionString: this.url });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openviking_memory (
        id            text PRIMARY KEY,
        text          text NOT NULL,
        source_refs   jsonb NOT NULL DEFAULT '[]',
        promoted_from text,
        evidence_ids  jsonb NOT NULL DEFAULT '[]',
        promoted_at   timestamptz,
        promoted_by   text
      )
    `);
  }

  async close() {
    if (this.pool) await this.pool.end();
  }

  async store(record) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO openviking_memory (id, text, source_refs, promoted_from, evidence_ids, promoted_at, promoted_by)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           text = EXCLUDED.text,
           source_refs = EXCLUDED.source_refs,
           promoted_from = EXCLUDED.promoted_from,
           evidence_ids = EXCLUDED.evidence_ids,
           promoted_at = EXCLUDED.promoted_at,
           promoted_by = EXCLUDED.promoted_by`,
        [
          record.id,
          record.text,
          JSON.stringify(record.sourceRefs || []),
          record.promotedFrom ?? null,
          JSON.stringify(record.evidenceIds || []),
          record.promotedAt ?? null,
          record.promotedBy ?? null,
        ],
      );
    } finally {
      client.release();
    }
  }

  async recallAll() {
    const { rows } = await this.pool.query(
      `SELECT id, text, source_refs, promoted_from, evidence_ids, promoted_at, promoted_by
       FROM openviking_memory ORDER BY promoted_at NULLS LAST`,
    );
    return rows.map((r) => this.toRecord(r));
  }

  async search(query) {
    const all = await this.recallAll();
    return all.filter((r) => matchesTokens(r, query));
  }

  toRecord(row) {
    return {
      id: row.id,
      text: row.text,
      sourceRefs: row.source_refs || [],
      promotedFrom: row.promoted_from ?? undefined,
      evidenceIds: row.evidence_ids || [],
      promotedAt: row.promoted_at ? new Date(row.promoted_at).toISOString() : undefined,
      promotedBy: row.promoted_by ?? undefined,
    };
  }
}
