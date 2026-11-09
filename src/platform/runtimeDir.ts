import { constants, accessSync, statSync } from "node:fs";

/**
 * `$XDG_RUNTIME_DIR`, when it is a directory you can actually use.
 *
 * The variable is a hint that something *meant* to put a per-user, per-boot directory
 * here — it is not a promise that one exists. A Slurm exec host inherits
 * `XDG_RUNTIME_DIR=/run/user/<uid>` from pam_systemd while systemd-logind never created
 * it, because an ssh session that never opens a real login session gets no user slice;
 * the same shape shows up in containers and on schedulers generally. Code that validates
 * the *value* and then trusts it fails at the first `mkdir` of a child — with ENOENT,
 * pointing at a path the caller never chose.
 *
 * So ask the filesystem: absolute, no NUL, a real directory, writable. `maxBytes` is for
 * callers whose use is length-constrained — a Unix socket path has to fit `sun_path` — and
 * is not a general property of runtime directories, so callers that do not care must not
 * reject on it.
 *
 * Returns `null` when there is no usable runtime directory, which is the common case on
 * macOS (the variable is usually unset) and on any Linux without a user slice. Callers
 * need their own fallback; `/tmp` is short on every supported platform.
 */
export function usableRuntimeDir(env: NodeJS.ProcessEnv = process.env, maxBytes?: number): string | null {
  const raw = env.XDG_RUNTIME_DIR?.trim();
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.includes("\0")) return null;
  if (maxBytes !== undefined && Buffer.byteLength(raw) > maxBytes) return null;
  try {
    if (!statSync(raw).isDirectory()) return null;
    accessSync(raw, constants.W_OK);
  } catch {
    return null;
  }
  return raw;
}
