#!/usr/bin/env node
/** Install a reversible user-local Pi launcher, preserving the original CLI. */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bin = resolve(process.argv[2] ?? join(homedir(), ".local/bin/pi"));
const install = resolve(process.argv[3] ?? join(homedir(), ".local/share/pi-session-auto-resume"));
const manifest = join(install, "install.json");
const marker = "# pi-session-auto-resume launcher";
const previous = existsSync(manifest)
  ? (JSON.parse(readFileSync(manifest, "utf8")) as { originalCli: string })
  : undefined;
if (!existsSync(bin)) throw new Error(`Pi launcher does not exist: ${bin}`);
const stat = lstatSync(bin);
if (!stat.isSymbolicLink() && !readFileSync(bin, "utf8").includes(marker)) {
  throw new Error(`Refusing to replace an unrecognized regular launcher: ${bin}`);
}
const originalCli = previous?.originalCli ?? realpathSync(bin);
if (!existsSync(originalCli)) throw new Error(`Original Pi CLI is missing: ${originalCli}`);
let packageRoot = dirname(originalCli);
while (!existsSync(join(packageRoot, "package.json"))) {
  const parent = dirname(packageRoot);
  if (parent === packageRoot) throw new Error("Cannot locate the original Pi package");
  packageRoot = parent;
}
if (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
  throw new Error("Original launcher does not belong to the Pi coding agent");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of ["scripts", "src/gateway", "src/inference", "node_modules/@earendil-works"])
  mkdirSync(join(install, dir), { recursive: true });
for (const path of [
  "scripts/pi-session-auto-resume.ts",
  "src/gateway/sessionAutoResume.ts",
  "src/inference/admissionContract.ts",
]) {
  copyFileSync(join(root, path), join(install, path));
}
writeFileSync(join(install, "package.json"), JSON.stringify({ private: true, type: "module" }));
const sdkLink = join(install, "node_modules/@earendil-works/pi-coding-agent");
if (!existsSync(sdkLink)) symlinkSync(packageRoot, sdkLink, "dir");
if (!existsSync(`${bin}.before-session-auto-resume`)) symlinkSync(originalCli, `${bin}.before-session-auto-resume`);
writeFileSync(manifest, JSON.stringify({ originalCli, bin }, null, 2), { mode: 0o600 });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const temporary = `${bin}.session-auto-resume-${process.pid}`;
writeFileSync(
  temporary,
  `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${quote(join(install, "scripts/pi-session-auto-resume.ts"))} ${quote(originalCli)} "$@"\n`,
  { mode: 0o755 },
);
renameSync(temporary, bin);
console.log(
  `Installed automatic safe session recovery at ${bin}\nOriginal CLI: ${originalCli}\nBackup launcher: ${bin}.before-session-auto-resume`,
);
