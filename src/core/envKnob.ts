/**
 * Operator-set duration knobs.
 *
 * A cache default is a guess about one machine's latency, and it is wrong on the machine where someone is
 * staring at it. These knobs let an operator retune a cadence before starting a session instead of patching
 * an installed release — which matters because a release under
 * `~/.local/share/herdr-engineering/pi/releases/<rev>` is immutable by construction: an in-place edit there
 * fails attestation, so the fleet can no longer say what is installed, and the next rollout wipes the edit.
 *
 * Read once at module load, like the `DEFAULT_*` constants they feed, so a knob cannot change behaviour
 * mid-session and a value that never applied is at least consistent for the whole run.
 */

/**
 * Milliseconds from `name`. Unset, unparseable, or below `minMs` keeps `fallback`, so a typo cannot turn a
 * cache into a stampede; the floor is per knob because a snapshot cadence and a health TTL are not nervous at
 * the same rate. Fractional input floors down; `minMs` defaults to one second.
 */
export function envTtlMs(name: string, fallback: number, minMs = 1_000): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= minMs ? Math.floor(raw) : fallback;
}
