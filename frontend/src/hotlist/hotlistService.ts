import type {
  WatchlistEntry,
  WatchlistCategory,
  HotlistConfig,
  HotlistAlertHit,
} from "../../../shared/src/hotlistTypes";
import { playEmergencySiren } from "./alarmAudio";

const STORAGE_KEY_WATCHLIST = "roadlens_hotlist_watchlist_v1";
const STORAGE_KEY_CONFIG = "roadlens_hotlist_config_v1";
const STORAGE_KEY_HITS = "roadlens_hotlist_hits_v1";

const DEFAULT_WATCHLIST: WatchlistEntry[] = [
  {
    id: "wl-stolen-1",
    platePattern: "MH12AB1234",
    category: "stolen",
    notes: "Reported stolen vehicle — Pune Central Police FIR #2941",
    addedAt: new Date(Date.now() - 3600000).toISOString(),
    active: true,
  },
  {
    id: "wl-wanted-2",
    platePattern: "DL01*",
    category: "wanted",
    notes: "Delhi North Ring Road hit-and-run lookout",
    addedAt: new Date(Date.now() - 7200000).toISOString(),
    active: true,
  },
  {
    id: "wl-uninsured-3",
    platePattern: "KA05*",
    category: "uninsured",
    notes: "Bangalore South RTO tax/insurance delinquency alert",
    addedAt: new Date(Date.now() - 86400000).toISOString(),
    active: true,
  },
];

const DEFAULT_CONFIG: HotlistConfig = {
  speedAlarmKmh: 60,
  speedAlarmEnabled: true,
  violationAlarmEnabled: true,
  audioAlarmEnabled: true,
};

export type HotlistListener = (hit: HotlistAlertHit) => void;

