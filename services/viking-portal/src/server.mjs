import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";

const BODY_LIMIT = 2 * 1024 * 1024;
const random = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(stream, limit = BODY_LIMIT) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new HttpError(415, "Expected application/json");
  try {
    return JSON.parse((await readBody(req)).toString("utf8"));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON");
  }
}

function recordIsValid(record) {
  return (
    record &&
    !Array.isArray(record) &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    record.id.length <= 4096 &&
    typeof record.text === "string" &&
    ["sourceRefs", "evidenceIds"].every(
      (k) => record[k] == null || (Array.isArray(record[k]) && record[k].every((v) => typeof v === "string")),
    )
  );
}

function cookies(req) {
  const entries = (req.headers.cookie ?? "").split(";").map((v) => v.trim().split(/=(.*)/s));
  return Object.fromEntries(entries.filter((v) => v.length >= 2).map((v) => [v[0], v[1]]));
}

export async function startPortal({
  host = "127.0.0.1",
  port = 0,
  origin,
  issuer,
  cognito,
  keys,
  memory,
  legacy,
  trustProxy = false,
  now = Date.now,
}) {
  const publicURL = new URL(origin);
  if (publicURL.pathname !== "/" || publicURL.search || publicURL.hash || publicURL.username || publicURL.password)
    throw new Error("Origin must be an origin without a path");
  if (
    publicURL.protocol !== "https:" &&
    !(publicURL.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(publicURL.hostname))
  )
    throw new Error("HTTPS is required");
  if (!issuer || !cognito || !keys || !memory) throw new Error("Portal dependencies are required");
  if (legacy) {
    const target = new URL(legacy.baseUrl);
    if (
      !legacy.token ||
      target.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    )
      throw new Error("Legacy backend must be a loopback HTTP origin with a token");
  }
  const secure = publicURL.protocol === "https:";
  const prefix = secure ? "__Host-" : "";
  const sessionName = `${prefix}viking_session`;
  const loginName = `${prefix}viking_login`;
  const cookie = (name, value, seconds) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? "; Secure" : ""}`;
  const attempts = new Map();
  const sessions = new Map();
  const loginRates = new Map();
  const inFlightByOwner = new Map();
  let inFlight = 0;
  const assets = new Map();
  for (const [path, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ]) {
    assets.set(path, { body: await readFile(new URL(`../public/${file}`, import.meta.url)), type });
  }
  const prune = () => {
    for (const map of [attempts, sessions, loginRates])
      for (const [id, row] of map) if (row.expiresAt <= now()) map.delete(id);
  };
  const admitLogin = (req) => {
    const peer = req.socket.remoteAddress;
    const real = req.headers["x-real-ip"];
    const address =
      trustProxy && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) && typeof real === "string" && isIP(real)
        ? real
        : peer;
    let rate = loginRates.get(address);
    if (!rate) {
      if (loginRates.size >= 10000) throw new HttpError(429, "Try signing in again shortly");
      rate = { count: 0, expiresAt: now() + 60000 };
      loginRates.set(address, rate);
    }
    if (rate.count >= 10) throw new HttpError(429, "Too many sign-in attempts. Try again in a minute.");
    rate.count++;
  };
  const limitedMemory = async (owner, fn) => {
    const count = inFlightByOwner.get(owner) ?? 0;
    if (inFlight >= 8 || count >= 2) throw new HttpError(429, "Too many memory requests. Try again shortly.");
    inFlight++;
    inFlightByOwner.set(owner, count + 1);
    try {
      return await fn();
    } finally {
      inFlight--;
      const left = inFlightByOwner.get(owner) - 1;
      if (left) inFlightByOwner.set(owner, left);
      else inFlightByOwner.delete(owner);
    }
  };
  const getSession = (req) => sessions.get(hash(cookies(req)[sessionName] ?? ""));
  const json = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  };
  const browserSession = (req) => {
    const session = getSession(req);
    if (!session || session.expiresAt <= now()) throw new HttpError(401, "Sign in required");
    return session;
  };
  const csrf = (req, session) => {
    if (req.headers.origin !== publicURL.origin || !same(req.headers["x-csrf-token"], session.csrfToken))
      throw new HttpError(403, "Request verification failed");
  };
  const principal = async (req) => {
    if (req.headers.authorization) {
      const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization);
      const key = match && (await keys.authenticate(match[1]));
      if (!key) throw new HttpError(401, "Invalid or expired access key");
      return key;
    }
    const session = browserSession(req);
    return { owner: session.owner, scopes: ["memory:read"] };
  };

  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      prune();
      const url = new URL(req.url, publicURL);
      const path = url.pathname;
      const method = req.method;
      if (method === "GET" && assets.has(path)) {
        const asset = assets.get(path);
        res.writeHead(200, { "content-type": asset.type });
        res.end(asset.body);
        return;
      }
      if (method === "GET" && path === "/health") {
        try {
          await memory.health();
          await keys.list("health-check");
          json(res, 200, { status: "ok" });
        } catch {
          json(res, 503, { status: "degraded" });
        }
        return;
      }
      if (method === "GET" && path === "/auth/login") {
        admitLogin(req);
        if (attempts.size >= 1000) throw new HttpError(429, "Try signing in again shortly");
        const state = random();
        const nonce = random();
        const verifier = random();
        attempts.set(state, { nonce, verifier, expiresAt: now() + 300000 });
        res.setHeader("set-cookie", cookie(loginName, state, 300));
        res.writeHead(302, { location: cognito.authorizationUrl({ state, nonce, verifier }) });
        res.end();
        return;
      }
      if (method === "GET" && path === "/auth/callback") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const attempt = attempts.get(state);
        if (
          !attempt ||
          !same(cookies(req)[loginName], state) ||
          !code ||
          code.length > 8192 ||
          url.searchParams.has("error")
        )
          throw new HttpError(400, "Invalid or expired sign-in request");
        attempts.delete(state);
        res.setHeader("set-cookie", cookie(loginName, "", 0));
        if (sessions.size >= 10000) throw new HttpError(429, "Try signing in again shortly");
        let identity;
        try {
          identity = await cognito.exchange({ code, nonce: attempt.nonce, verifier: attempt.verifier });
        } catch {
          throw new HttpError(401, "Sign-in could not be verified");
        }
        if (
          typeof identity.sub !== "string" ||
          !identity.sub ||
          !Number.isFinite(identity.expiresAt) ||
          identity.expiresAt <= now()
        )
          throw new HttpError(401, "Sign-in could not be verified");
        const secret = random();
        const expiresAt = Math.min(identity.expiresAt, now() + 3600000);
        sessions.set(hash(secret), {
          owner: hash(`${issuer}\0${identity.sub}`),
          email: identity.email ?? "",
          csrfToken: random(),
          expiresAt,
        });
        res.setHeader("set-cookie", [
          cookie(loginName, "", 0),
          cookie(sessionName, secret, Math.floor((expiresAt - now()) / 1000)),
        ]);
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      if (method === "GET" && path === "/api/me") {
        const session = browserSession(req);
        json(res, 200, {
          email: session.email,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          baseUrl: publicURL.origin,
        });
        return;
      }
      if (method === "POST" && path === "/auth/logout") {
        const session = browserSession(req);
        csrf(req, session);
        sessions.delete(hash(cookies(req)[sessionName]));
        res.setHeader("set-cookie", cookie(sessionName, "", 0));
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === "/api/keys" && ["GET", "POST"].includes(method)) {
        const session = browserSession(req);
        if (method === "GET") {
          json(res, 200, await keys.list(session.owner));
          return;
        }
        csrf(req, session);
        const input = await readJson(req);
        if (!input || Array.isArray(input) || typeof input !== "object")
          throw new HttpError(400, "Invalid access key options");
        let key;
        try {
          key = await keys.create(session.owner, {
            name: input.name,
            scopes: input.scopes,
            expiresInDays: input.expiresInDays,
          });
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError)
            throw new HttpError(400, "Invalid access key options or active key limit reached");
          throw error;
        }
        json(res, 201, key);
        return;
      }
      if (path.startsWith("/api/keys/") && method === "DELETE") {
        const session = browserSession(req);
        csrf(req, session);
        if (!(await keys.revoke(session.owner, path.slice("/api/keys/".length))))
          throw new HttpError(404, "Access key not found");
        res.writeHead(204);
        res.end();
        return;
      }
      const memoryRoute =
        (path === "/memory" && ["GET", "POST"].includes(method)) || (path === "/memory/search" && method === "GET");
      if (memoryRoute && legacy && same(req.headers.authorization, `Bearer ${legacy.token}`)) {
        const body = method === "POST" ? await readBody(req) : undefined;
        const upstream = await fetch(`${legacy.baseUrl.replace(/\/$/, "")}${path}${url.search}`, {
          method,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: { authorization: `Bearer ${legacy.token}`, "content-type": "application/json" },
        });
        const output = await readBody(upstream.body, 16 * 1024 * 1024);
        res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
        res.end(output);
        return;
      }
      if (memoryRoute) {
        const actor = await principal(req);
        const scope = method === "POST" ? "memory:write" : "memory:read";
        if (!actor.scopes.includes(scope)) throw new HttpError(403, "Access key lacks the required permission");
        if (method === "POST") {
          const record = await readJson(req);
          if (!recordIsValid(record)) throw new HttpError(400, "Invalid memory record");
          await limitedMemory(actor.owner, () => memory.store(actor.owner, record));
          json(res, 201, { id: record.id });
          return;
        }
        const query = url.searchParams.get("q") ?? "";
        if (query.length > 4096) throw new HttpError(400, "Search is too long");
        json(
          res,
          200,
          await limitedMemory(actor.owner, () =>
            path === "/memory" ? memory.recallAll(actor.owner) : memory.search(actor.owner, query),
          ),
        );
        return;
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      if (!res.headersSent)
        json(res, status, { error: error instanceof HttpError ? error.message : "Service temporarily unavailable" });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    url: `http://${host}:${server.address().port}`,
    server,
    close: async () => {
      sessions.clear();
      attempts.clear();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
