import { readFile } from "node:fs/promises";
import { CognitoClient } from "./cognito.mjs";
import { PostgresKeyStore } from "./keys.mjs";
import { startPortal } from "./server.mjs";
import { UpstreamMemory } from "./upstream.mjs";

async function secret(name, required = true) {
  const file = process.env[`${name}_FILE`];
  const value = (file ? await readFile(file, "utf8") : process.env[name])?.trim();
  if (required && !value) throw new Error(`Missing ${name} or ${name}_FILE`);
  return value;
}

let keys;
try {
  const origin = process.env.VIKING_ORIGIN;
  if (!origin?.startsWith("https://")) throw new Error("VIKING_ORIGIN must use HTTPS");
  const issuer = process.env.VIKING_COGNITO_ISSUER || "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_GjtcM0PCp";
  const cognito = new CognitoClient({
    issuer,
    domain: process.env.VIKING_COGNITO_DOMAIN || "https://us-west-2gjtcm0pcp.auth.us-west-2.amazoncognito.com",
    clientId: process.env.VIKING_COGNITO_CLIENT_ID,
    clientSecret: await secret("VIKING_COGNITO_CLIENT_SECRET", false),
    redirectUri: new URL("/auth/callback", origin).href,
  });
  keys = new PostgresKeyStore({ connectionString: await secret("VIKING_DATABASE_URL") });
  await keys.init();
  const memory = new UpstreamMemory({
    baseUrl: process.env.VIKING_UPSTREAM_URL || "http://127.0.0.1:1933",
    rootKey: await secret("VIKING_UPSTREAM_ROOT_KEY"),
  });
  const legacyToken = await secret("VIKING_LEGACY_TOKEN", false);
  const portal = await startPortal({
    host: "127.0.0.1",
    port: Number(process.env.VIKING_PORT || 8091),
    origin,
    issuer,
    cognito,
    keys,
    memory,
    trustProxy: true,
    legacy: legacyToken
      ? { token: legacyToken, baseUrl: process.env.VIKING_LEGACY_URL || "http://127.0.0.1:8090" }
      : undefined,
  });
  console.log(`Viking portal listening on ${portal.url}`);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    try {
      await portal.close();
      await keys.close();
      clearTimeout(deadline);
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch {
  // Configuration and DB errors can contain credentials; never print their raw payloads.
  console.error("Viking portal failed to start. Check required configuration and database connectivity.");
  await keys?.close().catch(() => {});
  process.exitCode = 1;
}
