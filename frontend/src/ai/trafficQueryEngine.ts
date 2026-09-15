/**
 * Traffic Natural Language Query Engine & Forensic Search Assistant.
 * Parses plain-English queries into a structured TrafficQuery AST
 * and evaluates them over real vehicle observations with conversational responses.
 */

import type {
  TrafficQuery,
  ForensicObservation,
  ForensicSearchResponse,
  VehicleColorName,
  VehicleCategory,
  AmbiguityClarification,
} from "../../../shared/src/forensicTypes";
import { normalizeQueryText, COLOR_SYNONYMS, CLASS_SYNONYMS } from "./queryNormalization";
import { parseSpeedCondition } from "./speedParser";
import { parsePlateCondition } from "./plateParser";
import { parseTimeCondition } from "./timeParser";

export type {
  TrafficQuery,
  ForensicObservation,
  ForensicSearchResponse,
  VehicleColorName,
  VehicleCategory,
  AmbiguityClarification,
};

/**
 * Backward-compatible VehicleRecord adapter for existing live camera session records.
 */
export interface VehicleRecord {
  id: string;
  reportId?: string;
  trackId?: number | null;
  className: string;
  color: { name: VehicleColorName; hex: string; emoji: string; confidence: number };
  plateText?: string | null;
  rtoLocation?: string | null;
  stateName?: string | null;
  speedMps?: number | null;
  speedKmh?: number | null;
  isSpeeding?: boolean;
  violations?: string[];
  timestamp: string;
  sourceMode?: string;
  thumbnailUrl?: string | null;
  thumbnailBlob?: Blob | null;
  location?: { latitude: number; longitude: number; landmark?: string };
}

/**
 * Detects ambiguity in user query and generates clarification suggestions.
 */
export function detectAmbiguity(rawQuery: string, normalized: string): AmbiguityClarification | undefined {
  // 1. "dangerous vehicles" or "reckless vehicles"
  if (/\b(dangerous|reckless|unsafe|risky)\b/i.test(normalized)) {
    return {
      isAmbiguous: true,
      reason: "Query asks for 'dangerous' vehicles. Would you like to filter by speed or safety violation?",
      options: [
        { label: "⚡ Speeding over 60 km/h", query: "Vehicles speeding above 60 km/h" },
        { label: "🪖 No Helmet Violations", query: "Two-wheelers without helmet" },
        { label: "👥 Triple Riding", query: "Two-wheelers with triple riding" },
      ],
    };
  }

  // 2. "fast vehicles" without specific threshold
  if (/\b(fast|high speed|speeding)\b/i.test(normalized) && !/\d+/.test(normalized)) {
    return {
      isAmbiguous: true,
      reason: "Specify speed threshold for accurate filtering:",
      options: [
        { label: "Over 50 km/h (City Limit)", query: "Vehicles speeding over 50 km/h" },
        { label: "Over 80 km/h (Highway Limit)", query: "Vehicles speeding over 80 km/h" },
        { label: "Top 5 Fastest", query: "The fastest vehicles today" },
      ],
    };
  }

  return undefined;
}

/**
 * Parses a natural language sentence into a structured TrafficQuery AST.
 */
