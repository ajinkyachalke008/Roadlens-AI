import { describe, it, expect, beforeEach } from "vitest";
import { HotlistService } from "../../frontend/src/hotlist/hotlistService";

describe("Real-Time BOLO Hotlist & Speed Alarms Engine", () => {
  let service: HotlistService;

  beforeEach(() => {
    service = new HotlistService();
    service.clearHits();
  });

  it("normalizes license plate strings accurately", () => {
    expect(service.normalizePlate("mh 12 ab 1234")).toBe("MH12AB1234");
    expect(service.normalizePlate("dl-01-ca-9999")).toBe("DL01CA9999");
    expect(service.normalizePlate("KA.05.MG.0001")).toBe("KA05MG0001");
  });

  it("matches exact plates and wildcard patterns", () => {
    expect(service.matchesPattern("MH 12 AB 1234", "MH12AB1234")).toBe(true);
    expect(service.matchesPattern("MH 12 AB 9999", "MH12*")).toBe(true);
    expect(service.matchesPattern("DL 01 CA 1234", "DL*")).toBe(true);
    expect(service.matchesPattern("KA 05 AB 1234", "*1234")).toBe(true);
    expect(service.matchesPattern("GJ 01 AB 5555", "MH*")).toBe(false);
  });

  it("detects stolen vehicle on watchlist and creates alert hit", () => {
    // Default watchlist includes MH12AB1234 as stolen
    const hit = service.checkObservation({
      trackId: 101,
      plateText: "MH 12 AB 1234",
      vehicleClass: "car",
      speedKmh: 45,
    });

    expect(hit).not.toBeNull();
    expect(hit?.category).toBe("stolen");
    expect(hit?.plateText).toBe("MH 12 AB 1234");
    expect(hit?.matchedReason).toContain("BOLO watchlist");
    expect(service.getHits().length).toBe(1);
  });

  it("triggers speed alarm when speed limit threshold is exceeded", () => {
    service.updateConfig({ speedAlarmKmh: 55, speedAlarmEnabled: true });

    const hit = service.checkObservation({
      trackId: 202,
      plateText: "GJ 01 XX 9999", // not on watchlist
      vehicleClass: "car",
      speedKmh: 68,
    });

    expect(hit).not.toBeNull();
    expect(hit?.category).toBe("speeding");
    expect(hit?.speedKmh).toBe(68);
    expect(hit?.matchedReason).toContain("exceeded alarm limit of 55 km/h");
  });

  it("enforces cooldown to prevent alert spam for the same target", () => {
    const firstHit = service.checkObservation({
      trackId: 301,
      plateText: "MH 12 AB 1234",
      vehicleClass: "car",
      speedKmh: 42,
    });
    expect(firstHit).not.toBeNull();

    // Immediate second sighting of the same plate
    const duplicateHit = service.checkObservation({
      trackId: 301,
      plateText: "MH 12 AB 1234",
      vehicleClass: "car",
      speedKmh: 44,
    });
    expect(duplicateHit).toBeNull(); // Cooldown suppresses spam
    expect(service.getHits().length).toBe(1);
  });

  it("allows operators to add and remove custom watchlist targets", () => {
    const entry = service.addWatchlistEntry("UP32AB0007", "wanted", "Wanted in Lucknow bank case");
    expect(entry.platePattern).toBe("UP32AB0007");
    expect(entry.category).toBe("wanted");

    const hit = service.checkObservation({
      trackId: 401,
      plateText: "UP 32 AB 0007",
      vehicleClass: "suv",
      speedKmh: 35,
    });
    expect(hit).not.toBeNull();
    expect(hit?.category).toBe("wanted");

    service.removeWatchlistEntry(entry.id);
    expect(service.getWatchlist().some((w) => w.id === entry.id)).toBe(false);
  });
});
