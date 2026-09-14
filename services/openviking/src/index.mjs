/**
 * OpenViking service entrypoint (tier-1 container).
 *
 *   DATABASE_URL      postgres://user:pass@host:5432/db   (Postgres mode)
 *   OPENVIKING_TOKEN  optional Bearer auth token
 *   OPENVIKING_PORT   listen port (default 8080)
 *   OPENVIKING_LOG    "1" to enable request logging
 */
import { startServer } from "./server.mjs";
import { MemoryStore, PostgresStore } from "./store.mjs";

const port = Number(process.env.OPENVIKING_PORT || 8080);
const token = process.env.OPENVIKING_TOKEN;
const databaseUrl = process.env.DATABASE_URL;

const store = databaseUrl ? new PostgresStore(databaseUrl) : new MemoryStore();
const logger = process.env.OPENVIKING_LOG === "1" ? console : { log: () => {}, error: () => {} };

const { url } = await startServer({ port, token, store, logger });
logger.log(`openviking listening on ${url} (storage=${databaseUrl ? "postgres" : "memory"}${token ? ", auth=on" : ""})`);
