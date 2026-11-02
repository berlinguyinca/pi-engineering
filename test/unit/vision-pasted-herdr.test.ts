/**
 * Ruling R29: herdr's clipboard files (`<tmpdir>/herdr-clipboard-images-<uid>/client-<n>-clipboard-<d>-<k>.<ext>`)
 * are recognized as pasted images with the same safety as Pi's own clipboard files. Every test builds a SANDBOX
 * tmpdir (mkdtemp under the real os.tmpdir(), removed in finally) and injects it, so the user's real herdr
 * directory is never touched.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pastedPaths, readPastedImages, rewritePastedText } from "../../src/visionDelegation/pastedImages.ts";

const UID = process.getuid?.() as number;
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A sandbox `tmp` dir (the injected tmpdir) with a `herdr-clipboard-images-<uid>` dir at mode 0700. */
async function withSandbox(
  fn: (s: { root: string; tmp: string; herdr: string; io: { tmpdir: string; uid: number } }) => Promise<void>,
  opts: { dirUid?: number } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "vision-herdr-sbx-"));
  try {
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const herdr = join(tmp, `herdr-clipboard-images-${opts.dirUid ?? UID}`);
    mkdirSync(herdr, { mode: 0o700 });
    chmodSync(herdr, 0o700);
    await fn({ root, tmp, herdr, io: { tmpdir: tmp, uid: UID } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let seq = 0;
function herdrFile(dir: string, content = "herdr-png", ext = "png", name?: string): string {
  const path = join(dir, name ?? `client-20-clipboard-17936595343740990${seq++}-0.${ext}`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

test("R29 (a): a genuine herdr clipboard file is recognized, read, and the text rewritten", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const path = herdrFile(herdr, "herdr-bytes");
    const text = `what is this? ${path}`;
    assert.deepEqual(pastedPaths(text, io), [path]);
    const out = await readPastedImages(pastedPaths(text, io), io);
    assert.equal(out.problem, undefined);
    assert.deepEqual(out.images, [{ path, data: b64("herdr-bytes"), mimeType: "image/png" }]);
    assert.equal(
      rewritePastedText(
        text,
        out.images.map((i) => i.path),
      ),
      "what is this? [pasted image 1]",
    );
    const jpg = herdrFile(herdr, "j", "jpeg");
    const out2 = await readPastedImages([jpg], io);
    assert.equal(out2.images[0]?.mimeType, "image/jpeg");
  });
});

test("R29: quoted, backticked, several and repeated herdr paths are found in order, deduped", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const a = herdrFile(herdr, "a");
    const b = herdrFile(herdr, "b", "webp");
    const text = `see "${a}" and \`${b}\`, then ${a}.`;
    assert.deepEqual(pastedPaths(text, io), [a, b]);
    const out = await readPastedImages(pastedPaths(text, io), io);
    assert.deepEqual(
      out.images.map((i) => i.mimeType),
      ["image/png", "image/webp"],
    );
    assert.equal(
      rewritePastedText(
        text,
        out.images.map((i) => i.path),
      ),
      'see "[pasted image 1]" and `[pasted image 2]`, then [pasted image 1].',
    );
  });
});

test("R29 (b): a herdr directory with group/other permission bits is plain text", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const path = herdrFile(herdr);
    chmodSync(herdr, 0o755);
    assert.deepEqual(await readPastedImages([path], io), { images: [] });
    chmodSync(herdr, 0o710);
    assert.deepEqual(await readPastedImages([path], io), { images: [] });
  });
});

test("R29 (c): a herdr directory that is a symlink to another sandbox directory is plain text", async () => {
  await withSandbox(async ({ root, tmp, io }) => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    chmodSync(elsewhere, 0o700);
    // Replace the real herdr dir with a symlink of the same (correct) name.
    rmSync(join(tmp, `herdr-clipboard-images-${UID}`), { recursive: true, force: true });
    symlinkSync(elsewhere, join(tmp, `herdr-clipboard-images-${UID}`));
    const path = herdrFile(join(tmp, `herdr-clipboard-images-${UID}`));
    assert.equal(pastedPaths(path, io).length, 1, "textually it looks right");
    assert.deepEqual(await readPastedImages([path], io), { images: [] });

    // A symlinked dir pointing at a correctly named, private dir elsewhere is rejected too.
    const deep = join(root, "deep", `herdr-clipboard-images-${UID}`);
    mkdirSync(deep, { recursive: true, mode: 0o700 });
    chmodSync(deep, 0o700);
    rmSync(join(tmp, `herdr-clipboard-images-${UID}`));
    symlinkSync(deep, join(tmp, `herdr-clipboard-images-${UID}`));
    const path2 = herdrFile(join(tmp, `herdr-clipboard-images-${UID}`), "x");
    assert.deepEqual(await readPastedImages([path2], io), { images: [] });
  });
});

test("R29 (d): a herdr directory for another uid is plain text", async () => {
  await withSandbox(
    async ({ herdr, io }) => {
      const path = herdrFile(herdr);
      assert.deepEqual(pastedPaths(path, io), []);
      assert.deepEqual(await readPastedImages([path], io), { images: [] });
    },
    { dirUid: UID + 1 },
  );
});

test("R29 (e): a wrong herdr basename is plain text", async () => {
  await withSandbox(async ({ herdr, io }) => {
    for (const name of ["client-x-clipboard-1-0.png", "client-1-clipboard-1.png", "client-1-clipboard-1-0.png.bak"]) {
      const path = herdrFile(herdr, "x", "png", name);
      assert.deepEqual(pastedPaths(`look ${path} now`, io), [], name);
      assert.deepEqual(await readPastedImages([path], io), { images: [] }, name);
    }
  });
});

