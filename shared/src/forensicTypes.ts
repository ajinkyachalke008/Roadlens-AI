/**
 * Core Forensic Search and Traffic Intelligence Types.
 * Shared between Frontend, Client-side Forensic Engine, and Enterprise Backend.
 */

export type VehicleCategory =
  | "car"
  | "motorcycle"
  | "truck"
  | "bus"
  | "autorickshaw"
  | "van"
  | "vehicle";

export type VehicleColorName =
  | "White"
  | "Black"
  | "Silver"
  | "Red"
  | "Blue"
  | "Yellow"
  | "Green"
  | "Orange"
  | "Brown"
  | "Unknown";

export interface ColorAttribute {
  name: VehicleColorName;
  hex: string;
  confidence: number;
}

export interface PlateAttribute {
  text: string | null;
  stateCode: string | null;
  stateName?: string | null;
  rtoLocation?: string | null;
  confidence: number;
}

export interface SpeedAttribute {
  kmh: number | null;
  mps: number | null;
  isSpeeding: boolean;
  confidence: number;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  accuracyM?: number;
  landmark?: string;
}

export interface ForensicObservation {
  id: string;
  reportId?: string;
  trackId: number | null;
  vehicleClass: string;
  color: ColorAttribute;
  plate: PlateAttribute;
  speed: SpeedAttribute;
  violations: string[];
  cameraId: string;
  cameraName: string;
  location: GeoLocation;
  timestamp: string; // ISO 8601
  sourceMode?: string;
  snapshotDataUrl?: string | null;
  evidenceId?: string;
}

export type QueryIntent =
  | "search"
  | "count"
  | "movement_history"
  | "last_seen"
  | "fastest";

export interface SpeedCondition {
  operator: ">" | "<" | "between" | "fastest" | "slowest" | "speeding";
  value?: number;
  upperValue?: number;
}

export interface PlateCondition {
  mode: "exact" | "state" | "has_plate" | "unscanned";
  text?: string;
  stateCode?: string;
}

export interface TimeRangeCondition {
  fromIso?: string;
  toIso?: string;
  preset?: "today" | "yesterday" | "last_hour" | "last_24h" | "this_morning";
}

export interface AmbiguityOption {
  label: string;
  query: string;
  description?: string;
}

export interface AmbiguityClarification {
  isAmbiguous: boolean;
  reason?: string;
  options: AmbiguityOption[];
}

export interface TrafficQuery {
  rawQuery: string;
  intent: QueryIntent;
  vehicleClasses: VehicleCategory[];
  colors: VehicleColorName[];
  plate?: PlateCondition;
  speed?: SpeedCondition;
  violations: string[];
  timeRange?: TimeRangeCondition;
  cameraId?: string;
  sort: "timestamp_desc" | "speed_desc" | "confidence_desc";
  limit: number;
  ambiguity?: AmbiguityClarification;
}

export interface ForensicSearchResponse {
  query: TrafficQuery;
  summary: string;
  matchedObservations: ForensicObservation[];
  totalMatches: number;
  executionTimeMs: number;
  engine: "live_client" | "enterprise_postgis";
  ambiguity?: AmbiguityClarification;
}
