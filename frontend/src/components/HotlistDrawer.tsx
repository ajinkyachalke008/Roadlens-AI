import { useState, useEffect } from "react";
import { hotlist } from "../hotlist/hotlistService";
import type {
  WatchlistEntry,
  WatchlistCategory,
  HotlistConfig,
  HotlistAlertHit,
} from "../../../shared/src/hotlistTypes";

interface HotlistDrawerProps {
  onClose: () => void;
  onViewDossier?: (vehicleIdOrPlate: string) => void;
  onIssueChallan?: (reportId: string) => void;
}

export function HotlistDrawer({
  onClose,
  onViewDossier,
  onIssueChallan,
}: HotlistDrawerProps) {
  const [tab, setTab] = useState<"hits" | "watchlist" | "settings">("hits");
  const [hits, setHits] = useState<HotlistAlertHit[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [config, setConfig] = useState<HotlistConfig>(hotlist.getConfig());

  // Form states for adding new watchlist entry
  const [newPlate, setNewPlate] = useState("");
  const [newCategory, setNewCategory] = useState<WatchlistCategory>("stolen");
  const [newNotes, setNewNotes] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  useEffect(() => {
    setHits(hotlist.getHits());
    setWatchlist(hotlist.getWatchlist());
    setConfig(hotlist.getConfig());

    // Subscribe to new incoming hits in real-time
    const unsubscribe = hotlist.subscribe((_hit) => {
      setHits(hotlist.getHits());
    });

    return () => unsubscribe();
  }, []);

  const handleAddEntry = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlate.trim()) return;

    hotlist.addWatchlistEntry(newPlate, newCategory, newNotes);
    setWatchlist(hotlist.getWatchlist());
    setNewPlate("");
    setNewNotes("");
    setFeedbackMsg(`Added ${newPlate.toUpperCase()} to BOLO watchlist.`);
    setTimeout(() => setFeedbackMsg(null), 3000);
  };

  const handleToggleEntry = (id: string) => {
    hotlist.toggleWatchlistEntry(id);
    setWatchlist(hotlist.getWatchlist());
  };

  const handleRemoveEntry = (id: string) => {
    hotlist.removeWatchlistEntry(id);
    setWatchlist(hotlist.getWatchlist());
  };

  const handleDismissHit = (id: string) => {
    hotlist.dismissHit(id);
    setHits(hotlist.getHits());
  };

  const handleClearHits = () => {
    hotlist.clearHits();
    setHits([]);
  };

  const handleExportHits = () => {
    const dataStr = JSON.stringify(hits, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `roadlens_hotlist_alerts_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getCategoryBadgeClass = (category: string) => {
    switch (category) {
      case "stolen":
        return "badge-stolen";
      case "wanted":
        return "badge-wanted";
      case "speeding":
        return "badge-speeding";
      case "violation":
        return "badge-violation";
      case "uninsured":
        return "badge-uninsured";
      default:
        return "badge-custom";
    }
  };

  return (
    <aside className="hotlist-drawer" aria-label="BOLO Watchlist & Enforcement Alarms">
      {/* Header */}
      <div className="hotlist-header">
        <div className="hotlist-title-wrap">
          <span className="hotlist-icon" aria-hidden="true">🚨</span>
          <div>
            <h2>BOLO Watchlist & Alarms</h2>
            <p className="hotlist-subtitle">
              Real-time stolen vehicle alerts, speed alarms & active enforcement
            </p>
          </div>
        </div>
        <button
          type="button"
          className="hotlist-close-btn"
          aria-label="Close Hotlist Drawer"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {/* Tabs */}
      <div className="hotlist-tabs">
        <button
          type="button"
          className={`hotlist-tab-btn ${tab === "hits" ? "active" : ""}`}
          onClick={() => setTab("hits")}
        >
          Active Hits ({hits.filter((h) => !h.acknowledged).length})
        </button>
        <button
          type="button"
          className={`hotlist-tab-btn ${tab === "watchlist" ? "active" : ""}`}
          onClick={() => setTab("watchlist")}
        >
          Watchlist ({watchlist.length})
        </button>
        <button
          type="button"
          className={`hotlist-tab-btn ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
        >
          Alarm Settings
        </button>
      </div>

      {feedbackMsg && <div className="hotlist-feedback-toast">{feedbackMsg}</div>}

      {/* Tab Body */}
      <div className="hotlist-body">
        {tab === "hits" && (
          <div className="hotlist-hits-section">
            <div className="hits-controls">
              <span>Total Detections: {hits.length}</span>
              <div className="hits-action-btns">
                {hits.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="btn-export-hits"
                      onClick={handleExportHits}
                    >
                      📥 Export JSON
                    </button>
                    <button
                      type="button"
                      className="btn-clear-hits"
                      onClick={handleClearHits}
                    >
                      🗑️ Clear
                    </button>
                  </>
                )}
              </div>
            </div>

            {hits.length === 0 ? (
              <div className="hits-empty-state">
                <span className="empty-icon">🛡️</span>
                <h4>No Active Hotlist Alarms</h4>
                <p>
                  Incoming traffic is being monitored against the BOLO watchlist and
                  active speed limit thresholds in real time.
                </p>
              </div>
            ) : (
              <div className="hits-list">
                {hits.map((hit) => (
                  <div
                    key={hit.id}
                    className={`hit-card ${hit.acknowledged ? "acknowledged" : "active"} ${getCategoryBadgeClass(
                      hit.category
                    )}`}
                  >
                    <div className="hit-card-top">
                      <span className={`hit-cat-badge ${getCategoryBadgeClass(hit.category)}`}>
                        {hit.category.toUpperCase()}
                      </span>
                      <span className="hit-time">
                        {new Date(hit.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>

                    <div className="hit-details">
                      {hit.plateText ? (
                        <div className="hit-plate-hsrp">
                          <span className="ind">IND</span>
                          <strong>{hit.plateText}</strong>
                        </div>
                      ) : (
                        <span className="hit-unscanned">Vehicle Track #{hit.trackId ?? "N/A"}</span>
                      )}

                      <p className="hit-reason">{hit.matchedReason}</p>

                      <div className="hit-meta-row">
                        <span className="hit-meta-pill">🚗 {hit.vehicleClass}</span>
                        {hit.speedKmh != null && (
                          <span className={`hit-meta-pill ${hit.isSpeeding ? "speeding" : ""}`}>
                            ⚡ {hit.speedKmh} km/h
                          </span>
                        )}
                        {hit.gps?.formattedLocation && (
                          <span className="hit-meta-pill" title={hit.gps.formattedLocation}>
                            📍 {hit.gps.formattedLocation}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="hit-card-actions">
                      {hit.plateText && onViewDossier && (
                        <button
                          type="button"
                          className="hit-action-btn dossier"
                          onClick={() => onViewDossier(hit.plateText!)}
                        >
                          🗺️ View Dossier
                        </button>
                      )}
                      {hit.reportId && onIssueChallan && (
                        <button
                          type="button"
                          className="hit-action-btn challan"
                          onClick={() => onIssueChallan(hit.reportId!)}
                        >
                          📄 Issue e-Challan
                        </button>
                      )}
                      {!hit.acknowledged && (
                        <button
                          type="button"
                          className="hit-action-btn dismiss"
                          onClick={() => handleDismissHit(hit.id)}
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "watchlist" && (
          <div className="hotlist-watchlist-section">
            <form className="add-entry-form" onSubmit={handleAddEntry}>
              <h4>Add Target Plate to Watchlist</h4>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="e.g. MH12AB1234 or DL01*"
                  value={newPlate}
                  onChange={(e) => setNewPlate(e.target.value)}
                  className="plate-input"
                  required
                />
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as WatchlistCategory)}
                  className="cat-select"
                >
                  <option value="stolen">🚨 Stolen</option>
                  <option value="wanted">🟠 Wanted / Suspect</option>
                  <option value="uninsured">🟡 Uninsured / Delinquent</option>
                  <option value="vip">⭐ VIP Escort</option>
                  <option value="custom">🔍 Custom Watch</option>
                </select>
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Reason / Case FIR / Officer Notes (optional)"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  className="notes-input"
                />
                <button type="submit" className="btn-add-entry">
                  + Add Watch Target
                </button>
              </div>
            </form>

            <div className="watchlist-table-wrap">
              <h4>Active Monitored Targets ({watchlist.length})</h4>
              <div className="watchlist-list">
                {watchlist.map((entry) => (
                  <div key={entry.id} className={`watchlist-row ${entry.active ? "active" : "inactive"}`}>
                    <div className="wl-left">
                      <span className={`wl-cat-badge ${getCategoryBadgeClass(entry.category)}`}>
                        {entry.category.toUpperCase()}
                      </span>
                      <strong className="wl-pattern">{entry.platePattern}</strong>
                      {entry.notes && <span className="wl-notes">{entry.notes}</span>}
                    </div>
                    <div className="wl-right">
                      <button
                        type="button"
                        className={`btn-toggle-wl ${entry.active ? "active" : ""}`}
                        onClick={() => handleToggleEntry(entry.id)}
                        title={entry.active ? "Click to deactivate" : "Click to activate"}
                      >
                        {entry.active ? "ACTIVE" : "PAUSED"}
                      </button>
                      <button
                        type="button"
                        className="btn-delete-wl"
                        onClick={() => handleRemoveEntry(entry.id)}
                        title="Delete target"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="hotlist-settings-section">
            <div className="settings-group">
              <h4>🚨 Speed Limit Alarm</h4>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={config.speedAlarmEnabled}
                  onChange={(e) => {
                    const next = { ...config, speedAlarmEnabled: e.target.checked };
                    setConfig(next);
                    hotlist.updateConfig(next);
                  }}
                />
                <span>Enable Over-Speed Alarm</span>
              </label>

              {config.speedAlarmEnabled && (
                <div className="slider-box">
                  <div className="slider-header">
                    <span>Alarm Speed Limit:</span>
                    <strong>{config.speedAlarmKmh} km/h</strong>
                  </div>
                  <input
                    type="range"
                    min="30"
                    max="120"
                    step="5"
                    value={config.speedAlarmKmh}
                    onChange={(e) => {
                      const next = { ...config, speedAlarmKmh: Number(e.target.value) };
                      setConfig(next);
                      hotlist.updateConfig(next);
                    }}
                    className="speed-range-slider"
                  />
                  <div className="slider-ticks">
                    <span>30 km/h</span>
                    <span>60 km/h</span>
                    <span>90 km/h</span>
                    <span>120 km/h</span>
                  </div>
                </div>
              )}
            </div>

            <div className="settings-group">
              <h4>⚠️ Safety Violations Alarm</h4>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={config.violationAlarmEnabled}
                  onChange={(e) => {
                    const next = { ...config, violationAlarmEnabled: e.target.checked };
                    setConfig(next);
                    hotlist.updateConfig(next);
                  }}
                />
                <span>Trigger Alarm on Two-Wheeler Violations (No Helmet / Triple Riding)</span>
              </label>
            </div>

            <div className="settings-group">
              <h4>🔊 Enforcement Siren Tone</h4>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={config.audioAlarmEnabled}
                  onChange={(e) => {
                    const next = { ...config, audioAlarmEnabled: e.target.checked };
                    setConfig(next);
                    hotlist.updateConfig(next);
                  }}
                />
                <span>Play High-Urgency Siren (Web Audio API Synthesizer)</span>
              </label>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
