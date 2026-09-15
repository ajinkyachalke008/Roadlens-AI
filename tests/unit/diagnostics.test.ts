import { describe, it, expect, beforeEach } from "vitest";
import { diagnostics } from "../../frontend/src/diagnostics/diagnosticsService";

describe("diagnosticsService", () => {
  beforeEach(() => {
    diagnostics.clearLogs();
  });

  it("initializes with 6 core subsystems and healthy/idle statuses", () => {
    const snapshot = diagnostics.getSnapshot();
    expect(snapshot.subsystems.camera).toBeDefined();
    expect(snapshot.subsystems.vision).toBeDefined();
    expect(snapshot.subsystems.anpr).toBeDefined();
    expect(snapshot.subsystems.storage).toBeDefined();
    expect(snapshot.subsystems.backend).toBeDefined();
    expect(snapshot.subsystems.relay).toBeDefined();
  });

  it("logs events and updates recent logs", () => {
    diagnostics.log("camera", "info", "Testing info log");
    diagnostics.log("vision", "warn", "Inference latency high");

    const snapshot = diagnostics.getSnapshot();
    expect(snapshot.recentLogs.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.recentLogs[0].message).toBe("Inference latency high");
    expect(snapshot.recentLogs[0].level).toBe("warn");
  });

  it("downgrades health score and flags subsystem on error", () => {
    diagnostics.log("camera", "error", "Camera frame decode timeout");

    const snapshot = diagnostics.getSnapshot();
    expect(snapshot.overallStatus).toBe("error");
    expect(snapshot.healthScore).toBeLessThan(100);
    expect(snapshot.subsystems.camera.status).toBe("error");
    expect(snapshot.subsystems.camera.errorDetail).toBe("Camera frame decode timeout");
  });

  it("updates subsystem metrics dynamically", () => {
    diagnostics.updateSubsystem("camera", {
      status: "healthy",
      metrics: {
        Resolution: "1920x1080",
        FPS: 30,
      },
    });

    const snapshot = diagnostics.getSnapshot();
    expect(snapshot.subsystems.camera.metrics.Resolution).toBe("1920x1080");
    expect(snapshot.subsystems.camera.metrics.FPS).toBe(30);
  });

  it("exports a valid JSON diagnostic report", () => {
    diagnostics.log("anpr", "success", "Plate scanned successfully");
    const reportStr = diagnostics.exportReport();
    const parsed = JSON.parse(reportStr);

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.subsystems).toBeDefined();
    expect(parsed.recentLogs).toBeDefined();
    expect(Array.isArray(parsed.recentLogs)).toBe(true);
  });
});
