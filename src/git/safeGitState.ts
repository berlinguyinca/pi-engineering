/**
 * Pi-private state for safeGit (T16 round 4): the directory the per-call shadow repositories live in, the sweeper
 * that removes the ones a crashed process left behind, and the persisted remote pins / repository expectations.
 *
 * Everything lives under `<state root>/safegit/` (the same machine-local state directory Pi keeps its registry in:
 * `$PI_ENGINEERING_STATE_DIR`, `$XDG_STATE_HOME/pi-engineering` or `~/.local/state/pi-engineering`), created 0700 and
 * verified on every use (a directory, not a symlink, owned by this user, no group/other access). A shared `/tmp`
 * is exactly what a same-user worker can watch with `fs.watch` and race, so nothing git reads is created there.
 *
 * Honest limit: a worker that runs as the SAME user and can read and write this directory can edit the shadow
 * config, the pins and Pi's own code. Hiding this directory from the worker needs a worker sandbox (a separate uid
 * or a mount namespace); see docs/architecture.md, "git hardening".
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateRoot } from "../runtime/isolation/stateDir.ts";

/** Test seams: a unique root per test (so one test never counts another's directories) and an alternative state root. */
export const stateHooks: { stateRoot?: string; shadowRoot?: string; legacyDir?: string | null } = {};

const uid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** Create (when missing) and verify a private directory. Throws when it is not safe to use. */
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} is not a plain directory`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new Error(`${path} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
  return path;
}

export function safeGitStateDir(): string {
  return privateDir(join(stateHooks.stateRoot ?? resolveStateRoot(process.env), "safegit"));
}

export function shadowParentDir(): string {
  if (stateHooks.shadowRoot) return privateDir(stateHooks.shadowRoot);
  return privateDir(join(safeGitStateDir(), "shadow"));
}

// ─── shadow directories ──────────────────────────────────────────────────────────────────────────────────────────

const live = new Set<string>();
export const markShadowLive = (root: string): void => void live.add(root);
export const markShadowDone = (root: string): void => void live.delete(root);

/** Make a directory removable again (the shadow is made read-only while git runs). */
export function removeShadow(root: string): void {
  for (const d of [join(root, ".git", "info"), join(root, ".git"), root]) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* already gone */
    }
  }
  rmSync(root, { recursive: true, force: true });
}

export const SWEEP_MAX_AGE_MS = 30 * 60_000;
const LEGACY_EVERY_MS = 24 * 3_600_000;

/**
 * Listing the shared temp directory can take seconds on a busy machine (hundreds of thousands of entries), so the
 * scan for legacy `pi-safegit-*` leftovers runs at most once a day, remembered by a stamp file in Pi's state dir.
 */
function legacyDue(now: number): boolean {
  try {
    const stamp = join(safeGitStateDir(), "legacy-sweep");
    try {
      if (now - statSync(stamp).mtimeMs < LEGACY_EVERY_MS) return false;
    } catch {
      /* never swept */
    }
    writeFileSync(stamp, `${now}\n`, { mode: 0o600 });
  } catch {
    /* no stamp: sweep anyway, it is only slow */
  }
  return true;
}
let swept = false;

/**
 * Remove shadow directories nobody can still be using: ours (same owner, not a symlink), older than `maxAgeMs`, and
 * not registered as live in this process. A call is bounded by its timeout (60 s by default), so half an hour is
 * far beyond any run in another process. Also removes the `pi-safegit-*` directories earlier versions left in the
 * shared temp directory. Returns how many were removed.
 */
export function sweepStaleShadows(maxAgeMs: number = SWEEP_MAX_AGE_MS, now: number = Date.now()): number {
  let removed = 0;
  const me = uid();
  const sweep = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const full = join(dir, name);
      if (live.has(full)) continue;
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        if (me !== null && st.uid !== me) continue;
        if (now - st.mtimeMs < maxAgeMs) continue;
        removeShadow(full);
        removed++;
      } catch {
        /* raced with another sweeper */
      }
    }
  };
  try {
    sweep(shadowParentDir(), "s-");
  } catch {
    /* no state directory: nothing of ours is there */
  }
  const legacy = stateHooks.legacyDir === undefined ? tmpdir() : stateHooks.legacyDir; // null: tests keep out of the shared /tmp
  if (legacy !== null && legacyDue(now)) sweep(legacy, "pi-safegit-");
  return removed;
}

