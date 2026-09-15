import { describe, it, expect } from "vitest";
import {
  rgbToHsv,
  classifyHsv,
  detectDominantColorFromPixels,
} from "../../frontend/src/vision/colorDetector";

describe("colorDetector", () => {
  it("converts pure RGB colors to HSV accurately", () => {
    // Pure Red (255, 0, 0) -> H: 0, S: 100, V: 100
    const [hr, sr, vr] = rgbToHsv(255, 0, 0);
    expect(hr).toBe(0);
    expect(sr).toBe(100);
    expect(vr).toBe(100);

    // Pure Green (0, 255, 0) -> H: 120, S: 100, V: 100
    const [hg, sg, vg] = rgbToHsv(0, 255, 0);
    expect(hg).toBe(120);
    expect(sg).toBe(100);
    expect(vg).toBe(100);

    // Pure Blue (0, 0, 255) -> H: 240, S: 100, V: 100
    const [hb, sb, vb] = rgbToHsv(0, 0, 255);
    expect(hb).toBe(240);
    expect(sb).toBe(100);
    expect(vb).toBe(100);

    // Pure White (255, 255, 255) -> S: 0, V: 100
    const [, sw, vw] = rgbToHsv(255, 255, 255);
    expect(sw).toBe(0);
    expect(vw).toBe(100);

    // Pure Black (0, 0, 0) -> V: 0
    const [, , vblk] = rgbToHsv(0, 0, 0);
    expect(vblk).toBe(0);
  });

  it("classifies automotive color spectrums correctly", () => {
    // Red hues
    expect(classifyHsv(0, 90, 80).name).toBe("Red");
    expect(classifyHsv(355, 90, 80).name).toBe("Red");

    // Blue hue
    expect(classifyHsv(210, 85, 90).name).toBe("Blue");

    // Yellow hue
    expect(classifyHsv(55, 90, 95).name).toBe("Yellow");

    // White: low saturation, high brightness
    expect(classifyHsv(0, 5, 95).name).toBe("White");

    // Black: very low brightness
    expect(classifyHsv(0, 0, 10).name).toBe("Black");

    // Silver / Gray: low saturation, mid brightness
    expect(classifyHsv(0, 10, 50).name).toBe("Silver");
  });

  it("extracts dominant color from synthetic pixel arrays", () => {
    // Create 100 pixels of bright red (220, 20, 20, 255)
    const redPixels = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < redPixels.length; i += 4) {
      redPixels[i] = 220;
      redPixels[i + 1] = 20;
      redPixels[i + 2] = 20;
      redPixels[i + 3] = 255;
    }

    const redResult = detectDominantColorFromPixels(redPixels);
    expect(redResult.name).toBe("Red");
    expect(redResult.confidence).toBeGreaterThanOrEqual(0.6);

    // Create 100 pixels of deep blue (20, 50, 210, 255)
    const bluePixels = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < bluePixels.length; i += 4) {
      bluePixels[i] = 20;
      bluePixels[i + 1] = 50;
      bluePixels[i + 2] = 210;
      bluePixels[i + 3] = 255;
    }

    const blueResult = detectDominantColorFromPixels(bluePixels);
    expect(blueResult.name).toBe("Blue");
    expect(blueResult.confidence).toBeGreaterThanOrEqual(0.6);
  });
});
