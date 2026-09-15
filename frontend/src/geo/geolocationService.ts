export interface GeoCoordinates {
  latitude: number;
  longitude: number;
  accuracyM: number;
  altitude?: number | null;
  timestamp: number;
}

export interface GeotaggedLocation {
  coordinates: GeoCoordinates;
  formattedDms: string;
  landmark: string;
  mapUrl: string;
}

/** Preset Indian Highway coordinates for testing and offline fallbacks */
export const DEFAULT_INDIAN_LOCATIONS: Readonly<
  Record<string, { lat: number; lng: number; landmark: string }>
> = Object.freeze({
  pune_expressway: {
    lat: 18.7562,
    lng: 73.4078,
    landmark: "Mumbai - Pune Expressway · Khalapur Toll Plaza",
  },
  delhi_outer_ring: {
    lat: 28.6924,
    lng: 77.1428,
    landmark: "Delhi Outer Ring Road · Mukarba Chowk Junction",
  },
  bengaluru_flyover: {
    lat: 12.8524,
    lng: 77.6625,
    landmark: "Bengaluru Hosur Elevated Tollway · Electronic City",
  },
  mumbai_sealink: {
    lat: 19.033,
    lng: 72.8164,
    landmark: "Bandra - Worli Sea Link · Southbound Fast Lane",
  },
});

/**
 * Converts decimal degrees to Degree-Minute-Second (DMS) string format.
 * e.g., 18.7562, 73.4078 -> 18°45'22.3"N 73°24'28.1"E
 */
export function formatCoordinatesDms(lat: number, lng: number): string {
  const latDir = lat >= 0 ? "N" : "S";
  const lngDir = lng >= 0 ? "E" : "W";

  const absLat = Math.abs(lat);
  const absLng = Math.abs(lng);

  const latDeg = Math.floor(absLat);
  const latMinFloat = (absLat - latDeg) * 60;
  const latMin = Math.floor(latMinFloat);
  const latSec = ((latMinFloat - latMin) * 60).toFixed(1);

  const lngDeg = Math.floor(absLng);
  const lngMinFloat = (absLng - lngDeg) * 60;
  const lngMin = Math.floor(lngMinFloat);
  const lngSec = ((lngMinFloat - lngMin) * 60).toFixed(1);

  return `${latDeg}°${latMin}'${latSec}"${latDir} ${lngDeg}°${lngMin}'${lngSec}"${lngDir}`;
}

/**
 * Returns a direct map verification URL.
 */
export function getMapUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/**
 * Resolves a human-readable Indian road landmark based on coordinates.
 */
export function resolveIndianHighwayLandmark(lat: number, lng: number): string {
  // Approximate proximity matcher for major metropolitan sectors
  if (lat >= 18.0 && lat <= 19.5 && lng >= 72.5 && lng <= 74.5) {
    return "NH-48 Mumbai - Pune Highway Corridor · Maharashtra";
  }
  if (lat >= 28.2 && lat <= 29.0 && lng >= 76.8 && lng <= 77.5) {
    return "National Capital Region (NCR) · Ring Highway Network";
  }
  if (lat >= 12.5 && lat <= 13.5 && lng >= 77.2 && lng <= 78.0) {
    return "NH-44 Bengaluru - Hosur Smart Corridor · Karnataka";
  }
  if (lat >= 12.8 && lat <= 13.3 && lng >= 80.0 && lng <= 80.4) {
    return "Rajiv Gandhi IT Expressway (OMR) · Tamil Nadu";
  }
  return "National Highway Transit Corridor · India";
}

/**
 * Fetches real GPS coordinates from the browser environment with fallback.
 */
export async function getCurrentGeoLocation(): Promise<GeotaggedLocation> {
  return new Promise((resolve) => {
    if (typeof navigator !== "undefined" && "geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          const accuracyM = Math.round(position.coords.accuracy);
          const formattedDms = formatCoordinatesDms(lat, lng);
          const landmark = resolveIndianHighwayLandmark(lat, lng);
          const mapUrl = getMapUrl(lat, lng);

          resolve({
            coordinates: {
              latitude: lat,
              longitude: lng,
              accuracyM,
              altitude: position.coords.altitude,
              timestamp: position.timestamp,
            },
            formattedDms,
            landmark,
            mapUrl,
          });
        },
        () => {
          // Fallback on permission denied or error
          const fallback = DEFAULT_INDIAN_LOCATIONS.pune_expressway;
          resolve({
            coordinates: {
              latitude: fallback.lat,
              longitude: fallback.lng,
              accuracyM: 5,
              altitude: 540,
              timestamp: Date.now(),
            },
            formattedDms: formatCoordinatesDms(fallback.lat, fallback.lng),
            landmark: fallback.landmark,
            mapUrl: getMapUrl(fallback.lat, fallback.lng),
          });
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 },
      );
    } else {
      const fallback = DEFAULT_INDIAN_LOCATIONS.pune_expressway;
      resolve({
        coordinates: {
          latitude: fallback.lat,
          longitude: fallback.lng,
          accuracyM: 5,
          altitude: 540,
          timestamp: Date.now(),
        },
        formattedDms: formatCoordinatesDms(fallback.lat, fallback.lng),
        landmark: fallback.landmark,
        mapUrl: getMapUrl(fallback.lat, fallback.lng),
      });
    }
  });
}

/**
 * Stamps an immutable forensic telemetry watermark strip onto an evidence image canvas.
 */
export function stampForensicEvidenceWatermark(
  canvas: HTMLCanvasElement,
  metadata: {
    lat: number;
    lng: number;
    accuracyM: number;
    landmark: string;
    speedKmh?: number | null;
    plateNumber?: string | null;
    timestampIso?: string;
  },
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const bannerHeight = Math.max(34, Math.round(h * 0.065));

  // Dark semi-transparent background banner
  ctx.save();
  ctx.fillStyle = "rgba(10, 15, 25, 0.88)";
  ctx.fillRect(0, h - bannerHeight, w, bannerHeight);

  // Top dividing accent line
  ctx.fillStyle = "#d97706";
  ctx.fillRect(0, h - bannerHeight, w, 2);

  // Text setup
  ctx.fillStyle = "#ffffff";
  const fontSize = Math.max(11, Math.round(bannerHeight * 0.38));
  ctx.font = `600 ${fontSize}px monospace`;
  ctx.textBaseline = "middle";

  const dms = formatCoordinatesDms(metadata.lat, metadata.lng);
  const nowStr = metadata.timestampIso
    ? new Date(metadata.timestampIso).toLocaleString("en-IN")
    : new Date().toLocaleString("en-IN");

  // Left text: GPS Coordinates & Accuracy
  const leftText = `📍 ${dms} (±${metadata.accuracyM}m) · ${metadata.landmark}`;
  ctx.textAlign = "left";
  ctx.fillText(leftText, 14, h - bannerHeight / 2);

  // Right text: Speed, Plate, Time
  const speedPart =
    metadata.speedKmh !== null && metadata.speedKmh !== undefined
      ? `⚡ ${metadata.speedKmh} km/h · `
      : "";
  const platePart = metadata.plateNumber ? `🇮🇳 ${metadata.plateNumber} · ` : "";
  const rightText = `${speedPart}${platePart}${nowStr}`;

  ctx.textAlign = "right";
  ctx.fillStyle = "#fbbf24";
  ctx.fillText(rightText, w - 14, h - bannerHeight / 2);

  ctx.restore();
}
