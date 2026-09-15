/**
 * Traffic Natural Language Query Engine & Forensic Search Assistant.
 * Parses plain-English queries (e.g., "Find all red cars and their number plate")
 * and filters captured vehicle records with conversational responses.
 */

import type { VehicleColorResult } from "../vision/colorDetector";

export interface VehicleRecord {
  id: string;
  reportId?: string;
  trackId?: number | null;
  className: string;
  color: VehicleColorResult;
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
}

export interface ParsedFilters {
  targetColor?: VehicleColorResult["name"] | null;
  targetClass?: string | null;
  requirePlate?: boolean;
  stateCode?: string | null;
  minSpeedKmh?: number | null;
  speedingOnly?: boolean;
  violationsOnly?: boolean;
  rawQuery: string;
}

export interface QueryResult {
  summaryText: string;
  matchedRecords: VehicleRecord[];
  totalCount: number;
  parsedFilters: ParsedFilters;
}

const COLOR_KEYWORDS: Record<string, VehicleColorResult["name"]> = {
  red: "Red",
  crimson: "Red",
  white: "White",
  black: "Black",
  dark: "Black",
  silver: "Silver",
  gray: "Silver",
  grey: "Silver",
  blue: "Blue",
  navy: "Blue",
  yellow: "Yellow",
  gold: "Yellow",
  green: "Green",
  orange: "Orange",
};

const CLASS_KEYWORDS: Record<string, string> = {
  "two-wheelers": "motorcycle",
  "two-wheeler": "motorcycle",
  "two wheelers": "motorcycle",
  "two wheeler": "motorcycle",
  twowheelers: "motorcycle",
  twowheeler: "motorcycle",
  motorcycles: "motorcycle",
  motorcycle: "motorcycle",
  bikes: "motorcycle",
  bike: "motorcycle",
  scooters: "motorcycle",
  scooter: "motorcycle",
  trucks: "truck",
  truck: "truck",
  lorry: "truck",
  buses: "bus",
  bus: "bus",
  cars: "car",
  car: "car",
  sedan: "car",
  suv: "car",
};

const STATE_CODES = [
  "AN", "AP", "AR", "AS", "BR", "CH", "CG", "DD", "DN", "DL",
  "GA", "GJ", "HR", "HP", "JH", "JK", "KA", "KL", "LA", "LD",
  "MP", "MH", "MN", "ML", "MZ", "NL", "OD", "PY", "PB", "RJ",
  "SK", "TN", "TS", "TR", "UP", "UK", "WB", "BH",
];

/**
 * Parses a natural language sentence into structured traffic query filters.
 */
export function parseNaturalLanguageQuery(query: string): ParsedFilters {
  const normalized = query.toLowerCase().trim();
  const filters: ParsedFilters = {
    rawQuery: query,
  };

  // 1. Detect Color
  for (const [kw, color] of Object.entries(COLOR_KEYWORDS)) {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    if (regex.test(normalized)) {
      filters.targetColor = color;
      break;
    }
  }

  // 2. Detect Vehicle Class
  for (const [kw, cls] of Object.entries(CLASS_KEYWORDS)) {
    if (normalized.includes(kw)) {
      filters.targetClass = cls;
      break;
    }
  }

  // 3. Detect Plate Requirement
  if (
    normalized.includes("plate") ||
    normalized.includes("number") ||
    normalized.includes("license") ||
    normalized.includes("registration") ||
    normalized.includes("hsrp")
  ) {
    filters.requirePlate = true;
  }

  // 4. Detect State Code
  for (const code of STATE_CODES) {
    const regex = new RegExp(`\\b${code}\\b`, "i");
    if (regex.test(normalized) || normalized.includes(code.toLowerCase())) {
      // Check if it's explicitly mentioned or as part of state name
      if (
        (code === "MH" && (regex.test(query) || normalized.includes("maharashtra"))) ||
        (code === "DL" && (regex.test(query) || normalized.includes("delhi"))) ||
        (code === "KA" && (regex.test(query) || normalized.includes("karnataka"))) ||
        (code === "GJ" && (regex.test(query) || normalized.includes("gujarat"))) ||
        (code === "TN" && (regex.test(query) || normalized.includes("tamil nadu"))) ||
        (code === "UP" && (regex.test(query) || normalized.includes("uttar pradesh"))) ||
        regex.test(query)
      ) {
        filters.stateCode = code;
        break;
      }
    }
  }

  // 5. Detect Speeding
  if (
    normalized.includes("speed") ||
    normalized.includes("fast") ||
    normalized.includes("over-speed") ||
    normalized.includes("overspeed")
  ) {
    filters.speedingOnly = true;
  }

  const speedMatch = normalized.match(/(?:above|over|exceeding|faster than|>)\s*(\d+)/i);
  if (speedMatch) {
    filters.minSpeedKmh = Number(speedMatch[1]);
    filters.speedingOnly = true;
  }

  // 6. Detect Violations
  if (
    normalized.includes("violation") ||
    normalized.includes("challan") ||
    normalized.includes("helmet") ||
    normalized.includes("triple")
  ) {
    filters.violationsOnly = true;
  }

  return filters;
}

