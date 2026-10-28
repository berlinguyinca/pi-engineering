/**
 * Environment handed to commands whose text a worker can author (package.json scripts, CI files, AGENTS.md,
 * Makefile targets run by the verifier, CAV deterministic tests).
 *
 * T16 removes every `HERDR_*` variable: the retired HERDR_INGEST_URL / HERDR_INGEST_API_KEY / HERDR_HOST_ID and the
 * bridge's HERDR_ENGINEERING_CONTROL_PLANE_* pair are Pi's own control-plane credentials, and a repository's test
 * suite has no business with them. Nothing else is removed here: builds and tests legitimately need PATH, HOME,
 * proxy and registry settings, and a project may need its own API keys or an ssh agent. Scrubbing GitHub tokens,
 * `SSH_AUTH_SOCK` and secret-looking names (audit M14) would change what standalone Pi lets a project's checks do,
 * so it is a separate, explicit decision (a global-YAML allow/deny list), not made here.
 */
export function isScrubbedEnvName(name: string): boolean {
  return name.startsWith("HERDR_");
}

export function workerCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isScrubbedEnvName(name)) env[name] = value;
  }
  return env;
}
