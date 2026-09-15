/**
 * Hybrid Forensic API Client.
 * Queries Enterprise FastAPI + PostgreSQL/PostGIS backend when online,
 * and automatically falls back to local IndexedDB + Client NLP Engine when offline or on Vercel.
 */

import type {
  ForensicObservation,
  ForensicSearchResponse,
  TrafficQuery,
} from "../../../shared/src/forensicTypes";
import { getAllObservations, saveObservation, getVehicleHistory } from "../session/forensicDb";
import { executeTrafficQuery } from "../ai/trafficQueryEngine";

const BACKEND_BASE_URL = (import.meta.env.VITE_FORENSICS_API_URL as string) || "http://localhost:8000";

let backendAvailable: boolean | null = null;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds

/**
 * Probes the enterprise backend health endpoint.
 */
export async function checkBackendHealth(): Promise<boolean> {
  const now = Date.now();
  if (backendAvailable !== null && now - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) {
    return backendAvailable;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500); // Fast 1.5s probe

    const res = await fetch(`${BACKEND_BASE_URL}/api/forensics/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    backendAvailable = res.ok;
    lastHealthCheck = now;
    return backendAvailable;
  } catch {
    backendAvailable = false;
    lastHealthCheck = now;
    return false;
  }
}

/**
 * Searches forensic vehicle records using natural language.
 */
export async function searchForensics(
  query: string,
  liveRecordsFallback: ForensicObservation[] = [],
): Promise<ForensicSearchResponse> {
  const isOnline = await checkBackendHealth();

  if (isOnline) {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/forensics/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (res.ok) {
        const data = (await res.json()) as ForensicSearchResponse;
        return {
          ...data,
          engine: "enterprise_postgis",
        };
      }
    } catch (err) {
      console.warn("Enterprise search failed, falling back to live client engine:", err);
    }
  }

  // Fallback: Combine stored IndexedDB observations with active live memory records
  const dbRecords = await getAllObservations();
  const map = new Map<string, ForensicObservation>();

  for (const r of liveRecordsFallback) {
    map.set(r.id, r);
  }
  for (const r of dbRecords) {
    if (!map.has(r.id)) {
      map.set(r.id, r);
    }
  }

  const combined = Array.from(map.values());
  const response = executeTrafficQuery(query, combined);
  return {
    ...response,
    engine: "live_client",
  };
}

/**
 * Ingests a new real vehicle observation.
 */
export async function ingestObservation(obs: ForensicObservation): Promise<void> {
  // Always persist locally in browser IndexedDB
  await saveObservation(obs);

  // Ingest into enterprise backend if available
  const isOnline = await checkBackendHealth();
  if (isOnline) {
    try {
      await fetch(`${BACKEND_BASE_URL}/api/forensics/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obs),
      });
    } catch {
      // Background sync failure is non-fatal
    }
  }
}

/**
 * Fetches vehicle sighting route history for Leaflet map playback.
 */
export async function fetchVehicleRoute(plateOrId: string): Promise<ForensicObservation[]> {
  const isOnline = await checkBackendHealth();

  if (isOnline) {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/forensics/vehicle/${encodeURIComponent(plateOrId)}/route`);
      if (res.ok) {
        return (await res.json()) as ForensicObservation[];
      }
    } catch {
      // Fallback
    }
  }

  return getVehicleHistory(plateOrId);
}
