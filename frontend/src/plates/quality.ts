import { PLATE_LIMITS } from "../../../shared/src/limits";

/**
 * Decide which few frames of a vehicle are worth spending GPU time on.
 *
 * Plate work is bounded, so the buffer for a track holds only a handful of
 * crops and every new candidate has to beat one of them. The signals below are
 * cheap enough to compute on the capture thread for every tracked vehicle: crop
 * size in real pixels, how sharp it is, how far it sits from the frame edge,
 * and how plausible its shape is for a vehicle seen from behind or in front.
 */
export interface CropCandidate {
  /** Vehicle box in the source frame, normalised. */
  bbox: readonly [number, number, number, number];
  sourceWidth: number;
  sourceHeight: number;
  detectionScore: number;
  sharpness: number;
}
/** Sampling grid for the blur estimate; small enough to run every frame. */
const SHARPNESS_EDGE = 96;

/**
 * Mean absolute Laplacian over a downsampled grayscale copy of the crop.
 *
 * This is a relative measure, not a physical one: it is only ever used to rank
 * crops of the same vehicle against each other, which is exactly what the
 * best-frame buffer needs.
 */
export function cropSharpness(
  canvas: HTMLCanvasElement,
  bbox: readonly [number, number, number, number],
): number {
  const sourceWidth = canvas.width;
  const sourceHeight = canvas.height;
  const x = Math.round(bbox[0] * sourceWidth);
  const y = Math.round(bbox[1] * sourceHeight);
  const width = Math.round((bbox[2] - bbox[0]) * sourceWidth);
  const height = Math.round((bbox[3] - bbox[1]) * sourceHeight);
  if (width < 2 || height < 2) return 0;
  const scale = Math.min(1, SHARPNESS_EDGE / Math.max(width, height));
  const targetWidth = Math.max(2, Math.round(width * scale));
  const targetHeight = Math.max(2, Math.round(height * scale));
  const sample = document.createElement("canvas");
  sample.width = targetWidth;
  sample.height = targetHeight;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return 0;
  try {
    context.drawImage(
      canvas,
      x,
      y,
      width,
      height,
      0,
      0,
      targetWidth,
      targetHeight,
    );
    const { data } = context.getImageData(0, 0, targetWidth, targetHeight);
    const gray = new Float32Array(targetWidth * targetHeight);
    for (let index = 0; index < gray.length; index++) {
      const offset = index * 4;
      gray[index] =
        0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!;
    }
    let total = 0;
    let count = 0;
    for (let row = 1; row < targetHeight - 1; row++)
      for (let column = 1; column < targetWidth - 1; column++) {
        const index = row * targetWidth + column;
        total += Math.abs(
          4 * gray[index]! -
            gray[index - 1]! -
            gray[index + 1]! -
            gray[index - targetWidth]! -
            gray[index + targetWidth]!,
        );
        count++;
      }
    return count ? total / count : 0;
  } catch {
    // A tainted canvas cannot be sampled. Rank on the other signals instead.
    return 0;
  } finally {
    sample.width = 1;
    sample.height = 1;
  }
}

/**
 * Combine the signals into one score in (0,1]. Weights are deliberately gentle:
 * this ranks candidates for the same vehicle, so being roughly right matters far
 * more than the exact shape of any one term.
 */
export function cropQuality(candidate: CropCandidate): number {
  const width = (candidate.bbox[2] - candidate.bbox[0]) * candidate.sourceWidth;
  const height = (candidate.bbox[3] - candidate.bbox[1]) * candidate.sourceHeight;
  const longEdge = Math.max(width, height);
  if (longEdge < PLATE_LIMITS.minCropEdge) return 0;
  // Saturates once the crop is large enough that the plate is comfortably
  // resolved; past that, more pixels stop buying accuracy.
  const size = Math.min(1, longEdge / PLATE_LIMITS.cropEdge);
  // A vehicle touching the frame edge is usually cut off, and a cut-off vehicle
  // often has a cut-off plate.
  const margin = Math.min(
    candidate.bbox[0],
    candidate.bbox[1],
    1 - candidate.bbox[2],
    1 - candidate.bbox[3],
  );
  const framing = margin <= 0 ? 0.55 : Math.min(1, 0.7 + margin * 6);
  // Rear and front views are near square; a long thin box is a side view, where
  // the plate is edge-on and usually unreadable.
  const aspect = height > 0 ? width / height : 0;
  const pose = aspect <= 0 ? 0.2 : Math.min(1, 1.6 / Math.max(aspect, 1 / aspect || 1));
  const focus = Math.min(1, candidate.sharpness / 12);
  const score =
    size * 0.34 + focus * 0.28 + framing * 0.18 + pose * 0.12 +
    Math.min(1, Math.max(0, candidate.detectionScore)) * 0.08;
  return Math.max(0, Math.min(1, score));
}
