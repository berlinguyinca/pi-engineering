/**
 * Repeat suppression for diagnostics.
 *
 * A gateway holding a session back re-emits the same condition every thirty
 * seconds, and the footer already carries the live countdown. The notification
 * exists to explain the silence once, not to keep announcing it.
 *
 * The key is the notice's `key` when it has one, and its text otherwise —
 * never the text alone. A gateway wait names the live queue depth, so two waits
 * for one condition are different strings: throttling on the text would silence
 * the case it should not (an unchanging repeat) and let through the one it
 * should (the same condition, renumbered).
 */

import type { TelemetryNotice } from "./sink.ts";

/** How long one condition stays suppressed after it is shown. */
export const DEFAULT_REPEAT_MS = 60_000;

/** Distinct conditions remembered before old ones are swept. */
const MAX_TRACKED = 64;

export interface ThrottleOptions {
  repeatMs?: number;
  now?: () => number;
}

/**
 * A predicate: should this notice be shown?
 *
 * Stateful, and one instance per surface — two sessions must not share a
 * suppression window.
 */
export function createRepeatThrottle(opts: ThrottleOptions = {}): (notice: TelemetryNotice) => boolean {
  const repeatMs = opts.repeatMs ?? DEFAULT_REPEAT_MS;
  const now = opts.now ?? (() => Date.now());
  const shownAt = new Map<string, number>();

  return (notice: TelemetryNotice): boolean => {
    const at = now();
    const key = notice.key ?? notice.text;
    const previous = shownAt.get(key);
    if (previous !== undefined && at - previous < repeatMs) return false;
    shownAt.set(key, at);
    // A HARD cap, which it was not: sweeping only expired entries left the map
    // free to grow without limit whenever more than MAX_TRACKED distinct
    // conditions appeared inside one window, and the comment claiming
    // otherwise was the kind of unverifiable assurance a review exists to
    // catch. Expired entries go first — dropping those is free, since they no
    // longer suppress anything. If that is not enough, the OLDEST live entries
    // go too: evicting one can only un-suppress a repeat, never silence
    // something, so the cap costs at worst a duplicate notice under a burst
    // that is already noisier than the throttle can help with.
    if (shownAt.size > MAX_TRACKED) {
      for (const [seen, when] of shownAt) {
        if (at - when >= repeatMs) shownAt.delete(seen);
      }
      // Map iteration is insertion-ordered, so the front is the oldest.
      for (const seen of shownAt.keys()) {
        if (shownAt.size <= MAX_TRACKED) break;
        shownAt.delete(seen);
      }
    }
    return true;
  };
}
