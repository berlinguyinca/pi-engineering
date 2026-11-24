/**
 * The year a process began in is a fact about the process, not about the clock
 * reading it. macOS `ps -o lstart=` prints that year; `processIncarnation.ts`
 * discarded it and used `new Date().getFullYear()`, so a process that survived
 * 1 January yielded a *different* incarnation after the boundary. Both callers
 * read "present, but a different value" as PID reuse and acted on it: the event
 * store's file lock went `stale` (a second writer may take it) and a runtime
 * session's lease was reclaimed from a process that was alive.
 *
 * The pure helpers take the year and the platform as arguments, so all of this
 * runs on Linux CI too; only the two wiring tests need a real macOS `ps`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { test } from "node:test";
import {
  compareDarwinStartTimes,
  parseDarwinLstart,
  readProcessStartTime,
  startTimesMatch,
} from "../../src/platform/processIncarnation.ts";
import { assessProcess, currentProcessIdentity } from "../../src/runtime/isolation/processIdentity.ts";

const needsPs = process.platform !== "darwin" ? "needs macOS ps and the real probe" : false;

function epoch(y: number, month: number, day: number, h: number, mi: number, s: number): number {
  return Math.floor(new Date(y, month, day, h, mi, s).getTime() / 1000);
}

/** The value the pre-fix code wrote: the same wall clock, the *probe's* year. */
function shiftedOneYear(epochSeconds: number): number {
  const d = new Date(epochSeconds * 1000);
  return Math.floor(
    new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()).getTime() /
      1000,
  );
}

test("the year ps prints wins over the year the probe happens to run in", () => {
  // Real macOS output, trailing padding included.
  const printed = "Fri Nov 20 15:41:48 2026    ";
  const expected = epoch(2026, 10, 20, 15, 41, 48);
  assert.equal(parseDarwinLstart(printed, 2026), expected);
  assert.equal(parseDarwinLstart(printed, 2027), expected, "a probe after New Year must not move the start time");
  assert.equal(parseDarwinLstart(printed, 2035), expected);
});

test("a session alive across 1 January keeps one incarnation", () => {
  // Worst case: one second of life straddles the boundary.
  const lstart = "Thu Dec 31 23:59:59 2026";
  const before = parseDarwinLstart(lstart, 2026);
  const after = parseDarwinLstart(lstart, 2027);
  assert.equal(before, epoch(2026, 11, 31, 23, 59, 59));
  assert.equal(after, before);
});

test("ps output with no printed year falls back to the probe's year", () => {
  // BSD ps omits the year for current-year processes; that is the only job
  // probeYear has, and the answer is unambiguous there.
  assert.equal(parseDarwinLstart("Fri Nov 20 15:41:48", 2026), epoch(2026, 10, 20, 15, 41, 48));
});

test("unparseable or out-of-range ps output yields no start time", () => {
  const junk = [
    "",
    "   ",
    "not a date",
    "Fri Nov 20 2026 15:41:48",
    "Mon Dec 32 23:59:59 2026", // day 32
    "Mon Dec 31 24:00:00 2026", // hour 24
    "Mon Dec 31 23:60:00 2026", // minute 60
    "Mon Dec 31 23:59:60 2026", // second 60
    "Xyz Nov 20 15:41:48 2026", // unknown weekday
    "Tue Feb 31 09:01:02 2026", // day 31 of a 28-day month: Date would say 3 March
    "Thu Apr 31 09:01:02 2026", // day 31 of a 30-day month
    "Sun Feb 29 09:01:02 2026", // leap day in a non-leap year
  ];
  for (const text of junk) assert.equal(parseDarwinLstart(text, 2026), undefined, JSON.stringify(text));
});

test("ps pads a single-digit day with two spaces", () => {
  assert.equal(parseDarwinLstart("Thu Nov  5 09:01:02 2026", 2026), epoch(2026, 10, 5, 9, 1, 2));
  assert.equal(parseDarwinLstart("Thu Nov  5 09:01:02", 2026), epoch(2026, 10, 5, 9, 1, 2));
  assert.equal(parseDarwinLstart("Thu Feb 29 09:01:02 2024", 2026), epoch(2024, 1, 29, 9, 1, 2), "a real leap day parses");
});

test("a leap-day birth recorded pre-fix in a non-leap probe year is year_ambiguous", () => {
  // The pre-fix code rendered "Feb 29" into the probe's year; in 2025 `Date`
  // squeezes that to 1 March, so the stored value and the canonical one do not
  // even share a month. It is still the same process.
  const legacy = String(epoch(2025, 1, 29, 9, 1, 2)); // 1 March 2025
  const canonical = String(epoch(2024, 1, 29, 9, 1, 2)); // 29 February 2024
  assert.notEqual(new Date(Number(legacy) * 1000).getMonth(), 1, "the squeeze must actually have happened");
  assert.equal(compareDarwinStartTimes(legacy, canonical), "year_ambiguous");
  assert.equal(compareDarwinStartTimes(canonical, legacy), "year_ambiguous");
  assert.equal(startTimesMatch(legacy, canonical, "darwin"), true);
  assert.equal(startTimesMatch(legacy, canonical, "linux"), false);
  // Still reuse: a different instant that no pre-fix rendering could produce.
  assert.equal(compareDarwinStartTimes(String(epoch(2024, 2, 1, 9, 1, 2)), canonical), "different", "1 March, same year");
  assert.equal(compareDarwinStartTimes(String(epoch(2025, 1, 28, 9, 1, 2)), canonical), "different", "28 February");
  assert.equal(compareDarwinStartTimes(String(epoch(2025, 1, 29, 9, 1, 3)), canonical), "different", "one second off");
});

