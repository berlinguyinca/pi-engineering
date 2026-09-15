/**
 * Copy out of the panel, over OSC 52.
 *
 * OSC 52 is the portable path — no dependency, and it works over SSH — but it
 * is **write-only**. The terminal never answers, so there is no way to learn
 * whether the clipboard actually changed. Pi's own implementation says as much
 * (`pi-tui/dist/tui-alt-screen.js`): *"A bare OSC 52 write can show 'Copied!'
 * while leaving the system clipboard untouched."*
 *
 * So this module reports the **action**, never the outcome: "sent to terminal
 * clipboard". The failures it can genuinely detect — there is no terminal, or
 * the write threw — are reported as failures. The design spec asked the panel
 * to report a refused copy; that part is only achievable for those two cases,
 * and pretending otherwise would be the exact false confidence the spec was
 * trying to avoid.
 */

/** What a copy attempt did, from the panel's point of view. */
export interface CopyResult {
  /** Whether the sequence was written. NOT whether the clipboard changed. */
  copied: boolean;
  message: string;
}

/** The slice of a terminal this module writes to (injected in tests). */
export interface CopySink {
  isTTY: boolean;
  write(data: string): void;
}

/** The OSC 52 "set clipboard" sequence for `text`, base64 as UTF-8. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

function defaultSink(): CopySink {
  return {
    isTTY: process.stdout.isTTY === true,
    write: (data: string) => {
      process.stdout.write(data);
    },
  };
}

/**
 * Emit the copy sequence.
 *
 * Never throws: a failed copy is a message to the operator, not an error that
 * reaches Pi's render loop.
 */
export function copyToTerminal(text: string, sink: CopySink = defaultSink()): CopyResult {
  if (!sink.isTTY) {
    return { copied: false, message: "copy failed: not a terminal" };
  }
  try {
    sink.write(osc52(text));
  } catch (err) {
    return { copied: false, message: `copy failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Deliberately not "copied": see the module comment.
  return { copied: true, message: "sent to terminal clipboard" };
}
