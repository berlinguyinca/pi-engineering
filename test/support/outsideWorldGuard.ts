/**
 * Makes "no network, no subprocess" a testable claim: while installed, any use
 * of fetch, http(s), net, dns or child_process throws, except spawning an
 * executable that lives under `allowSpawnUnder` (a fake CLI in a temp dir).
 * Every attempt is recorded in `attempts`.
 */
import childProcess from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

type Fn = (...args: unknown[]) => unknown;

export function installOutsideWorldGuard(opts: { allowSpawnUnder?: string } = {}): {
  attempts: string[];
  restore: () => void;
} {
  const attempts: string[] = [];
  const saved: Array<() => void> = [];
  const patch = (obj: object, name: string, guard: (original: Fn, args: unknown[]) => unknown): void => {
    const target = obj as Record<string, Fn>;
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      return guard(original.bind(this) as Fn, args);
    } as Fn;
    saved.push(() => {
      target[name] = original;
    });
  };
  const deny = (what: string) => () => {
    attempts.push(what);
    throw new Error(`outside world blocked: ${what}`);
  };
  patch(globalThis, "fetch", deny("fetch"));
  for (const [mod, label] of [
    [http, "http"],
    [https, "https"],
  ] as const) {
    patch(mod, "request", deny(`${label}.request`));
    patch(mod, "get", deny(`${label}.get`));
  }
  for (const name of ["connect", "createConnection"]) patch(net, name, deny(`net.${name}`));
  patch(net.Socket.prototype, "connect", deny("net.Socket.connect"));
  for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) patch(dns, name, deny(`dns.${name}`));
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    patch(childProcess, name, (original, args) => {
      const file = String(args[0]);
      if (opts.allowSpawnUnder && file.startsWith(`${opts.allowSpawnUnder}/`)) return original(...args);
      attempts.push(`child_process.${name}(${file})`);
      throw new Error(`outside world blocked: child_process.${name}(${file})`);
    });
  }
  for (const name of ["exec", "execSync", "fork"]) patch(childProcess, name, deny(`child_process.${name}`));
  syncBuiltinESMExports();
  return {
    attempts,
    restore: () => {
      for (const undo of saved.reverse()) undo();
      syncBuiltinESMExports();
    },
  };
}
