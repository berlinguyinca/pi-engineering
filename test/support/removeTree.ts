/**
 * Removing a temporary tree that something may still be writing to.
 *
 * A teardown `rm(root, { recursive: true, force: true })` walks the tree unlinking as it
 * goes. If any writer creates an entry inside a directory the walk has already visited, the
 * closing `rmdir` of that directory returns `ENOTEMPTY` and the whole call rejects — `force`
 * swallows `ENOENT`, not a race. On a loaded runner that is a red pipeline with no assertion
 * failure anywhere in it (#681:
 * `ENOTEMPTY: directory not empty, rmdir '/tmp/rt-host-entry-XXXX/home/.../.git'`).
 *
 * So: make the passes, then say exactly what survived. `EBUSY` and `EPERM` are the same class
 * of transient here; any other errno is a real problem and is reported at once rather than
 * retried until the budget runs out.
 */

import { readdir, rm } from "node:fs/promises";

const TRANSIENT = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

export interface RemoveTreeOptions {
  /** Unlink passes before giving up. Default 40 (~1 s at the default delay). */
  attempts?: number;
  /** Pause between passes in ms. Default 25. */
  delayMs?: number;
  recursive?: boolean;
  force?: boolean;
  /**
   * The unlink pass itself; defaults to `fs.rm`. Overridable for the same reason an injectable
   * clock exists: whether a straggler writer happens to collide with the walk is not a thing a
   * test can force, so the give-up path (budget spent, tree reported) would otherwise be
   * untestable. The normal paths are exercised against the real filesystem.
   */
  pass?: (path: string) => Promise<void>;
}

/**
 * Delete `root`, retrying the passes a straggler writer can disturb.
 *
 * @returns the number of passes taken (1 for a tree nobody is writing to).
 * @throws when the tree is still there after `attempts` passes, or on an errno that retrying
 *   cannot fix. The message names the path, the errno and what was left inside, so a teardown
 *   that genuinely fails stays visible and diagnosable instead of silently leaving a tree.
 */
export async function removeTree(root: string, options: RemoveTreeOptions = {}): Promise<number> {
  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 25;
  const rmOptions = { recursive: options.recursive ?? true, force: options.force ?? true };
  // A `before()` that never ran leaves the file's root empty; there is nothing to remove and
  // `rm("")` would be an ENOENT/EPERM against the process's idea of the filesystem root.
  if (root === "") return 0;

  const unlinkPass = options.pass ?? ((path: string) => rm(path, rmOptions));

  for (let pass = 1; ; pass++) {
    try {
      await unlinkPass(root);
      return pass;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (TRANSIENT.has(code) && pass < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const left = await survivingEntries(root);
      throw new Error(
        `removeTree: ${root} still present after ${pass} attempt${pass === 1 ? "" : "s"}: ` +
          `${code || "unknown errno"} (remaining: ${left.join(", ") || "unknown"})`,
        { cause: err },
      );
    }
  }
}

/** What is left inside the directory, capped so a big tree cannot swamp the error message. */
async function survivingEntries(dir: string, cap = 8): Promise<string[]> {
  try {
    return (await readdir(dir)).slice(0, cap);
  } catch {
    return [];
  }
}
