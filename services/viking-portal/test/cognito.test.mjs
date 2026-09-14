import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { CognitoClient } from "../src/cognito.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const now = 1_800_000_000_000;
const config = {
  issuer: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_test",
  domain: "https://test.auth.us-west-2.amazoncognito.com",
  clientId: "portal-client",
  redirectUri: "https://viking.example/auth/callback",
  now: () => now,
};
const args = { code: "private-code", nonce: "login-nonce", verifier: "x".repeat(43) };
const claims = {
  iss: config.issuer,
  aud: config.clientId,
  token_use: "id",
  sub: "opaque/user:1",
  email: "user@example.com",
  nonce: args.nonce,
  iat: now / 1000,
  exp: now / 1000 + 3600,
};
function token(overrides = {}, headerOverrides = {}, signingKey = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, ...headerOverrides })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url");
  const signed = `${header}.${body}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), signingKey).toString("base64url")}`;
}
function fixture(idToken = token(), keys = [jwk], overrides = {}) {
  const requests = [];
  const client = new CognitoClient({
    ...config,
    ...overrides,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json(String(url).endsWith("/oauth2/token") ? { id_token: idToken } : { keys });
    },
  });
  return { client, requests };
}

test("rejects tokens that fail identity, freshness, and signature boundaries", async (t) => {
  const cases = [
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["wrong audience", { aud: "scheduler-client" }],
    ["array audience", { aud: [config.clientId] }],
    ["access token", { token_use: "access" }],
    ["wrong nonce", { nonce: "another-login" }],
    ["expired", { exp: now / 1000 }],
    ["missing expiry", { exp: undefined }],
    ["string expiry", { exp: String(now / 1000 + 3600) }],
    ["future issue time", { iat: now / 1000 + 120 }],
    ["missing issue time", { iat: undefined }],
    ["old issue time", { iat: now / 1000 - 86401 }],
    ["issue after expiry", { iat: now / 1000 + 30, exp: now / 1000 + 10 }],
    ["empty subject", { sub: "" }],
    ["non-string subject", { sub: 123 }],
    ["wrong algorithm", {}, { alg: "HS256" }],
    ["unknown key", {}, { kid: "unknown" }],
    ["unsupported critical header", {}, { crit: ["custom"] }],
  ];
  for (const [name, body, header] of cases) {
    await t.test(name, async () => {
      await assert.rejects(fixture(token(body, header)).client.exchange(args), /Cognito authentication failed/);
    });
  }
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(
    fixture(token({}, {}, foreign.privateKey)).client.exchange(args),
    /Cognito authentication failed/,
  );
  for (const malformed of ["not-a-jwt", "e30.e30.bad", "x".repeat(20_000)]) {
    await assert.rejects(fixture(malformed).client.exchange(args), /Cognito authentication failed/);
  }
});

test("constructs authorization code flow with PKCE without a client secret", () => {
  const { client } = fixture(token(), [jwk], { clientSecret: "server-only-secret" });
  const url = new URL(client.authorizationUrl({ ...args, state: "browser-state" }));
  assert.equal(url.origin, config.domain);
  assert.equal(url.pathname, "/oauth2/authorize");
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email profile",
    state: "browser-state",
    nonce: args.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(args.verifier).digest("base64url"),
  })) {
    assert.equal(url.searchParams.get(key), value);
  }
  assert.equal(url.toString().includes("server-only-secret"), false);
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("exchanges code and returns only validated minimal identity", async () => {
  const { client, requests } = fixture(token(), [jwk], { clientSecret: "server-only-secret" });
  assert.deepEqual(await client.exchange(args), { sub: claims.sub, email: claims.email, expiresAt: claims.exp * 1000 });
  assert.deepEqual(
    requests.map((r) => String(r.url)),
    [`${config.domain}/oauth2/token`, `${config.issuer}/.well-known/jwks.json`],
  );
  const form = new URLSearchParams(requests[0].options.body);
  for (const [key, value] of Object.entries({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
  })) {
    assert.equal(form.get(key), value);
  }
  assert.equal(
    requests[0].options.headers.authorization,
    `Basic ${Buffer.from(`${config.clientId}:server-only-secret`).toString("base64")}`,
  );
  for (const request of requests) {
    assert.equal(request.options.redirect, "error");
    assert.ok(request.options.signal instanceof AbortSignal);
  }
  assert.equal(requests[1].options.headers?.authorization, undefined);
});

test("rejects untrusted URL configurations before making requests", () => {
  for (const field of ["issuer", "domain", "redirectUri"]) {
    for (const value of ["http://example.com", "https://user:pass@example.com", "https://example.com/#fragment"]) {
      assert.throws(() => new CognitoClient({ ...config, [field]: value }), /Invalid Cognito configuration/);
    }
  }
  assert.throws(
    () => new CognitoClient({ ...config, domain: `${config.domain}/untrusted` }),
    /Invalid Cognito configuration/,
  );
  assert.throws(
    () => new CognitoClient({ ...config, issuer: `${config.issuer}?url=evil` }),
    /Invalid Cognito configuration/,
  );
});

test("rejects ambiguous or unsuitable signing keys", async () => {
  for (const keys of [
    [jwk, jwk],
    [{ ...jwk, use: "enc" }],
    [{ ...jwk, alg: "RS512" }],
    [{ ...jwk, key_ops: ["encrypt"] }],
    [{ ...jwk, n: "invalid" }],
    [],
  ]) {
    await assert.rejects(fixture(token(), keys).client.exchange(args), /Cognito authentication failed/);
  }
});

test("sanitizes failed, malformed and oversized provider responses", async () => {
  for (const response of [
    () => new Response("private-provider-detail", { status: 400 }),
    () => new Response("not-json"),
    () => Response.json({ access_token: "private-token" }),
    () => new Response("x".repeat(140_000)),
    () => new Response("{}", { headers: { "content-length": "9999999" } }),
    () => {
      throw new Error("private-code server-only-secret");
    },
  ]) {
    const client = new CognitoClient({ ...config, fetch: async () => response() });
    await assert.rejects(client.exchange(args), (error) => {
      assert.equal(error.message, "Cognito authentication failed");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("rejects missing flow values before invoking provider", async () => {
  const { client, requests } = fixture();
  for (const bad of [
    { ...args, code: "" },
    { ...args, nonce: "" },
    { ...args, verifier: "short" },
  ]) {
    await assert.rejects(client.exchange(bad), /Cognito authentication failed/);
  }
  assert.throws(() => client.authorizationUrl({ ...args, state: "" }));
  assert.equal(requests.length, 0);
});

test("bounds provider waits even when fetch does not honor cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const client = new CognitoClient({
    ...config,
    fetch: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(client.exchange(args), /Cognito authentication failed/);
  t.mock.timers.tick(5001);
  await rejected;
  assert.equal(signal.aborted, true);
});

test("bounds a stalled response body as well as response headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CognitoClient({ ...config, fetch: async () => new Response(new ReadableStream({ start() {} })) });
  const rejected = assert.rejects(client.exchange(args), /Cognito authentication failed/);
  await Promise.resolve();
  t.mock.timers.tick(5001);
  await rejected;
});
