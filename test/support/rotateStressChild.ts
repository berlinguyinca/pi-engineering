// Child for the multi-process rotation stress test: appends N numbered lines to a shared log, rotating at a tiny cap.
import { appendFileSync } from "node:fs";
import { rotateIfOver } from "../../src/runtime/rotateFile.ts";

const [file, id, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  const line = `${id}-${i}-${"x".repeat(50)}\n`;
  rotateIfOver(file as string, line.length, 2000);
  appendFileSync(file as string, line);
}