test("R29 (f): a herdr-named file symlink inside the herdr dir is plain text", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const target = herdrFile(herdr, "real-bytes");
    const link = join(herdr, "client-1-clipboard-1-9.png");
    symlinkSync(target, link);
    assert.deepEqual(pastedPaths(link, io), [link]);
    assert.deepEqual(await readPastedImages([link], io), { images: [] });
  });
});

test("R29 (g): a herdr dir nested one level below the tmpdir is plain text", async () => {
  await withSandbox(async ({ tmp, io }) => {
    const nested = join(tmp, "sub", `herdr-clipboard-images-${UID}`);
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    chmodSync(nested, 0o700);
    const path = herdrFile(nested);
    assert.deepEqual(await readPastedImages([path], io), { images: [] });
  });
});

test("R29 (h): a path that traverses out of the tmpdir with .. is plain text", async () => {
  await withSandbox(async ({ root, tmp, io }) => {
    const outside = join(root, "outside", `herdr-clipboard-images-${UID}`);
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    chmodSync(outside, 0o700);
    const real = herdrFile(outside, "outside-bytes");
    const name = real.slice(outside.length + 1);
    const traversing = `${tmp}/herdr-clipboard-images-${UID}/../../outside/herdr-clipboard-images-${UID}/${name}`;
    assert.deepEqual(pastedPaths(traversing, io), [traversing]);
    assert.deepEqual(await readPastedImages([traversing], io), { images: [] });
  });
});

test("R29 (i): mixed Pi-native and herdr paths give two images in order with matching numbers", async () => {
  await withSandbox(async ({ tmp, herdr, io }) => {
    const pi = join(tmp, `pi-clipboard-${randomUUID()}.png`);
    writeFileSync(pi, "pi-bytes");
    const h = herdrFile(herdr, "herdr-bytes", "gif");
    const text = `before ${pi} and ${h} after`;
    assert.deepEqual(pastedPaths(text, io), [pi, h]);
    const out = await readPastedImages(pastedPaths(text, io), io);
    assert.deepEqual(out.images, [
      { path: pi, data: b64("pi-bytes"), mimeType: "image/png" },
      { path: h, data: b64("herdr-bytes"), mimeType: "image/gif" },
    ]);
    assert.equal(
      rewritePastedText(
        text,
        out.images.map((i) => i.path),
      ),
      "before [pasted image 1] and [pasted image 2] after",
    );
    // The existing offset: one attached image first, so pasted files start at 2.
    assert.equal(
      rewritePastedText(
        text,
        out.images.map((i) => i.path),
        2,
      ),
      "before [pasted image 2] and [pasted image 3] after",
    );
  });
});

test("R29 (k): a herdr file whose owner is not the current uid is plain text", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const path = herdrFile(herdr, "bytes");
    // Only the FILE reports a foreign owner (the directory stays ours), so this isolates the file-owner check.
    const fakeLstat = (async (p: string) => {
      const st = await lstat(p);
      if (p === path) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 });
      return st;
    }) as typeof lstat;
    assert.equal((await readPastedImages([path], io)).images.length, 1, "sanity: accepted with the real owner");
    assert.deepEqual(await readPastedImages([path], { ...io, lstat: fakeLstat }), { images: [] });
  });
});

test("R29: a herdr directory whose owner is not the current uid is plain text", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const path = herdrFile(herdr, "bytes");
    // Only the DIRECTORY reports a foreign owner (the file stays ours), so this isolates the dir-owner check.
    const fakeLstat = (async (p: string) => {
      const st = await lstat(p);
      if (p !== path) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 });
      return st;
    }) as typeof lstat;
    assert.deepEqual(await readPastedImages([path], { ...io, lstat: fakeLstat }), { images: [] });
  });
});

test("R29 (k): an injected uid different from the real owner rejects the herdr family", async () => {
  await withSandbox(
    async ({ herdr, io }) => {
      const path = herdrFile(herdr);
      // The dir is named for uid+1 (as the injected uid) but the dir and file are really owned by UID.
      assert.equal(lstatSync(path).uid, UID);
      const other = { ...io, uid: UID + 1 };
      assert.deepEqual(pastedPaths(path, other), [path]);
      assert.deepEqual(await readPastedImages([path], other), { images: [] });
    },
    { dirUid: UID + 1 },
  );
});

test("R29: without a uid (getuid unavailable) the herdr family is not recognized", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const path = herdrFile(herdr);
    const none = { ...io, uid: null };
    assert.deepEqual(pastedPaths(path, none), []);
    assert.deepEqual(await readPastedImages([path], none), { images: [] });
  });
});

test("R29: empty and oversized herdr files are reported like Pi's", async () => {
  await withSandbox(async ({ herdr, io }) => {
    const empty = herdrFile(herdr, "");
    assert.match((await readPastedImages([empty], io)).problem ?? "", /empty/);
    const big = herdrFile(herdr, "");
    const { truncateSync } = await import("node:fs");
    truncateSync(big, 20 * 1024 * 1024 + 1);
    const out = await readPastedImages([big], io);
    assert.match(out.problem ?? "", /20 MiB/);
    assert.ok(!(out.problem ?? "").includes(herdr), "the problem names the file, not the private directory");
  });
});
