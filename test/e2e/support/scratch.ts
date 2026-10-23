/**
 * One scratch root per test process, removed when the process exits (the suite's own teardown). Every temp dir an
 * e2e test creates lives below it, so a run leaves nothing in the system temp dir and removes only what it created.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "t16-e2e-"));

process.on("exit", () => {
  try {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort: a crashed child may still hold a file */
  }
});

/** A fresh directory below the per-process scratch root. */
export function scratch(prefix: string): string {
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
}
