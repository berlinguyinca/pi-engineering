import { createHash, createPublicKey, verify } from "node:crypto";

const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 5000;

function requireValue(condition) {
  if (!condition) throw new Error("Invalid authentication data");
}

function text(value, max = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function trustedUrl(value, { originOnly = false, query = false } = {}) {
  const url = new URL(value);
  requireValue(url.protocol === "https:" && !url.username && !url.password && !url.hash);
  requireValue(query || !url.search);
  requireValue(!originOnly || url.pathname === "/");
  return url;
}

function decodePart(part) {
  requireValue(/^[A-Za-z0-9_-]+$/.test(part));
  const bytes = Buffer.from(part, "base64url");
  requireValue(bytes.toString("base64url") === part);
  return bytes;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fixed configured endpoints are the only destinations that receive OAuth data. */
export class CognitoClient {
  #issuer;
  #domain;
  #clientId;
  #clientSecret;
  #redirectUri;
  #fetch;
  #now;

  constructor({
    issuer,
    domain,
    clientId,
    clientSecret,
    redirectUri,
    fetch: fetchImplementation = globalThis.fetch,
    now = Date.now,
  }) {
    try {
      const issuerUrl = trustedUrl(issuer);
      requireValue(issuerUrl.pathname !== "/" && !issuerUrl.pathname.endsWith("/"));
      requireValue(issuerUrl.href === issuer);
      this.#issuer = issuer;
      this.#domain = trustedUrl(domain, { originOnly: true }).origin;
      this.#redirectUri = trustedUrl(redirectUri, { query: true }).href;
      requireValue(text(clientId, 256) && /^[A-Za-z0-9_-]+$/.test(clientId));
      requireValue(clientSecret === undefined || text(clientSecret));
      requireValue(typeof fetchImplementation === "function" && typeof now === "function");
      this.#clientId = clientId;
      this.#clientSecret = clientSecret;
      this.#fetch = fetchImplementation;
      this.#now = now;
    } catch {
      throw new Error("Invalid Cognito configuration");
    }
  }

  authorizationUrl({ state, nonce, verifier }) {
    requireValue(text(state) && text(nonce) && this.#validVerifier(verifier));
    const url = new URL("/oauth2/authorize", this.#domain);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return url.href;
  }

  async exchange({ code, nonce, verifier }) {
    try {
      requireValue(text(code) && text(nonce) && this.#validVerifier(verifier));
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.#clientId,
        code,
        code_verifier: verifier,
        redirect_uri: this.#redirectUri,
      });
      const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      if (this.#clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64")}`;
      }
      const response = await this.#request(`${this.#domain}/oauth2/token`, { method: "POST", headers, body });
      requireValue(object(response) && text(response.id_token, 16 * 1024));
      const parts = response.id_token.split(".");
      requireValue(parts.length === 3);
      const header = JSON.parse(decodePart(parts[0]).toString("utf8"));
      const payload = JSON.parse(decodePart(parts[1]).toString("utf8"));
      const signature = decodePart(parts[2]);
      requireValue(object(header) && header.alg === "RS256" && text(header.kid, 256));
      requireValue(header.crit === undefined && header.b64 === undefined);
      const jwks = await this.#request(`${this.#issuer}/.well-known/jwks.json`, {
        headers: { accept: "application/json" },
      });
      requireValue(object(jwks) && Array.isArray(jwks.keys) && jwks.keys.length <= 100);
      const matching = jwks.keys.filter((key) => object(key) && key.kid === header.kid);
      requireValue(matching.length === 1);
      const jwk = matching[0];
      requireValue(jwk.kty === "RSA" && (jwk.use === undefined || jwk.use === "sig"));
      requireValue(jwk.alg === undefined || jwk.alg === "RS256");
      requireValue(jwk.key_ops === undefined || (Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify")));
      const key = createPublicKey({ key: jwk, format: "jwk" });
      requireValue(key.asymmetricKeyDetails?.modulusLength >= 2048);
      requireValue(verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, signature));
      const seconds = this.#now() / 1000;
      requireValue(Number.isFinite(seconds));
      requireValue(object(payload) && payload.iss === this.#issuer && payload.aud === this.#clientId);
      requireValue(payload.token_use === "id" && payload.nonce === nonce && text(payload.sub, 1024));
      requireValue(Number.isSafeInteger(payload.exp) && Number.isSafeInteger(payload.iat));
      // Cognito ID tokens have at most a 24-hour lifetime; tolerate 60s clock skew only for iat.
      requireValue(payload.exp > seconds && payload.iat <= seconds + 60);
      requireValue(payload.iat >= seconds - 86400 && payload.exp > payload.iat && payload.exp - payload.iat <= 86400);
      requireValue(payload.email === undefined || text(payload.email, 1024));
      return { sub: payload.sub, email: payload.email ?? "", expiresAt: payload.exp * 1000 };
    } catch {
      // Never propagate fetch errors, response bodies, codes, tokens, or client secrets.
      throw new Error("Cognito authentication failed");
    }
  }

  #validVerifier(verifier) {
    return typeof verifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
  }

  async #request(url, options) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Authentication request timed out"));
      }, REQUEST_TIMEOUT_MS);
    });
    const request = async () => {
      const response = await this.#fetch(url, { ...options, redirect: "error", signal: controller.signal });
      requireValue(response.ok && !response.redirected && response.body);
      const contentLength = response.headers.get("content-length");
      requireValue(
        contentLength === null || (/^\d+$/.test(contentLength) && Number(contentLength) <= MAX_RESPONSE_BYTES),
      );
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          requireValue(size <= MAX_RESPONSE_BYTES);
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        reader.cancel().catch(() => {});
      }
    };
    try {
      return await Promise.race([request(), timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
