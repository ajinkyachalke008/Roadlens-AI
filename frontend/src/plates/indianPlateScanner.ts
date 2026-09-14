import { createWorker, type Worker } from "tesseract.js";
import { parseIndianPlate, type ParsedIndianPlate } from "../../../shared/src/indianPlates";

let ocrWorker: Worker | null = null;
let initializingPromise: Promise<Worker> | null = null;

/**
 * Lazily initialize the in-browser Tesseract OCR worker.
 * Restricts character set to alphanumeric and sets page segmentation for license plates.
 */
async function getOcrWorker(): Promise<Worker> {
  if (ocrWorker) return ocrWorker;
  if (initializingPromise) return initializingPromise;

  initializingPromise = (async () => {
    const worker = await createWorker("eng");
    try {
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -",
      });
    } catch {
      // Fallback if parameter setting is restricted
    }
    ocrWorker = worker;
    return worker;
  })();

  return initializingPromise;
}

export interface IndianPlateScanResult {
  success: boolean;
  plate?: ParsedIndianPlate;
  rawText: string;
  confidence: number;
  cropUrl?: string;
  error?: string;
}

/**
 * Preprocesses a canvas region containing a potential Indian license plate
 * with contrast stretching and noise reduction.
 */
function preprocessPlateRegion(
  sourceCanvas: HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  invert = false,
): HTMLCanvasElement {
  const target = document.createElement("canvas");
  const scale = Math.max(1, Math.min(3, 120 / sh));
  target.width = Math.round(sw * scale);
  target.height = Math.round(sh * scale);

  const ctx = target.getContext("2d", { willReadFrequently: true });
  if (!ctx) return target;

  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, target.width, target.height);

  const imgData = ctx.getImageData(0, 0, target.width, target.height);
  const d = imgData.data;

  // Compute min & max intensity for contrast stretching
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }

  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    let gray = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - min) * (255 / range);
    if (invert) gray = 255 - gray;
    // Binarize high-contrast characters
    const val = gray > 130 ? 255 : 0;
    d[i] = val;
    d[i + 1] = val;
    d[i + 2] = val;
  }

  ctx.putImageData(imgData, 0, 0);
  return target;
}

/**
 * Scans an Indian number plate from a vehicle crop or full canvas.
 * Focuses on the lower 50% of the vehicle where bumper plates are located.
 */
export async function scanIndianPlateFromCanvas(
  canvas: HTMLCanvasElement,
  bbox?: readonly [number, number, number, number] | null,
): Promise<IndianPlateScanResult> {
  const width = canvas.width;
  const height = canvas.height;

  let x = 0;
  let y = Math.round(height * 0.45);
  let w = width;
  let h = Math.round(height * 0.55);

  if (bbox) {
    // bbox in normalized [x, y, w, h] or [minX, minY, maxX, maxY]
    let [bx, by, bw, bh] = bbox;
    // Normalize coordinates if needed
    if (bw <= 1 && bh <= 1) {
      bx = bx * width;
      by = by * height;
      bw = bw * width;
      bh = bh * height;
    }
    // Plates are in the bottom 45% of the vehicle box
    x = Math.max(0, Math.round(bx));
    y = Math.max(0, Math.round(by + bh * 0.45));
    w = Math.min(width - x, Math.round(bw));
    h = Math.min(height - y, Math.round(bh * 0.55));
  }

  if (w < 20 || h < 10) {
    return {
      success: false,
      rawText: "",
      confidence: 0,
      error: "Vehicle crop is too small to locate plate.",
    };
  }

  try {
    const worker = await getOcrWorker();

    // Pass 1: Standard contrast enhancement
    const preprocessed1 = preprocessPlateRegion(canvas, x, y, w, h, false);
    const res1 = await worker.recognize(preprocessed1);
    let parsed = parseIndianPlate(res1.data.text);

    if (parsed?.isValid) {
      return {
        success: true,
        plate: parsed,
        rawText: res1.data.text.trim(),
        confidence: res1.data.confidence / 100,
        cropUrl: preprocessed1.toDataURL("image/jpeg", 0.9),
      };
    }

    // Pass 2: Inverted contrast (for yellow/green plates or night footage)
    const preprocessed2 = preprocessPlateRegion(canvas, x, y, w, h, true);
    const res2 = await worker.recognize(preprocessed2);
    parsed = parseIndianPlate(res2.data.text);

    if (parsed?.isValid) {
      return {
        success: true,
        plate: parsed,
        rawText: res2.data.text.trim(),
        confidence: res2.data.confidence / 100,
        cropUrl: preprocessed2.toDataURL("image/jpeg", 0.9),
      };
    }

    // Pass 3: Raw crop without binarization
    const rawCrop = document.createElement("canvas");
    rawCrop.width = w;
    rawCrop.height = h;
    const ctx = rawCrop.getContext("2d");
    if (ctx) ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    const res3 = await worker.recognize(rawCrop);
    parsed = parseIndianPlate(res3.data.text);

    if (parsed?.isValid) {
      return {
        success: true,
        plate: parsed,
        rawText: res3.data.text.trim(),
        confidence: res3.data.confidence / 100,
        cropUrl: rawCrop.toDataURL("image/jpeg", 0.9),
      };
    }

    const candidateText = res1.data.text || res2.data.text || res3.data.text;
    return {
      success: false,
      rawText: candidateText.trim(),
      confidence: Math.max(res1.data.confidence, res2.data.confidence, res3.data.confidence) / 100,
      cropUrl: preprocessed1.toDataURL("image/jpeg", 0.9),
      error: candidateText ? `Read "${candidateText.trim()}", but does not match Indian RTO format.` : "Could not identify plate characters.",
    };
  } catch (err) {
    return {
      success: false,
      rawText: "",
      confidence: 0,
      error: err instanceof Error ? err.message : "OCR engine error",
    };
  }
}
