/**
 * Ambient type declaration for the optional `pi-blackhole` package.
 *
 * pi-blackhole is an OPTIONAL external package. When absent, the runtime uses
 * the built-in session-memory provider. This declaration lets `import("pi-blackhole")`
 * type-check without requiring the package to be installed (project constraint:
 * core must not depend on optional adapters).
 */
declare module "pi-blackhole" {
  export const version: string;
  export const VERSION: string;
  export interface BlackholeSession {
    id: string;
  }
  export function openSession(
    identity: { project: string; workItem: string; runId: string; role: string; workerId: string; sessionId: string },
    opts?: unknown,
  ): BlackholeSession;
  export function createSession(): BlackholeSession;
  const _default: unknown;
  export default _default;
}
