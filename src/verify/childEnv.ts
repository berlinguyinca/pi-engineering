/**
 * Verifier child-process environment sanitisation (AGENT-002, RESOURCE-005, CI-002, issue #276).
 *
 * When the verifier runs a repository's own test suite inside a mission, the
 * child process inherits the mission's environment, including internal
 * pi-engineering control variables. Those leaked values let a repository's own
 * integration tests create foreign missions inside the live mission namespace
 * and contend for its session registry.
 *
 * `sanitizeVerifierEnv` returns a *copy* of the given environment with the
 * internal pi-engineering variables stripped and `PI_ENGINEERING_VERIFIER_CHILD`
 * set to `'1'` so the child knows it is running under a verifier. Keys listed in
 * `opts.keep` are retained even if they would otherwise be stripped. The input
 * object is never mutated.
 */

/** Environment keys stripped from a verifier child process. */
export const VERIFIER_STRIPPED_ENV_KEYS = [
  "PI_ENGINEERING_STATE_DIR",
  "PI_ENGINEERING_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_ENGINEERING_CONTROL_DIR",
  "PI_ENGINEERING_POLICY",
  "PI_AUTOSPEC_ENABLED",
  "PI_GATEWAY_MAX_CONCURRENCY",
] as const;

/** Options for {@link sanitizeVerifierEnv}. */
export interface SanitizeVerifierEnvOptions {
  /** Keys to retain even if they are otherwise stripped. */
  keep?: string[];
}

const STRIPPED = new Set<string>(VERIFIER_STRIPPED_ENV_KEYS);

/**
 * Return a copy of `env` with the verifier-stripped keys removed (unless listed
 * in `opts.keep`) and `PI_ENGINEERING_VERIFIER_CHILD` set to `'1'`.
 *
 * The input object is never mutated.
 */
export function sanitizeVerifierEnv(env: NodeJS.ProcessEnv, opts: SanitizeVerifierEnvOptions = {}): NodeJS.ProcessEnv {
  const keep = new Set(opts.keep ?? []);
  const result: NodeJS.ProcessEnv = {};

  for (const key of Object.keys(env)) {
    if (STRIPPED.has(key) && !keep.has(key)) {
      continue;
    }
    result[key] = env[key];
  }

  result.PI_ENGINEERING_VERIFIER_CHILD = "1";
  return result;
}
