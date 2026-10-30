import { existsSync, renameSync } from "node:fs";

function compactStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * Rotate `file` to `<file>.<ISO-compact>.<n>` and return the new name. A target
 * that already exists is never overwritten: `n` counts up to the first free
 * name, so every earlier generation survives. Nothing is ever deleted here.
 */
export function rotateWithoutOverwrite(file: string): string {
  const stamp = compactStamp();
  for (let n = 1; ; n++) {
    const target = `${file}.${stamp}.${n}`;
    if (existsSync(target)) continue;
    renameSync(file, target);
    return target;
  }
}