export function parseTrafficQuery(rawQuery: string): TrafficQuery {
  const normalized = normalizeQueryText(rawQuery);

  // 1. Detect Intent
  let intent: TrafficQuery["intent"] = "search";
  if (/\b(how many|count|total number of)\b/i.test(normalized)) {
    intent = "count";
  } else if (/\b(last seen|where is|where was|current location)\b/i.test(normalized)) {
    intent = "last_seen";
  } else if (/\b(movement history|route|track history|trajectory|path)\b/i.test(normalized)) {
    intent = "movement_history";
  } else if (/\b(fastest|top speed)\b/i.test(normalized)) {
    intent = "fastest";
  }

  // 2. Detect Colors
  const matchedColors: VehicleColorName[] = [];
  for (const [kw, colName] of Object.entries(COLOR_SYNONYMS)) {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    if (regex.test(normalized) && !matchedColors.includes(colName)) {
      matchedColors.push(colName);
    }
  }

  // 3. Detect Vehicle Classes
  const matchedClasses: VehicleCategory[] = [];
  for (const [kw, cls] of Object.entries(CLASS_SYNONYMS)) {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    if (regex.test(normalized) && !matchedClasses.includes(cls)) {
      matchedClasses.push(cls);
    }
  }

  // 4. Detect Speed Condition
  const speed = parseSpeedCondition(normalized);

  // 5. Detect Plate Condition
  const plate = parsePlateCondition(normalized, rawQuery);

  // 6. Detect Time Condition
  const timeRange = parseTimeCondition(normalized);

  // 7. Detect Violations
  const violations: string[] = [];
  if (/\b(helmet|no helmet|without helmet)\b/i.test(normalized)) {
    violations.push("helmet");
  }
  if (/\b(triple|triple riding|3 persons|three persons)\b/i.test(normalized)) {
    violations.push("triple_riding");
  }
  if (/\b(overspeeding|speed limit|speed violation)\b/i.test(normalized)) {
    violations.push("overspeeding");
  }
  if (/\b(wrong way|one way|wrong direction)\b/i.test(normalized)) {
    violations.push("wrong_way");
  }
  if (/\b(challans?|violations?|violating)\b/i.test(normalized) && violations.length === 0) {
    violations.push("any");
  }

  // 8. Check Ambiguity
  const ambiguity = detectAmbiguity(rawQuery, normalized);

  // 9. Sort Strategy
  let sort: TrafficQuery["sort"] = "timestamp_desc";
  if (speed?.operator === "fastest") {
    sort = "speed_desc";
  }

  return {
    rawQuery,
    intent,
    vehicleClasses: matchedClasses,
    colors: matchedColors,
    plate,
    speed,
    violations,
    timeRange,
    sort,
    limit: 100,
    ambiguity,
  };
}

/**
 * Converts a legacy VehicleRecord into standard ForensicObservation format.
 */
export function recordToObservation(r: VehicleRecord): ForensicObservation {
  return {
    id: r.id,
    reportId: r.reportId,
    trackId: r.trackId ?? null,
    vehicleClass: r.className,
    color: {
      name: r.color.name,
      hex: r.color.hex,
      confidence: r.color.confidence,
    },
    plate: {
      text: r.plateText ?? null,
      stateCode: r.plateText ? r.plateText.slice(0, 2).toUpperCase() : null,
      stateName: r.stateName ?? null,
      rtoLocation: r.rtoLocation ?? null,
      confidence: r.plateText ? 0.9 : 0.0,
    },
    speed: {
      kmh: r.speedKmh ?? (r.speedMps != null ? Math.round(r.speedMps * 3.6) : null),
      mps: r.speedMps ?? (r.speedKmh != null ? r.speedKmh / 3.6 : null),
      isSpeeding: r.isSpeeding ?? ((r.speedKmh ?? 0) > 50),
      confidence: r.speedKmh != null ? 0.85 : 0.0,
    },
    violations: r.violations ?? (r.isSpeeding ? ["Overspeeding"] : []),
    cameraId: "CAM-01-SEC4",
    cameraName: "Sector 4 Main Corridor CCTV",
    location: {
      latitude: r.location?.latitude ?? 19.076,
      longitude: r.location?.longitude ?? 72.8777,
      landmark: r.location?.landmark ?? "National Highway · Sector 4",
    },
    timestamp: r.timestamp,
    sourceMode: r.sourceMode,
    evidenceId: r.reportId,
  };
}

/**
 * Evaluates a TrafficQuery AST against an array of ForensicObservations.
 */
