/**
 * Central Diagnostics and System Health Monitoring Service.
 * Tracks live telemetry, errors, warnings, and performance across all 6 core subsystems.
 */

export type SubsystemStatus = "healthy" | "warning" | "error" | "offline" | "idle";

export type LogLevel = "info" | "warn" | "error" | "success";

export interface DiagnosticLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  subsystem: "camera" | "vision" | "anpr" | "storage" | "backend" | "relay" | "system";
  message: string;
  detail?: string;
}

export interface SubsystemMetrics {
  name: string;
  subsystem: "camera" | "vision" | "anpr" | "storage" | "backend" | "relay";
  status: SubsystemStatus;
  summary: string;
  metrics: Record<string, string | number>;
  lastUpdated: string;
  errorDetail?: string;
}

export interface SystemHealthSnapshot {
  overallStatus: SubsystemStatus;
  healthScore: number; // 0-100%
  subsystems: Record<string, SubsystemMetrics>;
  recentLogs: DiagnosticLogEntry[];
  uptimeSeconds: number;
}

const MAX_LOG_ENTRIES = 200;
const appStartTime = Date.now();

class DiagnosticsManager {
  private logs: DiagnosticLogEntry[] = [];
  private listeners: Set<() => void> = new Set();
  private subsystems: Record<string, SubsystemMetrics> = {
    camera: {
      name: "Camera & Video Capture",
      subsystem: "camera",
      status: "idle",
      summary: "Camera waiting to start",
      metrics: {
        Resolution: "Inactive",
        FPS: 0,
        "Dropped Frames": 0,
        "Source Device": "None",
      },
      lastUpdated: new Date().toISOString(),
    },
    vision: {
      name: "AI Vision (ONNX YOLO)",
      subsystem: "vision",
      status: "healthy",
      summary: "ONNX Runtime Web ready",
      metrics: {
        Engine: "WASM SIMD",
        "Inference Latency": "—",
        Model: "YOLO26n FP32",
        "Active Tracks": 0,
      },
      lastUpdated: new Date().toISOString(),
    },
    anpr: {
      name: "Indian ANPR & OCR Engine",
      subsystem: "anpr",
      status: "healthy",
      summary: "Tesseract.js & MoRTH parser ready",
      metrics: {
        "Auto-Scan": "Enabled",
        "Captured Plates": 0,
        "Avg OCR Confidence": "—",
        "Last Plate": "None",
      },
      lastUpdated: new Date().toISOString(),
    },
    storage: {
      name: "Persistent Storage (IndexedDB)",
      subsystem: "storage",
      status: "healthy",
      summary: "IndexedDB connected",
      metrics: {
        Database: "roadlens-live-forensics",
        "Saved Observations": 0,
        Storage: "Persistent",
      },
      lastUpdated: new Date().toISOString(),
    },
    backend: {
      name: "Enterprise Backend (FastAPI)",
      subsystem: "backend",
      status: "idle",
      summary: "Checking connection...",
      metrics: {
        Mode: "Client Fallback",
        "Probe Latency": "—",
        Database: "PostgreSQL/PostGIS",
      },
      lastUpdated: new Date().toISOString(),
    },
    relay: {
      name: "WebRTC & Relay Signaling",
      subsystem: "relay",
      status: "healthy",
      summary: "Local standalone mode",
      metrics: {
        Signaling: "Local only",
        "Viewers Connected": 0,
        Room: "None",
      },
      lastUpdated: new Date().toISOString(),
    },
  };

  constructor() {
    // Intercept window global errors to capture unhandled exceptions
    if (typeof window !== "undefined") {
      window.addEventListener("error", (event) => {
        this.log("system", "error", `Uncaught Exception: ${event.message}`, event.filename ? `${event.filename}:${event.lineno}` : undefined);
      });
      window.addEventListener("unhandledrejection", (event) => {
        this.log("system", "error", `Unhandled Promise Rejection: ${event.reason}`, String(event.reason?.stack ?? ""));
      });
    }

    this.log("system", "info", "RoadLens System Diagnostics initialized successfully.");
  }

  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public log(
    subsystem: DiagnosticLogEntry["subsystem"],
    level: LogLevel,
    message: string,
    detail?: string,
  ): void {
    const entry: DiagnosticLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      level,
      subsystem,
      message,
      detail,
    };

    this.logs.unshift(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.pop();
    }

    // Auto-update subsystem status if error or warning occurs
    if (subsystem in this.subsystems) {
      const current = this.subsystems[subsystem];
      if (level === "error") {
        current.status = "error";
        current.errorDetail = message;
        current.summary = `Error: ${message}`;
      } else if (level === "warn" && current.status !== "error") {
        current.status = "warning";
      }
      current.lastUpdated = new Date().toISOString();
    }

    this.notify();
  }

  public updateSubsystem(
    subsystem: keyof typeof this.subsystems,
    update: Partial<SubsystemMetrics>,
  ): void {
    if (!this.subsystems[subsystem]) return;

    this.subsystems[subsystem] = {
      ...this.subsystems[subsystem],
      ...update,
      metrics: {
        ...this.subsystems[subsystem].metrics,
        ...(update.metrics || {}),
      },
      lastUpdated: new Date().toISOString(),
    };

    this.notify();
  }

  public getSnapshot(): SystemHealthSnapshot {
    const subs = Object.values(this.subsystems);
    const hasError = subs.some((s) => s.status === "error");
    const hasWarning = subs.some((s) => s.status === "warning");

    let overallStatus: SubsystemStatus = "healthy";
    let healthScore = 100;

    if (hasError) {
      overallStatus = "error";
      healthScore = 50;
    } else if (hasWarning) {
      overallStatus = "warning";
      healthScore = 85;
    }

    const uptimeSeconds = Math.round((Date.now() - appStartTime) / 1000);

    return {
      overallStatus,
      healthScore,
      subsystems: { ...this.subsystems },
      recentLogs: [...this.logs],
      uptimeSeconds,
    };
  }

  public clearLogs(): void {
    this.logs = [];
    this.notify();
  }

  public exportReport(): string {
    const snapshot = this.getSnapshot();
    return JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "Unknown",
        uptimeSeconds: snapshot.uptimeSeconds,
        overallStatus: snapshot.overallStatus,
        healthScore: `${snapshot.healthScore}%`,
        subsystems: snapshot.subsystems,
        recentLogs: snapshot.recentLogs.slice(0, 50),
      },
      null,
      2,
    );
  }
}

export const diagnostics = new DiagnosticsManager();
