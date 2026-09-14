import { createHash, randomBytes, randomUUID } from "node:crypto";

const DAY_MS = 86400000;
const MAX_ACTIVE_KEYS = 20;
const VALID_SCOPES = new Set(["memory:read", "memory:write"]);

function validateOwner(owner) {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256) {
    throw new TypeError("A nonempty owner identifier of at most 256 characters is required");
  }
}

function newKey(owner, options, now) {
  validateOwner(owner);
  const { name, scopes, expiresInDays = 30 } = options ?? {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    throw new TypeError("Key name must contain 1 to 100 characters");
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => VALID_SCOPES.has(scope))) {
    throw new TypeError("Key scopes must contain memory:read or memory:write");
  }
  if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90)) {
    throw new RangeError("Key expiry must be an integer from 1 to 90 days or null for no expiry");
  }
  const secret = `vkg_${randomBytes(32).toString("base64url")}`;
  return {
    record: {
      id: randomUUID(),
      owner,
      secretHash: hash(secret),
      name: name.trim(),
      scopes: [...new Set(scopes)],
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresInDays === null ? null : new Date(Number(now) + expiresInDays * DAY_MS).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
    secret,
  };
}

function hash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function validSecret(secret) {
  return typeof secret === "string" && /^vkg_[A-Za-z0-9_-]{43}$/.test(secret);
}

function metadata(record) {
  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

function fromRow(row) {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

/** In-process repository for isolated tests and explicitly ephemeral deployments. */
export class MemoryKeyStore {
  #records = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }
  async init() {}
  async close() {}

  async create(owner, options) {
    const now = this.#now();
    const { record, secret } = newKey(owner, options, now);
    const active = [...this.#records.values()].filter(
      (key) => key.owner === owner && !key.revokedAt && (key.expiresAt === null || Date.parse(key.expiresAt) > now),
    );
    if (active.length >= MAX_ACTIVE_KEYS) throw new RangeError("Maximum active key count reached");
    this.#records.set(record.secretHash, record);
    return { ...metadata(record), secret };
  }

  async list(owner) {
    validateOwner(owner);
    return [...this.#records.values()].filter((key) => key.owner === owner).map(metadata);
  }

  async revoke(owner, id) {
    validateOwner(owner);
    const record = [...this.#records.values()].find((key) => key.owner === owner && key.id === id && !key.revokedAt);
    if (!record) return false;
    record.revokedAt = new Date(this.#now()).toISOString();
    return true;
  }

  async authenticate(secret) {
    if (!validSecret(secret)) return null;
    const record = this.#records.get(hash(secret));
    const now = this.#now();
    if (!record || record.revokedAt || (record.expiresAt !== null && Date.parse(record.expiresAt) <= now)) return null;
    record.lastUsedAt = new Date(now).toISOString();
    return { owner: record.owner, scopes: [...record.scopes] };
  }
}

export class PostgresKeyStore {
  #connectionString;
  #pool;
  #now;

  constructor({ connectionString, now = Date.now }) {
    if (typeof connectionString !== "string" || !connectionString)
      throw new TypeError("PostgreSQL connection string is required");
    this.#connectionString = connectionString;
    this.#now = now;
  }

  async init() {
    if (this.#pool) return;
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: this.#connectionString,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS viking_portal_keys (
        id UUID PRIMARY KEY,
        owner TEXT NOT NULL,
        secret_hash TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        scopes TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )`);
      // Upgrade existing deployments without changing any previously issued key's expiry.
      await pool.query("ALTER TABLE viking_portal_keys ALTER COLUMN expires_at DROP NOT NULL");
      await pool.query("CREATE INDEX IF NOT EXISTS viking_portal_keys_owner_idx ON viking_portal_keys (owner)");
      this.#pool = pool;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close() {
    const pool = this.#pool;
    this.#pool = undefined;
    if (pool) await pool.end();
  }

  async create(owner, options) {
    const now = this.#now();
    const { record, secret } = newKey(owner, options, now);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize count+insert for this owner across all portal processes.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner]);
      const { rows } = await client.query(
        "SELECT COUNT(*)::int AS count FROM viking_portal_keys WHERE owner = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)",
        [owner, new Date(now)],
      );
      if (rows[0].count >= MAX_ACTIVE_KEYS) throw new RangeError("Maximum active key count reached");
      await client.query(
        `INSERT INTO viking_portal_keys (id, owner, secret_hash, name, scopes, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [record.id, owner, record.secretHash, record.name, record.scopes, record.createdAt, record.expiresAt],
      );
      await client.query("COMMIT");
      return { ...metadata(record), secret };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(owner) {
    validateOwner(owner);
    const { rows } = await this.#pool.query(
      `SELECT id, name, scopes, created_at, expires_at, last_used_at, revoked_at
      FROM viking_portal_keys WHERE owner = $1 ORDER BY created_at, id`,
      [owner],
    );
    return rows.map(fromRow);
  }

  async revoke(owner, id) {
    validateOwner(owner);
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      return false;
    const result = await this.#pool.query(
      "UPDATE viking_portal_keys SET revoked_at = $3 WHERE owner = $1 AND id = $2 AND revoked_at IS NULL",
      [owner, id, new Date(this.#now())],
    );
    return result.rowCount === 1;
  }

  async authenticate(secret) {
    if (!validSecret(secret)) return null;
    const { rows } = await this.#pool.query(
      `UPDATE viking_portal_keys SET last_used_at = $2
      WHERE secret_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) RETURNING owner, scopes`,
      [hash(secret), new Date(this.#now())],
    );
    return rows.length ? { owner: rows[0].owner, scopes: [...rows[0].scopes] } : null;
  }
}