export function evaluateQuery(query: TrafficQuery, observations: ForensicObservation[]): ForensicObservation[] {
  return observations.filter((obs) => {
    // 1. Color matching
    if (query.colors.length > 0) {
      if (!query.colors.includes(obs.color.name)) {
        return false;
      }
    }

    // 2. Class matching
    if (query.vehicleClasses.length > 0) {
      const cls = obs.vehicleClass.toLowerCase();
      const match = query.vehicleClasses.some((c) => {
        if (c === "vehicle") return true;
        if (c === "motorcycle") return cls === "motorcycle" || cls === "two-wheeler";
        return cls === c;
      });
      if (!match) return false;
    }

    // 3. Plate matching
    if (query.plate) {
      const p = query.plate;
      if (p.mode === "exact" && p.text) {
        const cleanObsPlate = (obs.plate.text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const cleanTarget = p.text.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!cleanObsPlate.includes(cleanTarget)) return false;
      } else if (p.mode === "state" && p.stateCode) {
        const cleanObsPlate = (obs.plate.text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const matchPlateCode = cleanObsPlate.startsWith(p.stateCode);
        const matchState = obs.plate.stateName?.toUpperCase().includes(p.stateCode);
        if (!matchPlateCode && !matchState) return false;
      } else if (p.mode === "has_plate") {
        if (!obs.plate.text) return false;
      } else if (p.mode === "unscanned") {
        if (obs.plate.text) return false;
      }
    }

    // 4. Speed matching
    if (query.speed) {
      const s = query.speed;
      const speedVal = obs.speed.kmh;
      if (s.operator === ">" && s.value != null) {
        if (speedVal == null || speedVal <= s.value) return false;
      } else if (s.operator === "<" && s.value != null) {
        if (speedVal == null || speedVal >= s.value) return false;
      } else if (s.operator === "between" && s.value != null && s.upperValue != null) {
        if (speedVal == null || speedVal < s.value || speedVal > s.upperValue) return false;
      } else if (s.operator === "speeding") {
        if (!obs.speed.isSpeeding && (speedVal == null || speedVal <= (s.value ?? 50))) return false;
      }
    }

    // 5. Violations matching
    if (query.violations.length > 0) {
      const hasAny = query.violations.includes("any");
      if (hasAny) {
        const hasViolation = obs.violations.length > 0 || obs.speed.isSpeeding;
        if (!hasViolation) return false;
      } else {
        const obsViolationsLower = obs.violations.map((v) => v.toLowerCase());
        const match = query.violations.some((reqViol) => {
          if (reqViol === "helmet") {
            return obsViolationsLower.some((v) => v.includes("helmet"));
          }
          if (reqViol === "triple_riding") {
            return obsViolationsLower.some((v) => v.includes("triple"));
          }
          if (reqViol === "overspeeding") {
            return obs.speed.isSpeeding || obsViolationsLower.some((v) => v.includes("speed"));
          }
          if (reqViol === "wrong_way") {
            return obsViolationsLower.some((v) => v.includes("direction") || v.includes("wrong way"));
          }
          return false;
        });
        if (!match) return false;
      }
    }

    // 6. Time Range matching
    if (query.timeRange) {
      const obsTime = new Date(obs.timestamp).getTime();
      if (query.timeRange.fromIso) {
        const fromTime = new Date(query.timeRange.fromIso).getTime();
        if (obsTime < fromTime) return false;
      }
      if (query.timeRange.toIso) {
        const toTime = new Date(query.timeRange.toIso).getTime();
        if (obsTime > toTime) return false;
      }
    }

    return true;
  });
}

/**
 * Generates an honest, conversational summary text for query results.
 */
export function buildConversationalSummary(
  query: TrafficQuery,
  results: ForensicObservation[],
  totalObservations: number,
  executionTimeMs: number,
): string {
  const count = results.length;
  const colorPart = query.colors.length > 0 ? `${query.colors[0].toLowerCase()} ` : "";
  const classPart = query.vehicleClasses.length > 0 ? `${query.vehicleClasses[0]}s` : "vehicles";

  if (count === 0) {
    let msg = `No ${colorPart}${classPart} found in the current CCTV session.`;
    if (totalObservations > 0) {
      msg += ` Scanned ${totalObservations} real vehicle sightings in ${executionTimeMs}ms without a match.`;
    }
    return msg;
  }

  let text = `Found ${count} ${colorPart}${classPart} observed by this camera.`;

  const scannedPlates = results.filter((r) => !!r.plate.text).length;
  if (scannedPlates > 0) {
    text += ` ${scannedPlates} ${scannedPlates === 1 ? "has" : "have"} scanned Indian number plates.`;
  }

  if (query.speed) {
    if (query.speed.operator === ">" && query.speed.value) {
      text += ` Traveling over ${query.speed.value} km/h.`;
    } else if (query.speed.operator === "speeding") {
      text += ` Flagged for speed review.`;
    } else if (query.speed.operator === "fastest") {
      text += ` Ranked by top recorded speed.`;
    }
  }

  if (query.plate?.stateCode) {
    text += ` Registered in ${query.plate.stateCode}.`;
  }

  return text;
}

/**
 * Main query execution entry point for live records.
 */
export function executeTrafficQuery(
  rawQuery: string,
  records: (VehicleRecord | ForensicObservation)[],
): ForensicSearchResponse & {
  summaryText: string;
  matchedRecords: any[];
  totalCount: number;
  parsedFilters: any;
} {
  const startTime = performance.now();
  const query = parseTrafficQuery(rawQuery);

  // Normalize all input items to ForensicObservation
  const observations: ForensicObservation[] = records.map((item) => {
    if ("vehicleClass" in item && "plate" in item && "color" in item) {
      return item as ForensicObservation;
    }
    return recordToObservation(item as VehicleRecord);
  });

  let matched = evaluateQuery(query, observations);

  // Apply sorting
  if (query.sort === "speed_desc") {
    matched = [...matched].sort((a, b) => (b.speed.kmh ?? 0) - (a.speed.kmh ?? 0));
  } else if (query.sort === "confidence_desc") {
    matched = [...matched].sort((a, b) => (b.plate.confidence + b.color.confidence) - (a.plate.confidence + a.color.confidence));
  } else {
    // timestamp_desc default
    matched = [...matched].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  if (query.limit && matched.length > query.limit) {
    matched = matched.slice(0, query.limit);
  }

  const executionTimeMs = Math.round(performance.now() - startTime);
  const summary = buildConversationalSummary(query, matched, observations.length, executionTimeMs);

  // Provide dual interface on each record so both flat and nested access work
  const dualRecords = matched.map((obs) => ({
    ...obs,
    className: obs.vehicleClass,
    plateText: obs.plate.text,
    rtoLocation: obs.plate.rtoLocation,
    stateName: obs.plate.stateName,
    speedKmh: obs.speed.kmh,
    speedMps: obs.speed.mps,
    isSpeeding: obs.speed.isSpeeding,
  }));

  return {
    query,
    summary,
    summaryText: summary,
    matchedObservations: matched,
    matchedRecords: dualRecords,
    totalMatches: matched.length,
    totalCount: matched.length,
    executionTimeMs,
    engine: "live_client",
    ambiguity: query.ambiguity,
    parsedFilters: parseNaturalLanguageQuery(rawQuery),
  };
}

/**
 * Backward-compatible function for existing UI components.
 */
export function parseNaturalLanguageQuery(query: string) {
  const parsed = parseTrafficQuery(query);
  const norm = query.toLowerCase();
  return {
    targetColor: parsed.colors[0] ?? null,
    targetClass: parsed.vehicleClasses[0] ?? null,
    requirePlate:
      norm.includes("plate") ||
      norm.includes("number") ||
      norm.includes("license") ||
      (parsed.plate != null && parsed.plate.mode !== "unscanned"),
    stateCode: parsed.plate?.stateCode ?? null,
    minSpeedKmh: parsed.speed?.value ?? null,
    speedingOnly:
      parsed.speed?.operator === "speeding" ||
      norm.includes("speed") ||
      norm.includes("fast"),
    violationsOnly: parsed.violations.length > 0,
    rawQuery: query,
  };
}
