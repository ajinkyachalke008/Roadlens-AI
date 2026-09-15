/**
 * Vehicle Dominant Color Detection using HSV Clustering.
 * Analyzes the central body region of a detected vehicle to extract
 * its primary automotive color (Red, White, Black, Blue, Silver, etc.).
 */

export interface VehicleColorResult {
  name: "Red" | "White" | "Black" | "Silver" | "Blue" | "Yellow" | "Green" | "Orange";
  hex: string;
  emoji: string;
  confidence: number;
}

/**
 * Converts RGB values (0-255) to HSV format.
 * H: 0-360, S: 0-100, V: 0-100
 */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const normR = r / 255;
  const normG = g / 255;
  const normB = b / 255;

  const max = Math.max(normR, normG, normB);
  const min = Math.min(normR, normG, normB);
  const diff = max - min;

  let h = 0;
  if (diff !== 0) {
    if (max === normR) {
      h = ((normG - normB) / diff) % 6;
    } else if (max === normG) {
      h = (normB - normR) / diff + 2;
    } else {
      h = (normR - normG) / diff + 4;
    }
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : Math.round((diff / max) * 100);
  const v = Math.round(max * 100);

  return [h, s, v];
}

/**
 * Classifies HSV coordinates into standard automotive color names and hex values.
 */
export function classifyHsv(h: number, s: number, v: number): Omit<VehicleColorResult, "confidence"> {
  // 1. Black / Very Dark
  if (v < 22) {
    return { name: "Black", hex: "#1e293b", emoji: "⚫" };
  }

  // 2. White / Very Light with low saturation
  if (v > 75 && s < 18) {
    return { name: "White", hex: "#f8fafc", emoji: "⚪" };
  }

  // 3. Gray / Silver (desaturated mid-tones)
  if (s < 20) {
    return { name: "Silver", hex: "#94a3b8", emoji: "🔘" };
  }

  // 4. Chromatic Hues
  if ((h >= 345 && h <= 360) || (h >= 0 && h <= 15)) {
    return { name: "Red", hex: "#dc2626", emoji: "🔴" };
  }
  if (h > 15 && h <= 45) {
    return { name: "Orange", hex: "#ea580c", emoji: "🟠" };
  }
  if (h > 45 && h <= 70) {
    return { name: "Yellow", hex: "#eab308", emoji: "🟡" };
  }
  if (h > 70 && h <= 165) {
    return { name: "Green", hex: "#16a34a", emoji: "🟢" };
  }
  if (h > 165 && h <= 265) {
    return { name: "Blue", hex: "#2563eb", emoji: "🔵" };
  }
  if (h > 265 && h < 345) {
    // Reddish-purple falls into Red for vehicle classifications
    return { name: "Red", hex: "#dc2626", emoji: "🔴" };
  }

  return { name: "Silver", hex: "#94a3b8", emoji: "🔘" };
}

/**
 * Analyzes pixel buffer to determine the most frequent vehicle body color.
 */
export function detectDominantColorFromPixels(data: Uint8ClampedArray): VehicleColorResult {
  const counts: Record<VehicleColorResult["name"], number> = {
    Red: 0,
    White: 0,
    Black: 0,
    Silver: 0,
    Blue: 0,
    Yellow: 0,
    Green: 0,
    Orange: 0,
  };

  let totalSampled = 0;
  // Step by 4 to sample every 4th pixel for speed while preserving accuracy
  for (let i = 0; i < data.length; i += 16) {
    const alpha = data[i + 3];
    if (alpha < 128) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const [h, s, v] = rgbToHsv(r, g, b);
    const classified = classifyHsv(h, s, v);
    counts[classified.name]++;
    totalSampled++;
  }

  if (totalSampled === 0) {
    return { name: "Silver", hex: "#94a3b8", emoji: "🔘", confidence: 0.5 };
  }

  let topColor: VehicleColorResult["name"] = "Silver";
  let maxCount = 0;

  for (const [colorName, count] of Object.entries(counts) as [VehicleColorResult["name"], number][]) {
    if (count > maxCount) {
      maxCount = count;
      topColor = colorName;
    }
  }

  const confidence = Math.min(1, Math.round((maxCount / totalSampled) * 100) / 100);
  const metadata = classifyHsv(
    topColor === "Red" ? 0 : topColor === "Blue" ? 210 : topColor === "Green" ? 120 : topColor === "Yellow" ? 60 : 0,
    topColor === "White" || topColor === "Black" || topColor === "Silver" ? 5 : 80,
    topColor === "Black" ? 10 : topColor === "White" ? 95 : 60,
  );

  return {
    name: topColor,
    hex: metadata.hex,
    emoji: metadata.emoji,
    confidence: Math.max(0.6, confidence),
  };
}

/**
 * Extracts the body crop from a video canvas and identifies the vehicle's dominant color.
 */
export function detectDominantColor(
  canvas: HTMLCanvasElement,
  bbox?: readonly [number, number, number, number] | null,
): VehicleColorResult {
  const width = canvas.width;
  const height = canvas.height;

  let x = 0;
  let y = 0;
  let w = width;
  let h = height;

  if (bbox) {
    let [bx, by, bw, bh] = bbox;
    // Normalize coordinates if needed
    if (bw <= 1 && bh <= 1) {
      bx = bx * width;
      by = by * height;
      bw = bw * width;
      bh = bh * height;
    }
    // Crop central body: 25% to 75% height (excludes windshield & tires), 15% to 85% width
    x = Math.max(0, Math.round(bx + bw * 0.15));
    y = Math.max(0, Math.round(by + bh * 0.25));
    w = Math.max(1, Math.min(width - x, Math.round(bw * 0.7)));
    h = Math.max(1, Math.min(height - y, Math.round(bh * 0.5)));
  }

  try {
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = Math.min(80, w);
    tempCanvas.height = Math.min(60, h);
    const ctx = tempCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return { name: "Silver", hex: "#94a3b8", emoji: "🔘", confidence: 0.5 };
    }

    ctx.drawImage(canvas, x, y, w, h, 0, 0, tempCanvas.width, tempCanvas.height);
    const imgData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    return detectDominantColorFromPixels(imgData.data);
  } catch {
    return { name: "Silver", hex: "#94a3b8", emoji: "🔘", confidence: 0.5 };
  }
}
