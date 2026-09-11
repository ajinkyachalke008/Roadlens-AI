import type { Letterbox } from "./types";

export function letterbox(
  width: number,
  height: number,
  side: number,
): Letterbox {
  if (
    ![width, height, side].every(Number.isInteger) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 16777216 ||
    ![320, 416].includes(side)
  )
    throw new Error("Unsupported source dimensions");
  const scale = Math.min(side / width, side / height);
  const resizedWidth = Math.round(width * scale),
    resizedHeight = Math.round(height * scale);
  if (resizedWidth < 1 || resizedHeight < 1)
    throw new Error("Unsupported source aspect ratio");
  return {
    width,
    height,
    side,
    resizedWidth,
    resizedHeight,
    left: Math.floor((side - resizedWidth) / 2),
    top: Math.floor((side - resizedHeight) / 2),
    scaleX: resizedWidth / width,
    scaleY: resizedHeight / height,
  };
}

/** Pixel-center bilinear RGB resize, no antialias; deterministic across canvas engines.
 * Padding RGB 114, half-up rounded dimensions, asymmetric extra pad bottom/right.
 */
export function preprocessRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  side: number,
) {
  const info = letterbox(width, height, side);
  if (rgba.length !== width * height * 4)
    throw new Error("Invalid RGBA length");
  const plane = side * side,
    tensor = new Float32Array(plane * 3).fill(114 / 255);
  for (let y = 0; y < info.resizedHeight; y++) {
    const sy = Math.max(0, Math.min(height - 1, (y + 0.5) / info.scaleY - 0.5));
    const y0 = Math.floor(sy),
      y1 = Math.min(y0 + 1, height - 1),
      fy = sy - y0;
    for (let x = 0; x < info.resizedWidth; x++) {
      const sx = Math.max(
        0,
        Math.min(width - 1, (x + 0.5) / info.scaleX - 0.5),
      );
      const x0 = Math.floor(sx),
        x1 = Math.min(x0 + 1, width - 1),
        fx = sx - x0;
      const dest = (y + info.top) * side + x + info.left;
      for (let c = 0; c < 3; c++) {
        const a = rgba[(y0 * width + x0) * 4 + c]!,
          b = rgba[(y0 * width + x1) * 4 + c]!;
        const d = rgba[(y1 * width + x0) * 4 + c]!,
          e = rgba[(y1 * width + x1) * 4 + c]!;
        tensor[c * plane + dest] =
          ((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy) /
          255;
      }
    }
  }
  return { tensor, info };
}

export function invertBox(
  box: number[],
  info: Letterbox,
): [number, number, number, number] | null {
  if (box.length !== 4 || !box.every(Number.isFinite)) return null;
  const clipped = box.map((v, i) =>
    Math.max(
      0,
      Math.min(
        1,
        (v - (i % 2 ? info.top : info.left)) /
          (i % 2 ? info.scaleY * info.height : info.scaleX * info.width),
      ),
    ),
  ) as [number, number, number, number];
  return clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : null;
}
