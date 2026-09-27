import { randomUUID } from "node:crypto";
import { readFileSync, rmSync as removeSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface FileLockOwner {
  pid: number;
  host: string;
  openedAt: string;
  ownerToken: string;
}

function lockDirectory(file: string): string {
  return `${file}.lock`;
}

async function readOwner(path: string): Promise<FileLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<FileLockOwner>;
    if (
      typeof value.pid !== "number" ||
      typeof value.host !== "string" ||
      typeof value.openedAt !== "string" ||
      typeof value.ownerToken !== "string"
    ) {
      return undefined;
    }
    return value as FileLockOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function verifiedStale(owner: FileLockOwner): boolean {
  return owner.host === hostname() && !processIsAlive(owner.pid);
}

export class ExclusiveFileLock {
  readonly owner: FileLockOwner;
  readonly path: string;
  private released = false;

  private constructor(path: string, owner: FileLockOwner) {
    this.path = path;
    this.owner = owner;
  }

  static async acquire(file: string): Promise<ExclusiveFileLock> {
    const path = lockDirectory(file);
    const owner: FileLockOwner = {
      pid: process.pid,
      host: hostname(),
      openedAt: new Date().toISOString(),
      ownerToken: randomUUID(),
    };
    await mkdir(dirname(file), { recursive: true });

    for (;;) {
      try {
        await writeFile(path, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
        return new ExclusiveFileLock(path, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = await readOwner(path);
        if (!current || !verifiedStale(current)) {
          const diagnostic = current
            ? `pid=${current.pid} host=${current.host} openedAt=${current.openedAt} ownerToken=${current.ownerToken}`
            : "owner metadata is missing or unreadable";
          throw new Error(`JSONL writer lock for ${file} is held (${diagnostic})`);
        }

        const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
        try {
          await rename(path, stalePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw renameError;
        }
        await rm(stalePath, { recursive: true, force: true });
      }
    }
  }

  /** Release only this owner's lock. Safe to call repeatedly. */
  release(): void {
    if (this.released) return;
    let current: Partial<FileLockOwner> | undefined;
    try {
      current = JSON.parse(readFileSync(this.path, "utf8")) as Partial<FileLockOwner>;
    } catch {
      return;
    }
    if (current.ownerToken !== this.owner.ownerToken) return;
    removeSync(this.path, { recursive: true, force: true });
    this.released = true;
  }
}