/** Sweep once per process, lazily (the first shadow created). */
export function sweepOnce(): void {
  if (swept) return;
  swept = true;
  try {
    sweepStaleShadows();
  } catch {
    /* best effort */
  }
}
export function resetSweepForTests(): void {
  swept = false;
}

export function makeShadowRoot(): string {
  const root = mkdtempSync(join(shadowParentDir(), "s-"));
  markShadowLive(root);
  return root;
}

// ─── persisted pins ──────────────────────────────────────────────────────────────────────────────────────────────

interface PinFile {
  v: 1;
  /** real common dir -> canonical remote URLs (see `generateConfig().remoteUrls`) */
  pins: Record<string, string>;
  /** real work tree -> the real common dir Pi saw it use */
  repos: Record<string, string>;
}

const MAX_ENTRIES = 4096;
let cache: { file: string; stamp: string; data: PinFile } | undefined;

function pinPath(): string {
  return join(safeGitStateDir(), "pins.json");
}

function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "absent";
  }
}

function load(): PinFile {
  const file = pinPath();
  const stamp = stampOf(file);
  if (cache && cache.file === file && cache.stamp === stamp) return cache.data;
  let data: PinFile = { v: 1, pins: {}, repos: {} };
  if (stamp !== "absent") {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PinFile>;
      if (parsed && parsed.v === 1 && typeof parsed.pins === "object" && typeof parsed.repos === "object") {
        data = {
          v: 1,
          pins: { ...(parsed.pins as object) } as Record<string, string>,
          repos: { ...(parsed.repos as object) } as Record<string, string>,
        };
      } else {
        throw new Error("unexpected shape");
      }
    } catch (e) {
      // An unreadable pin file must not silently become "nothing is pinned": keep it for the operator and refuse.
      throw new Error(`pi git pin file ${file} is unreadable (${(e as Error).message}); move it aside to start again`);
    }
  }
  cache = { file, stamp, data };
  return data;
}

function save(data: PinFile): void {
  const file = pinPath();
  for (const k of ["pins", "repos"] as const) {
    const keys = Object.keys(data[k]);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete data[k][old];
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(data)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw e;
  }
  cache = { file, stamp: stampOf(file), data };
}

export const pinStore = {
  getPin: (commonDir: string): string | undefined => load().pins[commonDir],
  setPin(commonDir: string, value: string): void {
    const d = load();
    if (d.pins[commonDir] === value) return;
    delete d.pins[commonDir];
    d.pins[commonDir] = value;
    save(d);
  },
  getRepo: (workTree: string): string | undefined => load().repos[workTree],
  setRepo(workTree: string, commonDir: string): void {
    const d = load();
    if (d.repos[workTree] === commonDir) return;
    delete d.repos[workTree];
    d.repos[workTree] = commonDir;
    save(d);
  },
};

/**
 * Operator reset: forget what Pi remembered about repositories (all of it, or the entries naming `path`: a common
 * directory or a work tree). Used after a deliberate remote change or a re-clone at the same path.
 */
export function resetSafeGitPins(path?: string): { pins: number; repos: number } {
  const d = load();
  let pins = 0;
  let repos = 0;
  for (const k of Object.keys(d.pins)) {
    if (path === undefined || k === path) {
      delete d.pins[k];
      pins++;
    }
  }
  for (const k of Object.keys(d.repos)) {
    if (path === undefined || k === path || d.repos[k] === path) {
      delete d.repos[k];
      repos++;
    }
  }
  if (pins + repos > 0) save(d);
  return { pins, repos };
}

/** What Pi remembers (for `pi-engineering git-pins list`). */
export function listSafeGitPins(): {
  pins: Array<{ commonDir: string; remotes: string[] }>;
  repos: Array<{ workTree: string; commonDir: string }>;
} {
  const d = load();
  return {
    pins: Object.entries(d.pins).map(([commonDir, v]) => ({
      commonDir,
      remotes: v === "" ? [] : v.split("\u0001").map((row) => row.replace("\0", " = ")),
    })),
    repos: Object.entries(d.repos).map(([workTree, commonDir]) => ({ workTree, commonDir })),
  };
}

/** Simulate a restart: forget the in-memory copy, keep the file. */
export function dropPinCacheForTests(): void {
  cache = undefined;
}

export function forgetPinsForTests(): void {
  cache = undefined;
  try {
    rmSync(pinPath(), { force: true });
  } catch {
    /* no state directory yet */
  }
}