/**
 * Filters vehicle records and constructs an intelligent conversational response.
 */
export function executeTrafficQuery(query: string, records: VehicleRecord[]): QueryResult {
  const filters = parseNaturalLanguageQuery(query);

  const matched = records.filter((r) => {
    // Check Color
    if (filters.targetColor && r.color.name !== filters.targetColor) {
      return false;
    }

    // Check Class
    if (filters.targetClass && r.className.toLowerCase() !== filters.targetClass) {
      return false;
    }

    // Check Plate
    if (filters.requirePlate && !r.plateText) {
      // If query specifically asks for "and their number plate", let's prioritize showing vehicles,
      // but if the user asked "vehicles with number plate", filter strictly.
      const strictPlateOnly =
        filters.rawQuery.toLowerCase().includes("with plate") ||
        filters.rawQuery.toLowerCase().includes("with number plate") ||
        filters.rawQuery.toLowerCase().includes("having plate");
      if (strictPlateOnly) return false;
    }

    // Check State Code
    if (filters.stateCode) {
      const matchPlate = r.plateText?.toUpperCase().startsWith(filters.stateCode);
      const matchState = r.stateName?.toUpperCase().includes(filters.stateCode);
      if (!matchPlate && !matchState) return false;
    }

    // Check Speed
    if (filters.minSpeedKmh != null && (r.speedKmh == null || r.speedKmh < filters.minSpeedKmh)) {
      return false;
    }
    if (filters.speedingOnly && !r.isSpeeding && (filters.minSpeedKmh == null || (r.speedKmh ?? 0) <= 50)) {
      return false;
    }

    // Check Violations
    if (filters.violationsOnly && (!r.violations || r.violations.length === 0)) {
      return false;
    }

    return true;
  });

  // Construct Conversational Summary
  let summaryText = "";
  const count = matched.length;
  const colorDesc = filters.targetColor ? `${filters.targetColor.toLowerCase()} ` : "";
  const classDesc = filters.targetClass ? `${filters.targetClass}s` : "vehicles";

  if (count === 0) {
    summaryText = `No ${colorDesc}${classDesc} found in the current CCTV session.`;
    if (filters.targetColor) {
      summaryText += ` None of the ${records.length} observed vehicles matched the color ${filters.targetColor}.`;
    }
  } else {
    const withPlatesCount = matched.filter((m) => !!m.plateText).length;
    summaryText = `Found ${count} ${colorDesc}${classDesc} observed by this camera.`;

    if (withPlatesCount > 0) {
      summaryText += ` ${withPlatesCount} ${withPlatesCount === 1 ? "has" : "have"} scanned Indian number plates.`;
    }

    if (filters.speedingOnly) {
      summaryText += ` Flagged for speed review.`;
    }
  }

  return {
    summaryText,
    matchedRecords: matched,
    totalCount: count,
    parsedFilters: filters,
  };
}