export class HotlistService {
  private watchlist: WatchlistEntry[] = [];
  private config: HotlistConfig = DEFAULT_CONFIG;
  private hits: HotlistAlertHit[] = [];
  private listeners: Set<HotlistListener> = new Set();
  // Cooldown map: key -> timestamp ms
  private cooldowns: Map<string, number> = new Map();
  private readonly COOLDOWN_MS = 25000; // 25s debounce per target

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    try {
      const storedWl = localStorage.getItem(STORAGE_KEY_WATCHLIST);
      this.watchlist = storedWl ? JSON.parse(storedWl) : DEFAULT_WATCHLIST;

      const storedCfg = localStorage.getItem(STORAGE_KEY_CONFIG);
      this.config = storedCfg ? { ...DEFAULT_CONFIG, ...JSON.parse(storedCfg) } : DEFAULT_CONFIG;

      const storedHits = localStorage.getItem(STORAGE_KEY_HITS);
      this.hits = storedHits ? JSON.parse(storedHits) : [];
    } catch {
      this.watchlist = DEFAULT_WATCHLIST;
      this.config = DEFAULT_CONFIG;
      this.hits = [];
    }
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY_WATCHLIST, JSON.stringify(this.watchlist));
      localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(this.config));
      localStorage.setItem(STORAGE_KEY_HITS, JSON.stringify(this.hits.slice(0, 100)));
    } catch {
      // Storage full or private browsing
    }
  }

  public getWatchlist(): WatchlistEntry[] {
    return [...this.watchlist];
  }

  public getConfig(): HotlistConfig {
    return { ...this.config };
  }

  public getHits(): HotlistAlertHit[] {
    return [...this.hits];
  }

  public updateConfig(newConfig: Partial<HotlistConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.saveToStorage();
  }

  public addWatchlistEntry(
    platePattern: string,
    category: WatchlistCategory,
    notes = ""
  ): WatchlistEntry {
    const entry: WatchlistEntry = {
      id: `wl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      platePattern: platePattern.trim().toUpperCase(),
      category,
      notes: notes.trim(),
      addedAt: new Date().toISOString(),
      active: true,
    };
    this.watchlist.unshift(entry);
    this.saveToStorage();
    return entry;
  }

  public toggleWatchlistEntry(id: string): void {
    const target = this.watchlist.find((w) => w.id === id);
    if (target) {
      target.active = !target.active;
      this.saveToStorage();
    }
  }

  public removeWatchlistEntry(id: string): void {
    this.watchlist = this.watchlist.filter((w) => w.id !== id);
    this.saveToStorage();
  }

  public clearHits(): void {
    this.hits = [];
    this.saveToStorage();
  }

  public dismissHit(id: string): void {
    const hit = this.hits.find((h) => h.id === id);
    if (hit) {
      hit.acknowledged = true;
      this.saveToStorage();
    }
  }

  public subscribe(listener: HotlistListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Normalizes plate strings for comparison (removes spaces, hyphens, lowercase).
   */
  public normalizePlate(plate: string): string {
    return plate.toUpperCase().replace(/[\s\-_.]/g, "");
  }

  /**
   * Tests if an observed plate matches a watchlist pattern (supports wildcards `*`).
   */
  public matchesPattern(observedPlate: string, pattern: string): boolean {
    const normObs = this.normalizePlate(observedPlate);
    const normPat = this.normalizePlate(pattern);

    if (!normPat || !normObs) return false;

    // Exact match
    if (normPat === normObs) return true;

    // Wildcard prefix / suffix / contains
    if (normPat.includes("*")) {
      const regexStr = "^" + normPat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
      try {
        const regex = new RegExp(regexStr);
        return regex.test(normObs);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Checks an incoming vehicle observation against the active watchlist and alarm thresholds.
   * Returns a HotlistAlertHit if triggered, or null if no match or still cooling down.
   */
  public checkObservation(obs: {
    trackId: number | null;
    plateText: string | null;
    vehicleClass: string;
    speedKmh: number | null;
    isSpeeding?: boolean;
    violations?: string[];
    gps?: { latitude: number; longitude: number; formattedLocation?: string } | null;
    snapshotDataUrl?: string | null;
    reportId?: string | null;
  }): HotlistAlertHit | null {
    const now = Date.now();
    let hitCategory: WatchlistCategory | "speeding" | "violation" | null = null;
    let matchedReason = "";

    // 1. Check Plate against Watchlist
    if (obs.plateText) {
      for (const entry of this.watchlist) {
        if (!entry.active) continue;
        if (this.matchesPattern(obs.plateText, entry.platePattern)) {
          hitCategory = entry.category;
          matchedReason = `Plate matched BOLO watchlist [${entry.platePattern}] (${entry.category.toUpperCase()})${
            entry.notes ? ` — ${entry.notes}` : ""
          }`;
          break;
        }
      }
    }

    // 2. Check Speed Alarm
    if (!hitCategory && this.config.speedAlarmEnabled && obs.speedKmh != null) {
      if (obs.speedKmh >= this.config.speedAlarmKmh) {
        hitCategory = "speeding";
        matchedReason = `Vehicle speed ${obs.speedKmh} km/h exceeded alarm limit of ${this.config.speedAlarmKmh} km/h`;
      }
    }

    // 3. Check Safety Violations Alarm
    if (!hitCategory && this.config.violationAlarmEnabled && obs.violations && obs.violations.length > 0) {
      hitCategory = "violation";
      matchedReason = `Safety violation detected: ${obs.violations.join(", ")}`;
    }

    if (!hitCategory) return null;

    // Check Cooldown key
    const cooldownKey = obs.plateText
      ? `plate-${this.normalizePlate(obs.plateText)}`
      : `track-${obs.trackId ?? Math.random()}-${hitCategory}`;

    const lastAlertTime = this.cooldowns.get(cooldownKey) ?? 0;
    if (now - lastAlertTime < this.COOLDOWN_MS) {
      return null; // Suppress duplicate spam
    }

    // Register cooldown
    this.cooldowns.set(cooldownKey, now);

    const alertHit: HotlistAlertHit = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      trackId: obs.trackId,
      plateText: obs.plateText,
      category: hitCategory,
      matchedReason,
      vehicleClass: obs.vehicleClass,
      speedKmh: obs.speedKmh,
      isSpeeding: obs.isSpeeding ?? (obs.speedKmh != null && obs.speedKmh > 50),
      violations: obs.violations ?? [],
      gps: obs.gps,
      snapshotDataUrl: obs.snapshotDataUrl,
      reportId: obs.reportId,
      acknowledged: false,
    };

    // Store in hits
    this.hits.unshift(alertHit);
    if (this.hits.length > 100) this.hits.pop();
    this.saveToStorage();

    // Play Siren if enabled
    if (this.config.audioAlarmEnabled) {
      playEmergencySiren(1.5);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(alertHit);
      } catch {
        // Safe dispatch
      }
    }

    return alertHit;
  }
}

export const hotlist = new HotlistService();
