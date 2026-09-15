/**
 * Interactive Leaflet Map for Camera-Based Vehicle Sighting History.
 * Shows fixed CCTV sightings in chronological order.
 * Honest disclaimer: fixed camera sightings, not continuous GPS tracking.
 */

import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ForensicObservation } from "../../../shared/src/forensicTypes";

interface ForensicRouteMapProps {
  observations: ForensicObservation[];
  vehiclePlate?: string | null;
  className?: string;
}

export function ForensicRouteMap({ observations, vehiclePlate, className = "" }: ForensicRouteMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Clean up previous map if it exists
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    // Default center (Mumbai/Pune corridor or first observation)
    const firstCoord: [number, number] =
      observations.length > 0 && observations[0].location
        ? [observations[0].location.latitude, observations[0].location.longitude]
        : [19.076, 72.8777];

    const map = L.map(mapContainerRef.current, {
      center: firstCoord,
      zoom: 13,
      zoomControl: true,
    });

    // Dark-themed tile layer using CartoDB Dark Matter
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);

    mapInstanceRef.current = map;

    // Sort observations chronologically
    const sorted = [...observations].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const latLngs: [number, number][] = [];

    sorted.forEach((obs, index) => {
      const lat = obs.location?.latitude ?? 19.076 + index * 0.005;
      const lng = obs.location?.longitude ?? 72.8777 + index * 0.005;
      latLngs.push([lat, lng]);

      // Custom HTML Marker with sequence number
      const markerHtml = `
        <div class="forensic-map-marker ${obs.speed.isSpeeding ? "speeding" : ""}">
          <span class="marker-seq">${index + 1}</span>
        </div>
      `;

      const customIcon = L.divIcon({
        html: markerHtml,
        className: "custom-forensic-marker",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const formattedTime = new Date(obs.timestamp).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      const popupHtml = `
        <div class="forensic-marker-popup">
          <div class="popup-header">
            <strong>Camera Sighting #${index + 1}</strong>
            <span class="popup-time">${formattedTime}</span>
          </div>
          <div class="popup-cam">${obs.cameraName || obs.cameraId}</div>
          <div class="popup-details">
            <div>Speed: <strong>${obs.speed.kmh ?? "—"} km/h</strong></div>
            <div>Plate: <strong>${obs.plate.text ?? "Unscanned"}</strong></div>
            <div>Color: <span>${obs.color.name}</span></div>
          </div>
          ${
            obs.location?.landmark
              ? `<div class="popup-landmark">📍 ${obs.location.landmark}</div>`
              : ""
          }
        </div>
      `;

      L.marker([lat, lng], { icon: customIcon })
        .bindPopup(popupHtml)
        .addTo(map);
    });

    // Draw route polyline if 2 or more sightings
    if (latLngs.length > 1) {
      const polyline = L.polyline(latLngs, {
        color: "#10b981",
        weight: 3,
        opacity: 0.85,
        dashArray: "6, 8",
      }).addTo(map);

      map.fitBounds(polyline.getBounds(), { padding: [40, 40] });
    } else if (latLngs.length === 1) {
      map.setView(latLngs[0], 15);
    }

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [observations]);

  return (
    <div className={`forensic-route-map-wrapper ${className}`}>
      <div className="map-meta-bar">
        <span className="map-badge">📍 CCTV CAMERA OBSERVATION ROUTE</span>
        <span className="map-disclaimer">
          Interpolated between fixed CCTV network locations • Not real-time continuous GPS
        </span>
      </div>
      <div ref={mapContainerRef} className="forensic-leaflet-canvas" style={{ height: "340px", width: "100%" }} />
    </div>
  );
}
