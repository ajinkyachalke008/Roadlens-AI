import { describe, expect, it } from "vitest";
import { AdaptivePerformance } from "../../frontend/src/camera/performance";
import {
  displaySpeed,
  speedFactor,
} from "../../frontend/src/components/speedUnits";
describe("measured capture adaptation", () => {
  it("does not downgrade on a single slow outlier or an incomplete window", () => {
    const p = new AdaptivePerformance(416);
    for (const ms of [900, 80, 80, 80, 80, 80, 80])
      expect(p.observe(ms)).toBe(false);
    expect(p.profile).toBe(416);
    expect(p.observe(80)).toBe(false);
    expect(p.profile).toBe(416);
    expect(p.intervalMs).toBe(190);
  });
  it("downgrades sustained slow416 once, then leaves measured idle time on320", () => {
    const p = new AdaptivePerformance(416);
    for (let i = 0; i < 7; i++) expect(p.observe(420)).toBe(false);
    expect(p.observe(420)).toBe(true);
    expect(p.profile).toBe(320);
    for (let i = 0; i < 8; i++) expect(p.observe(500)).toBe(false);
    expect(p.intervalMs).toBe(625);
    for (let i = 0; i < 8; i++) p.observe(60);
    expect(p.profile).toBe(320);
    expect(p.intervalMs).toBe(625);
  });
  it("bounds scheduling and ignores invalid timing measurements", () => {
    const p = new AdaptivePerformance(320);
    for (const ms of [NaN, Infinity, -1, 0]) p.observe(ms);
    expect(p.intervalMs).toBe(190);
    for (let i = 0; i < 8; i++) p.observe(10_000);
    expect(p.intervalMs).toBe(2000);
  });
  it("converts display units while preserving canonical m/s and null", () => {
    expect(displaySpeed(10, "km/h")).toBe("36.0 km/h");
    expect(displaySpeed(10, "mph")).toBe("22.4 mph");
    expect(36 / speedFactor("km/h")).toBe(10);
    expect(displaySpeed(null, "mph")).toBe("—");
  });
});
