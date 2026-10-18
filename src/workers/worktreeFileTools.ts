import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type ToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isWithin } from "../runtime/isolation/WorktreeIdentity.ts";
import { createTolerantEditTool } from "./tolerantFileTools.ts";

/** Resolve new files via their existing ancestor; never follow a dangling symlink. */
async function destination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink()) throw new Error("Cannot mutate a dangling symlink in an assigned worktree");
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await destination(parent), basename(path));
  }
}

/**
 * Enforce the worker's file mutation boundary at Pi's filesystem operations,
 * after Pi resolves absolute paths, @ paths, file URLs and home expansion.
 * Reads remain unrestricted. Shell isolation is a separate runtime boundary.
 */
export async function createWorktreeFileTools(cwd: string, tolerant: boolean): Promise<ToolDefinition[]> {
  const root = await realpath(cwd);
  const checked = async (path: string): Promise<string> => {
    const target = await destination(path);
    if (!isWithin(root, target)) throw new Error("File mutation outside assigned worktree is not allowed");
    return target;
  };
  const write = async (path: string, content: string): Promise<void> => {
    await writeFile(await checked(path), content, "utf8");
  };
  const editOptions = {
    operations: {
      access: async (path: string) => access(await checked(path)),
      readFile: (path: string) => readFile(path),
      writeFile: write,
    },
  };
  return [
    (tolerant
      ? createTolerantEditTool(cwd, editOptions)
      : createEditToolDefinition(cwd, editOptions)) as ToolDefinition,
    createWriteToolDefinition(cwd, {
      operations: {
        mkdir: async (path) => {
          await mkdir(await checked(path), { recursive: true });
        },
        writeFile: write,
      },
    }) as ToolDefinition,
  ];
}