test("the DST fall-back hour is the one-hour blind spot ps leaves", () => {
  // Two instants 3600 s apart print as the same `lstart` text, and `Date`
  // resolves that text to the first pass. Pinned to a zone that has the fold.
  const previous = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const first = epoch(2026, 10, 1, 1, 30, 0);
    const second = first + 3600;
    assert.equal(new Date(first * 1000).getTimezoneOffset(), 420, "first pass is PDT");
    assert.equal(new Date(second * 1000).getTimezoneOffset(), 480, "second pass is PST");
    const render = (s: number): string => {
      const d = new Date(s * 1000);
      return `${d.getHours()}:${d.getMinutes()}:${d.getSeconds()} ${d.getMonth()}/${d.getDate()}/${d.getFullYear()}`;
    };
    assert.equal(render(first), render(second), "ps prints the same wall clock for both");
    assert.equal(parseDarwinLstart("Sun Nov  1 01:30:00 2026", 2026), first, "the text resolves to the first pass");
    // Same year, so the year tolerance does not apply: they compare as different
    // instants, but a process from the second pass is *probed* as the first.
    assert.equal(compareDarwinStartTimes(String(first), String(second)), "different");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("year-shifted values are year_ambiguous, never reuse", () => {
  const legacy = String(epoch(2026, 11, 31, 23, 59, 59)); // written pre-fix, probe year 2026
  const canonical = String(epoch(2025, 11, 31, 23, 59, 59)); // same wall clock, true year
  assert.equal(compareDarwinStartTimes(legacy, canonical), "year_ambiguous");
  assert.equal(compareDarwinStartTimes(canonical, legacy), "year_ambiguous");
  assert.equal(compareDarwinStartTimes(legacy, legacy), "exact");
});

test("a genuinely reused pid is still detected", () => {
  const started = String(epoch(2026, 11, 31, 23, 59, 59));
  const cases: Array<[string, string]> = [
    [String(epoch(2026, 11, 31, 23, 59, 58)), "one second earlier, same year"],
    [String(epoch(2026, 10, 31, 23, 59, 59)), "one month earlier"],
    [String(epoch(2025, 11, 31, 23, 59, 58)), "one year and one second apart"],
    [String(epoch(2025, 10, 31, 23, 59, 59)), "one year and one month apart"],
    ["0", "zero is not an instant"],
    ["abc", "not a number"],
  ];
  for (const [other, why] of cases) assert.equal(compareDarwinStartTimes(started, other), "different", why);
});

test("startTimesMatch tolerates the year shift on Darwin only", () => {
  const legacy = String(epoch(2026, 10, 20, 15, 41, 48));
  const canonical = String(epoch(2025, 10, 20, 15, 41, 48));
  assert.equal(startTimesMatch(legacy, legacy, "darwin"), true);
  assert.equal(startTimesMatch(legacy, canonical, "darwin"), true);
  // Linux field 22 is clock ticks since boot: year logic there would compare
  // nothing real, and could match unrelated pairs.
  assert.equal(startTimesMatch(legacy, canonical, "linux"), false);
  assert.equal(
    startTimesMatch(String(epoch(2026, 10, 20, 15, 41, 48)), String(epoch(2026, 10, 20, 15, 41, 47)), "darwin"),
    false,
  );
});

test("the probe reports the printed year for a live process", { skip: needsPs }, () => {
  const printed = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const probed = readProcessStartTime(process.pid);
  assert.equal(probed.state, "present");
  if (probed.state !== "present") return;
  // probeYear 2999 can only be ignored if the printed year is what got used.
  assert.equal(Number(probed.value), parseDarwinLstart(printed, 2999));
});

test("a pre-fix record still reads as alive across the boundary, and reuse still dies", { skip: needsPs }, () => {
  const identity = currentProcessIdentity();
  const probed = readProcessStartTime(process.pid);
  assert.equal(probed.state, "present");
  if (probed.state !== "present") return;
  const trueStart = Number(probed.value);

  // The record a lock/lease would carry if it were written before this fix and
  // probed after 1 January: same wall clock, the probe's year.
  const legacy = String(shiftedOneYear(trueStart));
  assert.notEqual(legacy, probed.value, "the shift must actually move the value for this to prove anything");
  assert.equal(
    assessProcess({ ...identity, host: hostname(), processStartTime: legacy }).state,
    "alive",
    `a live process must not be reclaimed from ${legacy}`,
  );

  // The detection half: a value that is not merely year-shifted is still reuse.
  assert.equal(
    assessProcess({ ...identity, host: hostname(), processStartTime: String(trueStart + 1) }).state,
    "dead",
    "one second off must still be proven reuse",
  );
});
