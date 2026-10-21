/**
 * attachInspectorWhenReady — session-start wiring for the inspector feed.
 *
 * Loads the central host config asynchronously (short timeout) and attaches the
 * feed when it enables the inspector. NEVER rejects and never blocks Pi: a host
 * without host.json, an unreachable control plane without a cache, a revoked
 * token or a disabled inspector all resolve null. Config applies at process
 * start only (no refresh loop).
 *
 * Because the attach is asynchronous, Pi's `session_start` may already have
 * fired. It is remembered and replayed into the feed's own `session_start`
 * handler so the lifecycle/capabilities events are not lost.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HostConfigUnavailable } from "./HostConfig.ts";
import { type InspectorFeedHandle, type InspectorFeedOptions, attachInspectorFeedFromHost } from "./InspectorFeed.ts";
import type { LoadHostConfigOptions } from "./HostConfig.ts";

export interface AttachInspectorOptions extends Partial<InspectorFeedOptions> {
  fetch?: typeof globalThis.fetch;
  hostConfig?: LoadHostConfigOptions;
  /** One concise, secret-free line; omit to stay silent. */
  log?: (line: string) => void;
}

export async function attachInspectorWhenReady(
  pi: ExtensionAPI,
  opts: AttachInspectorOptions = {},
): Promise<InspectorFeedHandle | null> {
  const { log, hostConfig, ...rest } = opts;
  let seenStart: { event: unknown; ctx: unknown } | undefined;
  const feedStartHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  let attaching = true;
  try {
    pi.on("session_start", ((event: unknown, ctx: unknown) => {
      if (attaching) seenStart = { event, ctx };
    }) as never);
    const proxy = new Proxy(pi, {
      get(target, prop, receiver) {
        if (prop === "on") {
          return (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
            if (name === "session_start") feedStartHandlers.push(handler);
            return (target.on as (n: string, h: unknown) => unknown)(name, handler);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const handle = await attachInspectorFeedFromHost(proxy as ExtensionAPI, {
      ...rest,
      hostConfig: { timeoutMs: 3000, ...hostConfig },
    });
    attaching = false;
    if (handle && seenStart) {
      for (const h of feedStartHandlers) {
        try {
          h(seenStart.event, seenStart.ctx);
        } catch {
          // the feed must never throw into Pi
        }
      }
    }
    return handle;
  } catch (err) {
    attaching = false;
    if (err instanceof HostConfigUnavailable) {
      // HostConfigUnavailable messages never contain the token or values.
      log?.(`[inspector] off: ${err.message}`);
    } else {
      log?.("[inspector] off: could not attach the feed");
    }
    return null;
  }
}
