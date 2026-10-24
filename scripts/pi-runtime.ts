#!/usr/bin/env node
/**
 * Pi runtime helper (see src/runtime/piRuntime.ts).
 *
 *   pi-runtime.ts verify <binary> <sha256> [version]   hash, compare, write the verification stamp
 *   pi-runtime.ts status [cwd]                         what the launcher would select here
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  decideLaunchRuntime,
  detectHost,
  unsupportedHostReason,
  verifyRuntimeBinary,
} from "../src/runtime/piRuntime.ts";

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "verify" && a && b) {
  const stamp = await verifyRuntimeBinary(resolve(a), b, c);
  console.log(`verified ${resolve(a)} sha256=${stamp.sha256}${c ? ` version=${c}` : ""}`);
} else if (cmd === "status") {
  const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
  const host = detectHost();
  const decision = await decideLaunchRuntime(resolve(a ?? process.cwd()), agentDir, process.env, host);
  console.log(JSON.stringify({ host, hostRefusal: unsupportedHostReason(host), decision }, null, 2));
} else {
  console.error("usage: pi-runtime.ts verify <binary> <sha256> [version] | status [cwd]");
  process.exit(2);
}
