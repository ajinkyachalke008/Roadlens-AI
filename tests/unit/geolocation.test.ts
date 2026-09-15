import { describe, expect, it, vi } from "vitest";
import {
  formatCoordinatesDms,
  getMapUrl,
  resolveIndianHighwayLandmark,
  getCurrentGeoLocation,
  stampForensicEvidenceWatermark,
  DEFAULT_INDIAN_LOCATIONS,
} from "../../frontend/src/geo/geolocationService";

describe("Live GPS Geotagging & Forensic Evidence Service", () => {
  it("formats decimal degrees to Degree-Minute-Second (DMS) representation", () => {
    // Mumbai-Pune Expressway: 18.7562° N, 73.4078° E
    const dms = formatCoordinatesDms(18.7562, 73.4078);
    expect(dms).toContain("18°45'");
    expect(dms).toContain("N");
    expect(dms).toContain("73°24'");
    expect(dms).toContain("E");

    // Southern/Western Hemisphere test
    const southern = formatCoordinatesDms(-33.8688, -151.2093);
    expect(southern).toContain("33°52'");
    expect(southern).toContain("S");
    expect(southern).toContain("151°12'");
    expect(southern).toContain("W");
  });

  it("builds valid map verification URL", () => {
    const url = getMapUrl(18.7562, 73.4078);
    expect(url).toBe("https://www.google.com/maps?q=18.756200,73.407800");
  });

  it("resolves Indian highway landmarks from coordinates", () => {
    // Maharashtra NH-48 corridor
    const mhLandmark = resolveIndianHighwayLandmark(18.7562, 73.4078);
    expect(mhLandmark).toContain("Mumbai - Pune");
    expect(mhLandmark).toContain("Maharashtra");

    // Delhi NCR ring network
    const ncrLandmark = resolveIndianHighwayLandmark(28.6924, 77.1428);
    expect(ncrLandmark).toContain("Capital Region");

    // Bengaluru corridor
    const blrLandmark = resolveIndianHighwayLandmark(12.8524, 77.6625);
    expect(blrLandmark).toContain("Bengaluru");
  });

  it("provides verified default Indian highway fallback locations", () => {
    expect(DEFAULT_INDIAN_LOCATIONS.pune_expressway.lat).toBeCloseTo(18.7562);
    expect(DEFAULT_INDIAN_LOCATIONS.mumbai_sealink.landmark).toContain("Bandra - Worli");
  });

  it("fetches geolocation with navigator fallback if permission denied or unavailable", async () => {
    const originalNavigator = globalThis.navigator;

    Object.defineProperty(globalThis, "navigator", {
      value: {
        geolocation: {
          getCurrentPosition: vi.fn((_success, error) => {
            error({ code: 1, message: "User denied Geolocation" });
          }),
        },
      } as unknown as Navigator,
      configurable: true,
      writable: true,
    });

    const location = await getCurrentGeoLocation();
    expect(location).toBeDefined();
    expect(location.coordinates.latitude).toBeCloseTo(18.7562);
    expect(location.formattedDms).toContain("18°45'");
    expect(location.landmark).toContain("Mumbai - Pune");

    // Restore navigator
    globalThis.navigator = originalNavigator;
  });

  it("stamps forensic watermark telemetry onto canvas", () => {
    // Create mock HTML5 Canvas context
    const fillRectMock = vi.fn();
    const fillTextMock = vi.fn();

    const mockCanvas = {
      width: 1280,
      height: 720,
      getContext: vi.fn(() => ({
        save: vi.fn(),
        restore: vi.fn(),
        fillRect: fillRectMock,
        fillText: fillTextMock,
        font: "",
        fillStyle: "",
        textAlign: "",
        textBaseline: "",
      })),
    } as unknown as HTMLCanvasElement;

    stampForensicEvidenceWatermark(mockCanvas, {
      lat: 18.7562,
      lng: 73.4078,
      accuracyM: 4,
      landmark: "NH-48 Mumbai - Pune Highway Corridor",
      speedKmh: 72,
      plateNumber: "MH 12 AB 1234",
      timestampIso: "2026-09-15T09:30:00.000Z",
    });

    expect(mockCanvas.getContext).toHaveBeenCalledWith("2d");
    expect(fillRectMock).toHaveBeenCalled();
    expect(fillTextMock).toHaveBeenCalled();

    // Verify telemetry strings drawn
    const drawnTexts = fillTextMock.mock.calls.map((call) => call[0]);
    const leftText = drawnTexts.find((t) => typeof t === "string" && t.includes("📍"));
    expect(leftText).toBeDefined();
    expect(leftText).toContain("18°45'");
    expect(leftText).toContain("±4m");

    const rightText = drawnTexts.find((t) => typeof t === "string" && t.includes("72 km/h"));
    expect(rightText).toBeDefined();
    expect(rightText).toContain("MH 12 AB 1234");
  });
});
