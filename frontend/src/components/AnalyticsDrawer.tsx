import { useState } from "react";
import { Drawer } from "./Drawer";
import type { Report } from "../../../shared/src/schemas";
import {
  computeTrafficAnalytics,
  generateAnalyticsCsv,
  type TrafficAnalyticsSummary,
} from "../analytics/trafficAnalytics";

export function AnalyticsDrawer({
  reports,
  onClose,
}: {
  reports: Report[];
  onClose: () => void;
}) {
  const [lang, setLang] = useState<"en" | "hi">("en");
  const isHindi = lang === "hi";

  const summary: TrafficAnalyticsSummary = computeTrafficAnalytics(reports);

  const handleExportCsv = () => {
    const csvContent = generateAnalyticsCsv(summary);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `roadlens-traffic-analytics-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    const jsonContent = JSON.stringify(summary, null, 2);
    const blob = new Blob([jsonContent], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `roadlens-traffic-analytics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Drawer
      title={isHindi ? "📊 यातायात विश्लेषण डैशबोर्ड" : "📊 Traffic Analytics & Flow Insights"}
      onClose={onClose}
    >
      <div className="analytics-drawer-content">
        {/* Language switcher & export toolbar */}
        <div className="analytics-toolbar">
          <div className="lang-toggle-group">
            <button
              type="button"
              className={`lang-btn ${!isHindi ? "active" : ""}`}
              onClick={() => setLang("en")}
            >
              English
            </button>
            <button
              type="button"
              className={`lang-btn ${isHindi ? "active" : ""}`}
              onClick={() => setLang("hi")}
            >
              हिंदी
            </button>
          </div>
          <div className="analytics-actions">
            <button
              type="button"
              className="analytics-export-btn"
              onClick={handleExportCsv}
              title="Download CSV report"
            >
              📥 {isHindi ? "सीएसवी निर्यात" : "Export CSV"}
            </button>
            <button
              type="button"
              className="analytics-export-btn"
              onClick={handleExportJson}
              title="Download JSON summary"
            >
              💾 JSON
            </button>
          </div>
        </div>

        {/* Top KPI Cards */}
        <div className="analytics-kpi-grid">
          <div className="analytics-kpi-card" data-testid="kpi-total-vehicles">
            <span className="kpi-icon">🚗</span>
            <div className="kpi-body">
              <span className="kpi-label">{isHindi ? "कुल देखे गए वाहन" : "Total Vehicles"}</span>
              <strong className="kpi-value">{summary.totalObservations}</strong>
              <small className="kpi-sub">
                {summary.totalUniqueVehicles} {isHindi ? "अद्वितीय ट्रैक" : "unique tracks"}
              </small>
            </div>
          </div>

          <div className="analytics-kpi-card" data-testid="kpi-compliance-rate">
            <span className="kpi-icon">🛡️</span>
            <div className="kpi-body">
              <span className="kpi-label">{isHindi ? "गति अनुपालन दर" : "Speed Compliance"}</span>
              <strong
                className={`kpi-value ${summary.speedStats.complianceRate >= 85 ? "good" : "warn"}`}
              >
                {summary.speedStats.complianceRate}%
              </strong>
              <small className="kpi-sub">
                {summary.speedStats.compliantCount} / {summary.speedStats.measuredCount}{" "}
                {isHindi ? "कानून के भीतर" : "within limit"}
              </small>
            </div>
          </div>

          <div className="analytics-kpi-card" data-testid="kpi-speeding-violations">
            <span className="kpi-icon">🚨</span>
            <div className="kpi-body">
              <span className="kpi-label">{isHindi ? "गति सीमा उल्लंघन" : "Speed Violations"}</span>
              <strong
                className={`kpi-value ${summary.speedStats.violationsCount > 0 ? "violation" : "good"}`}
              >
                {summary.speedStats.violationsCount}
              </strong>
              <small className="kpi-sub">
                {isHindi ? "ई-चालान के पात्र" : "Eligible for e-Challan"}
              </small>
            </div>
          </div>

          <div className="analytics-kpi-card" data-testid="kpi-avg-speed">
            <span className="kpi-icon">⚡</span>
            <div className="kpi-body">
              <span className="kpi-label">{isHindi ? "औसत गति" : "Average Velocity"}</span>
              <strong className="kpi-value">
                {summary.speedStats.averageSpeedKmh} <small>km/h</small>
              </strong>
              <small className="kpi-sub">
                {isHindi ? "उच्चतम" : "Peak"}: {summary.speedStats.maxSpeedKmh} km/h
              </small>
            </div>
          </div>
        </div>

        {/* Traffic Composition Bar Breakdown */}
        <section className="analytics-section">
          <h3>{isHindi ? "1. यातायात वाहन संरचना (वर्गीकरण)" : "1. Vehicle Classification Breakdown"}</h3>
          <div className="composition-bars">
            {summary.vehicleClasses.map((item) => (
              <div className="comp-item" key={item.category}>
                <div className="comp-head">
                  <span className="comp-name">
                    {item.icon} {isHindi ? item.labelHi : item.label}
                  </span>
                  <span className="comp-count">
                    <strong>{item.count}</strong> ({item.percentage}%)
                  </span>
                </div>
                <div className="comp-track">
                  <div
                    className={`comp-fill ${item.category}`}
                    style={{ width: `${Math.max(item.percentage, item.count > 0 ? 4 : 0)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Speed Distribution Histogram */}
        <section className="analytics-section">
          <h3>{isHindi ? "2. गति वितरण हिस्टोग्राम (किमी/घंटा)" : "2. Velocity Distribution Spectrum"}</h3>
          <div className="speed-histogram">
            {summary.speedDistribution.map((bucket) => (
              <div className="hist-row" key={bucket.range}>
                <span className="hist-label">{bucket.label}</span>
                <div className="hist-track">
                  <div
                    className={`hist-fill ${bucket.status}`}
                    style={{ width: `${Math.max(bucket.percentage, bucket.count > 0 ? 5 : 0)}%` }}
                  />
                </div>
                <span className="hist-val">
                  <strong>{bucket.count}</strong> ({bucket.percentage}%)
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Indian Registration Plate Demographics */}
        <section className="analytics-section">
          <h3>{isHindi ? "3. भारतीय राज्य / आरटीओ मूल जनसांख्यिकी" : "3. Indian RTO & State Demographics"}</h3>
          <div className="plate-demographics-summary">
            <div className="plate-meta-badge">
              <span>{isHindi ? "कुल पहचानी गई प्लेटें" : "Total Recognized Plates"}</span>
              <strong>{summary.plateStats.confirmedIndianPlates}</strong>
            </div>
            {summary.plateStats.bharatSeriesPlates > 0 && (
              <div className="plate-meta-badge bh-badge">
                <span>🇮🇳 {isHindi ? "भारत सीरीज़ (BH)" : "Bharat Series (BH)"}</span>
                <strong>{summary.plateStats.bharatSeriesPlates}</strong>
              </div>
            )}
          </div>

          {summary.plateStats.topOriginStates.length > 0 ? (
            <div className="origin-states-list">
              {summary.plateStats.topOriginStates.map((st) => (
                <div className="origin-state-pill" key={st.stateCode}>
                  <span className="state-code-tag">{st.stateCode}</span>
                  <span className="state-name-tag">{st.stateName}</span>
                  <span className="state-count-tag">
                    {st.count} {isHindi ? "वाहन" : "vehicles"} ({st.percentage}%)
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-demographics">
              {isHindi
                ? "सत्र में अभी तक कोई भारतीय प्लेट दर्ज नहीं हुई है। हैंड्स-फ्री ऑटो-स्कैन चालू करें!"
                : "No Indian plates recognized in this session yet. Enable Hands-Free Auto-Scan to populate demographics!"}
            </p>
          )}
        </section>
      </div>
    </Drawer>
  );
}
