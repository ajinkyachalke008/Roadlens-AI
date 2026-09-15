/**
 * Shared type definitions for the RoadLens Real-Time BOLO Hotlist & Speed Alarms.
 */

export type WatchlistCategory =
  | "stolen"
  | "wanted"
  | "uninsured"
  | "vip"
  | "custom";

export interface WatchlistEntry {
  id: string;
  platePattern: string; // Exact plate (MH12AB1234) or prefix wildcard (MH12*)
  category: WatchlistCategory;
  notes: string;
  addedAt: string;
  active: boolean;
}

export interface HotlistConfig {
  speedAlarmKmh: number;
  speedAlarmEnabled: boolean;
  violationAlarmEnabled: boolean;
  audioAlarmEnabled: boolean;
}

export interface HotlistAlertHit {
  id: string;
  timestamp: string;
  trackId: number | null;
  plateText: string | null;
  category: WatchlistCategory | "speeding" | "violation";
  matchedReason: string;
  vehicleClass: string;
  speedKmh: number | null;
  isSpeeding: boolean;
  violations: string[];
  gps?: {
    latitude: number;
    longitude: number;
    formattedLocation?: string;
  } | null;
  snapshotDataUrl?: string | null;
  reportId?: string | null;
  acknowledged: boolean;
}
