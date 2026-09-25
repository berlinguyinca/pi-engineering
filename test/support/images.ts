/**
 * Real image bytes for request-size tests, encoded with pngjs (no fakes).
 *
 * `noiseRows` rows of pseudo-random pixels make the PNG incompressible there,
 * which is how the encoded size is steered; the rest is a gradient.
 */
import { PNG } from "pngjs";

export function makePng(width: number, height: number, noiseRows: number, seed = 1): Buffer {
  const png = new PNG({ width, height });
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s & 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (y < noiseRows) {
        png.data[i] = next();
        png.data[i + 1] = next();
        png.data[i + 2] = next();
      } else {
        png.data[i] = (x * 255) / width;
        png.data[i + 1] = (y * 255) / height;
        png.data[i + 2] = 128;
      }
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

export function pngImage(width: number, height: number, noiseRows: number, seed = 1) {
  return {
    type: "image" as const,
    mimeType: "image/png",
    data: makePng(width, height, noiseRows, seed).toString("base64"),
  };
}
