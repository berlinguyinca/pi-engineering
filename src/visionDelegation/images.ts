/**
 * Save pasted images to disk, named by the sha256 of their decoded bytes.
 *
 * Pi computes every hash; the vision model only copies it back. Identical bytes
 * give one file and equal hashes. Empty or non-decodable data is an error: a
 * broken image must fail the delegation, never be sent on.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SavedImage } from "./protocol.ts";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType.trim().toLowerCase()] ?? "bin";
}

function decode(data: string, index: number): Buffer {
  const compact = data.replace(/\s+/g, "");
  if (compact.length === 0) throw new Error(`image ${index + 1} has empty data`);
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error(`image ${index + 1} is not valid base64`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0) throw new Error(`image ${index + 1} decodes to no bytes`);
  return bytes;
}

/** Write each image to `<dir>/images/<sha256>.<ext>`; base64 `data` as in Pi's ImageContent. */
export async function saveImages(
  images: Array<{ data: string; mimeType: string }>,
  dir: string,
): Promise<SavedImage[]> {
  // Decode everything first so one bad image writes nothing.
  const decoded = images.map((img, i) => ({ bytes: decode(img.data, i), mimeType: img.mimeType }));
  const imagesDir = join(dir, "images");
  await mkdir(imagesDir, { recursive: true });
  const saved: SavedImage[] = [];
  for (const { bytes, mimeType } of decoded) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(imagesDir, `${sha256}.${extensionFor(mimeType)}`);
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    saved.push({ path, sha256, mimeType });
  }
  return saved;
}

/**
 * R24: one entry per distinct saved file, first occurrence order. The same picture pasted twice saves to
 * the same path; sending it twice would make an obedient model echo it twice, which `parseResult` rejects.
 */
export function uniqueByPath(images: SavedImage[]): SavedImage[] {
  const seen = new Set<string>();
  return images.filter((i) => {
    if (seen.has(i.path)) return false;
    seen.add(i.path);
    return true;
  });
}
