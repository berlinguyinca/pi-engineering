/**
 * Duration parsing for resilience configuration.
 *
 * Accepts plain milliseconds ("90000") or human strings ("90m", "10s", "1h30m").
 * Returns `null` when the input is not a valid duration so callers can fall
 * back to defaults.
 */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a duration string into milliseconds. Supports plain integers
 * (interpreted as ms) and human strings composed of `<number><unit>` segments
 * with units ms/s/m/h ("90m", "1h30m", "10s", "1500ms"). Returns null on
 * invalid input.
 */
export function parseDurationMs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  let total = 0;
  let matched = false;
  let rest = trimmed;
  while (true) {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)(.*)$/.exec(rest);
    if (!m) break;
    const value = Number(m[1]);
    const unit = m[2] as string;
    const factor = UNIT_MS[unit];
    if (factor === undefined) break;
    total += value * factor;
    matched = true;
    rest = (m[3] as string).trim();
    if (!rest) break;
  }
  return matched && rest === "" ? Math.round(total) : null;
}
