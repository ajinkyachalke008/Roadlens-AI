import React, { useState, useEffect } from "react";
import {
  diagnostics,
  type SystemHealthSnapshot,
  type LogLevel,
} from "../diagnostics/diagnosticsService";
import { checkBackendHealth } from "../api/forensicsClient";

interface DiagnosticsDrawerProps {
  onClose: () => void;
}

export function DiagnosticsDrawer({ onClose }: DiagnosticsDrawerProps) {
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot>(() => diagnostics.getSnapshot());
  const [activeTab, setActiveTab] = useState<"all" | "error" | "warn" | "info">("all");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const unsubscribe = diagnostics.subscribe(() => {
      setSnapshot(diagnostics.getSnapshot());
    });
    return unsubscribe;
  }, []);

  const handleProbeAll = async () => {
    setProbing(true);
    diagnostics.log("system", "info", "Manual system-wide diagnostic probe triggered.");

    // Probe enterprise backend
    const startTime = performance.now();
    try {
      const isOnline = await checkBackendHealth();
      const rtt = Math.round(performance.now() - startTime);
      if (isOnline) {
        diagnostics.updateSubsystem("backend", {
          status: "healthy",
          summary: `Connected (${rtt}ms RTT)`,
          metrics: {
            Mode: "Enterprise PostGIS",
            "Probe Latency": `${rtt}ms`,
            Database: "PostgreSQL 16 + PostGIS",
          },
        });
        diagnostics.log("backend", "success", `Enterprise FastAPI backend probed successfully in ${rtt}ms.`);
      } else {
        diagnostics.updateSubsystem("backend", {
          status: "idle",
          summary: "Offline — Standalone Client Engine active",
          metrics: {
            Mode: "Client Local / IndexedDB",
            "Probe Latency": "Offline",
            Database: "Browser IndexedDB",
          },
        });
        diagnostics.log("backend", "info", "Enterprise backend is offline. Standalone live client fallback is running normally.");
      }
    } catch (err) {
      diagnostics.log("backend", "warn", `Backend probe error: ${String(err)}`);
    }

    setProbing(false);
  };

  const handleCopyReport = async () => {
    const report = diagnostics.exportReport();
    try {
      await navigator.clipboard.writeText(report);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      // Fallback
    }
  };

  const filteredLogs = snapshot.recentLogs.filter((log) => {
    if (activeTab === "all") return true;
    if (activeTab === "error") return log.level === "error";
    if (activeTab === "warn") return log.level === "warn";
    if (activeTab === "info") return log.level === "info" || log.level === "success";
    return true;
  });

  const formatUptime = (totalSeconds: number) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const errorCount = snapshot.recentLogs.filter((l) => l.level === "error").length;
  const warnCount = snapshot.recentLogs.filter((l) => l.level === "warn").length;

  return (
    <aside className="diagnostics-drawer" aria-label="System Health & Diagnostics Center">
      {/* Header */}
      <div className="diagnostics-header">
        <div className="diag-title-wrap">
          <span className="diag-icon">🛠️</span>
          <div>
            <h2>System Health & Diagnostics HUD</h2>
            <p className="diag-subtitle">
              Live operational telemetry, subsystem status, and runtime error logs
            </p>
          </div>
        </div>
        <button
          type="button"
          className="diag-close-btn"
          aria-label="Close Diagnostics"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="diagnostics-body">
        {/* Health Overview Banner */}
        <div className={`health-banner ${snapshot.overallStatus}`}>
          <div className="health-score-ring">
            <span className="score-num">{snapshot.healthScore}%</span>
            <span className="score-label">HEALTH</span>
          </div>
          <div className="health-banner-text">
            <div className="status-heading">
              <span className={`pulse-dot ${snapshot.overallStatus}`} />
              <h3>
                {snapshot.overallStatus === "healthy"
                  ? "ALL SYSTEMS OPERATIONAL"
                  : snapshot.overallStatus === "warning"
                  ? "SYSTEM RUNNING WITH WARNINGS"
                  : "SYSTEM ERROR DETECTED"}
              </h3>
            </div>
            <p>
              Uptime: <strong>{formatUptime(snapshot.uptimeSeconds)}</strong> • Logged:{" "}
              <strong>{errorCount} error{errorCount !== 1 ? "s" : ""}</strong>,{" "}
              <strong>{warnCount} warning{warnCount !== 1 ? "s" : ""}</strong>
            </p>
          </div>
          <div className="health-banner-actions">
            <button
              type="button"
              className="diag-action-btn probe"
              onClick={handleProbeAll}
              disabled={probing}
            >
              {probing ? "🔄 Probing..." : "🔄 Probe Now"}
            </button>
            <button
              type="button"
              className="diag-action-btn copy"
              onClick={handleCopyReport}
            >
              {copyFeedback ? "✓ Copied Report!" : "📋 Copy Report"}
            </button>
          </div>
        </div>

        {/* 6 Subsystem Health Cards Grid */}
        <div className="subsystems-grid-header">
          <span>CORE SUBSYSTEMS STATUS MATRIX</span>
        </div>
        <div className="subsystems-grid">
          {Object.entries(snapshot.subsystems).map(([key, sub]) => (
            <div key={key} className={`subsystem-card ${sub.status}`}>
              <div className="sub-card-head">
                <span className="sub-name">{sub.name}</span>
                <span className={`sub-status-pill ${sub.status}`}>
                  ● {sub.status.toUpperCase()}
                </span>
              </div>
              <div className="sub-summary">{sub.summary}</div>
              {sub.errorDetail && (
                <div className="sub-error-callout">
                  ⚠️ {sub.errorDetail}
                </div>
              )}
              <div className="sub-metrics-list">
                {Object.entries(sub.metrics).map(([metricLabel, metricVal]) => (
                  <div key={metricLabel} className="sub-metric-row">
                    <span className="m-label">{metricLabel}</span>
                    <span className="m-val">{String(metricVal)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Live Event & Error Log Stream */}
        <div className="logs-section">
          <div className="logs-header-bar">
            <div className="logs-title-wrap">
              <span>LIVE DIAGNOSTIC LOG STREAM</span>
              <span className="logs-counter">({filteredLogs.length} events)</span>
            </div>
            <div className="logs-filters">
              <button
                type="button"
                className={`filter-tab ${activeTab === "all" ? "active" : ""}`}
                onClick={() => setActiveTab("all")}
              >
                All ({snapshot.recentLogs.length})
              </button>
              <button
                type="button"
                className={`filter-tab error ${activeTab === "error" ? "active" : ""}`}
                onClick={() => setActiveTab("error")}
              >
                🔴 Errors ({errorCount})
              </button>
              <button
                type="button"
                className={`filter-tab warn ${activeTab === "warn" ? "active" : ""}`}
                onClick={() => setActiveTab("warn")}
              >
                🟡 Warnings ({warnCount})
              </button>
              <button
                type="button"
                className={`filter-tab info ${activeTab === "info" ? "active" : ""}`}
                onClick={() => setActiveTab("info")}
              >
                🟢 Info / OK
              </button>
              <button
                type="button"
                className="clear-logs-btn"
                onClick={() => diagnostics.clearLogs()}
                title="Clear Logs"
              >
                🗑️ Clear
              </button>
            </div>
          </div>

          <div className="logs-terminal">
            {filteredLogs.length === 0 ? (
              <div className="logs-empty">No events logged under this filter category.</div>
            ) : (
              filteredLogs.map((log) => (
                <div key={log.id} className={`log-row ${log.level}`}>
                  <span className="log-time">
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className={`log-level-badge ${log.level}`}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="log-subsystem">[{log.subsystem.toUpperCase()}]</span>
                  <span className="log-msg">{log.message}</span>
                  {log.detail && (
                    <span className="log-detail" title={log.detail}>
                      — {log.detail}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
