/**
 * Full Vehicle Forensic Intelligence Dossier Page.
 * Displays vehicle sighting timeline, speed profile, MoRTH registration status,
 * violations history, and camera-based GIS route map.
 */

import React, { useEffect, useState } from "react";
import type { ForensicObservation } from "../../../shared/src/forensicTypes";
import { fetchVehicleRoute } from "../api/forensicsClient";
import { ForensicRouteMap } from "../components/ForensicRouteMap";
import { INDIAN_STATES } from "../../../shared/src/indianPlates";

interface VehicleForensicPageProps {
  vehicleId?: string;
  onBack: () => void;
  onIssueChallan?: (obs: ForensicObservation) => void;
}

export function VehicleForensicPage({ vehicleId, onBack, onIssueChallan }: VehicleForensicPageProps) {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<ForensicObservation[]>([]);

  useEffect(() => {
    if (!vehicleId) return;
    setLoading(true);
    fetchVehicleRoute(vehicleId)
      .then((records) => {
        setHistory(records);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [vehicleId]);

  if (loading) {
    return (
      <div className="forensic-page-loading">
        <div className="spinner" />
        <p>Loading vehicle forensic intelligence...</p>
      </div>
    );
  }

  const latest = history[0];
  const plateText = latest?.plate.text ?? vehicleId ?? "UNKNOWN";
  const stateCode = latest?.plate.stateCode ?? (plateText.length >= 2 ? plateText.slice(0, 2).toUpperCase() : null);
  const stateName = stateCode && INDIAN_STATES[stateCode] ? INDIAN_STATES[stateCode] : "Indian Union Territory / State";

  const allSpeeds = history.map((h) => h.speed.kmh).filter((s): s is number => s != null);
  const maxSpeed = allSpeeds.length > 0 ? Math.max(...allSpeeds) : (latest?.speed.kmh ?? 0);
  const avgSpeed = allSpeeds.length > 0 ? Math.round(allSpeeds.reduce((a, b) => a + b, 0) / allSpeeds.length) : (latest?.speed.kmh ?? 0);

  const allViolations = Array.from(new Set(history.flatMap((h) => h.violations)));

  return (
    <div className="forensic-dossier-page">
      {/* Header bar */}
      <div className="dossier-nav-header">
        <button className="back-btn" onClick={onBack}>
          ← Back to Camera
        </button>
        <div className="dossier-title-group">
          <span className="eyebrow">FORENSIC INTELLIGENCE DOSSIER</span>
          <h1>Vehicle: {plateText}</h1>
        </div>
        <div className="dossier-actions">
          <a
            href="https://echallan.parivahan.gov.in/index/accused-challan"
            target="_blank"
            rel="noopener noreferrer"
            className="parivahan-btn"
          >
            🏛️ Official Parivahan Portal
          </a>
          {latest && onIssueChallan && (
            <button className="issue-btn" onClick={() => onIssueChallan(latest)}>
              📋 Generate e-Challan Notice
            </button>
          )}
        </div>
      </div>

      {/* Main Grid */}
      <div className="dossier-grid">
        {/* Left Column: Core Attributes */}
        <div className="dossier-left-col">
          {/* Plate Card */}
          <div className="dossier-card plate-dossier-card">
            <span className="card-label">REGISTRATION PLATE</span>
            <div className="plate-hsrp-display">
              <div className="hsrp-strip">
                <span className="ind-text">IND</span>
              </div>
              <span className="hsrp-number">{plateText}</span>
            </div>
            <div className="plate-sub-details">
              <span className="rto-state">📍 {stateName}</span>
              {latest?.plate.rtoLocation && <span className="rto-loc">RTO: {latest.plate.rtoLocation}</span>}
              <span className="plate-conf">
                OCR Confidence: {Math.round((latest?.plate.confidence ?? 0.9) * 100)}%
              </span>
            </div>
          </div>

          {/* Vehicle Profile Card */}
          <div className="dossier-card">
            <span className="card-label">VEHICLE CLASSIFICATION & COLOR</span>
            <div className="attribute-row">
              <span className="attr-title">Category</span>
              <strong className="attr-val uppercase">{latest?.vehicleClass ?? "Vehicle"}</strong>
            </div>
            <div className="attribute-row">
              <span className="attr-title">Body Color</span>
              <div className="color-val-group">
                <span
                  className="color-swatch-circle"
                  style={{ backgroundColor: latest?.color.hex ?? "#94a3b8" }}
                />
                <strong>{latest?.color.name ?? "Silver"}</strong>
                <span className="color-conf-tag">
                  ({Math.round((latest?.color.confidence ?? 0.8) * 100)}% confidence)
                </span>
              </div>
            </div>
            <div className="attribute-row">
              <span className="attr-title">Total Sightings</span>
              <strong>{history.length} observation{history.length !== 1 ? "s" : ""}</strong>
            </div>
            <div className="attribute-row">
              <span className="attr-title">First Observed</span>
              <span>
                {history.length > 0
                  ? new Date(history[history.length - 1].timestamp).toLocaleString("en-IN")
                  : "—"}
              </span>
            </div>
            <div className="attribute-row">
              <span className="attr-title">Last Observed</span>
              <span>
                {latest ? new Date(latest.timestamp).toLocaleString("en-IN") : "—"}
              </span>
            </div>
          </div>

          {/* Speed & Safety Stats */}
          <div className="dossier-card">
            <span className="card-label">SPEED & VIOLATIONS PROFILE</span>
            <div className="speed-stat-boxes">
              <div className="speed-box">
                <span className="box-val">{maxSpeed}</span>
                <span className="box-unit">km/h Peak</span>
              </div>
              <div className="speed-box">
                <span className="box-val">{avgSpeed}</span>
                <span className="box-unit">km/h Avg</span>
              </div>
            </div>
            <div className="violations-tag-list">
              {allViolations.length > 0 ? (
                allViolations.map((v) => (
                  <span key={v} className="violation-chip warning">
                    ⚠️ {v}
                  </span>
                ))
              ) : (
                <span className="violation-chip clean">✅ No Safety Violations Flagged</span>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Route Map & Sightings Timeline */}
        <div className="dossier-right-col">
          {/* Leaflet Route Map */}
          <div className="dossier-card map-card">
            <span className="card-label">CAMERA SIGHTING TRAJECTORY</span>
            <ForensicRouteMap observations={history} vehiclePlate={plateText} />
          </div>

          {/* Chronological Sightings Timeline */}
          <div className="dossier-card timeline-card">
            <span className="card-label">CHRONOLOGICAL SIGHTING LOG</span>
            <div className="timeline-items">
              {history.map((obs, idx) => (
                <div key={obs.id} className="timeline-item">
                  <div className="timeline-seq">{history.length - idx}</div>
                  <div className="timeline-content">
                    <div className="timeline-head">
                      <strong>{obs.cameraName || obs.cameraId}</strong>
                      <span className="timeline-time">
                        {new Date(obs.timestamp).toLocaleTimeString("en-IN")}
                      </span>
                    </div>
                    <div className="timeline-meta">
                      <span>Speed: {obs.speed.kmh ?? "—"} km/h</span>
                      {obs.location?.landmark && <span>• {obs.location.landmark}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
