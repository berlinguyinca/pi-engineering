/**
 * Test instrumentation, preloaded into a CHILD pi-engineering process with `node --import`: blocks fetch/http/net/dns and
 * child_process (except spawning under TEST_ALLOW_SPAWN_UNDER, the FAKE plannotator directory), records every attempt and
 * prints them as one `__GUARD__<json>` line on stderr at exit, so the parent can assert "no network use".
 * (The allow-dir is test plumbing, not product configuration.)
 */
import { installOutsideWorldGuard } from "../../support/outsideWorldGuard.ts";

const allow = process.env.TEST_ALLOW_SPAWN_UNDER;
const guard = installOutsideWorldGuard(allow ? { allowSpawnUnder: allow } : {});
process.on("exit", () => {
  process.stderr.write(`\n__GUARD__${JSON.stringify(guard.attempts)}\n`);
});
