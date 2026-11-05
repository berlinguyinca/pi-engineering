/**
 * The environment git is handed, kept separate from `safeGit.ts` on purpose.
 *
 * `safeGit` is a heavy module: it maintains persisted remote pins, shadow common
 * directories and state under the Pi state root. The self-update path
 * (`src/update/gitSource.ts`) is a supply-chain boundary that must stay small and
 * side-effect-free, but it needs the same guarantee about the environment it hands
 * `git`: nothing the caller, or the ambient environment, injected counts as config.
 * So the helper lives here and both import it, rather than the update path pulling in
 * the whole of safeGit — which it could not use wholesale anyway, because safeGit
 * refuses `--git-dir` by design and the update cache addresses its bare repository
 * that way.
 */

/**
 * Variables through which a caller or the ambient environment could inject config or
 * redirect the repository; removed before ours are set.
 *
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` and `GIT_CONFIG_PARAMETERS` are the documented
 * injection channels — a single `GIT_CONFIG_KEY_0=url.<evil>.insteadOf` entry is enough
 * to make a remote that was just allow-listed resolve to another repository (issue #590),
 * and on a fresh install the recorded identity root then pins the wrong repository as the
 * true one. `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_CEILING_DIRECTORIES` choose or
 * bound the repository itself, which the caller does explicitly with `-C`/`--git-dir`.
 */
export function withoutInjectedConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "GIT_CONFIG_COUNT" || k === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    if (k === "GIT_DIR" || k === "GIT_WORK_TREE" || k === "GIT_COMMON_DIR" || k === "GIT_CEILING_DIRECTORIES") continue;
    out[k] = v;
  }
  return out;
}
