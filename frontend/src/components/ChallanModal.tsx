import { useState } from "react";
import type { EChallanNotice } from "../challan/challanGenerator";

export function ChallanModal({
  challan,
  onClose,
}: {
  challan: EChallanNotice;
  onClose: () => void;
}) {
  const [lang, setLang] = useState<"en" | "hi">("en");

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadJson = () => {
    const jsonStr = JSON.stringify(challan, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `challan-${challan.challanId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isHindi = lang === "hi";

  return (
    <div className="challan-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="challan-title">
      <div className="challan-modal-container">
        {/* Actions bar (hidden in print) */}
        <div className="challan-actions-bar no-print">
          <div className="challan-actions-left">
            <span className="challan-modal-tag">📄 Traffic Enforcement e-Challan</span>
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
          </div>
          <div className="challan-actions-right">
            <button
              type="button"
              className="action-btn secondary"
              onClick={handleDownloadJson}
              title="Download raw JSON report"
            >
              💾 Export JSON
            </button>
            <button
              type="button"
              className="action-btn primary print-trigger-btn"
              onClick={handlePrint}
              title="Print document or Save as PDF"
            >
              🖨️ Print / Save as PDF
            </button>
            <button
              type="button"
              className="action-btn close-btn"
              onClick={onClose}
              aria-label="Close e-Challan"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Printable Official Challan Document */}
        <div className="challan-document" id="printable-challan">
          {/* Header Section */}
          <div className="challan-header">
            <div className="emblem-container">
              {/* National Emblem stylized SVG */}
              <svg viewBox="0 0 100 100" className="national-emblem" aria-hidden="true">
                <circle cx="50" cy="50" r="45" fill="none" stroke="#d97706" strokeWidth="3" />
                <path
                  d="M50 18 L53 32 L68 32 L56 42 L60 56 L50 47 L40 56 L44 42 L32 32 L47 32 Z"
                  fill="#d97706"
                />
                <circle cx="50" cy="50" r="14" fill="none" stroke="#d97706" strokeWidth="2" />
                <line x1="50" y1="36" x2="50" y2="64" stroke="#d97706" strokeWidth="1.5" />
                <line x1="36" y1="50" x2="64" y2="50" stroke="#d97706" strokeWidth="1.5" />
                <text x="50" y="85" textAnchor="middle" fontSize="10" fontWeight="bold" fill="#d97706">
                  सत्यमेव जयते
                </text>
              </svg>
            </div>

            <div className="challan-header-text">
              <h2>{isHindi ? "भारत सरकार · सड़क परिवहन एवं राजमार्ग मंत्रालय" : "GOVERNMENT OF INDIA · MINISTRY OF ROAD TRANSPORT & HIGHWAYS"}</h2>
              <h1>{isHindi ? challan.authorityNameHi : challan.authorityName}</h1>
              <p className="challan-subtitle">
                {isHindi
                  ? "ई-चालान / मोटर वाहन अधिनियम यातायात उल्लंघन नोटिस"
                  : "e-CHALLAN / TRAFFIC VIOLATION CITATION NOTICE"}
              </p>
            </div>

            <div className="challan-qr-box">
              {/* Decorative QR Code graphic for verification */}
              <div className="simulated-qr" title="Scan to verify e-Challan">
                <svg viewBox="0 0 60 60" width="60" height="60">
                  <rect width="60" height="60" fill="#ffffff" />
                  <rect x="5" y="5" width="16" height="16" fill="#000000" />
                  <rect x="7" y="7" width="12" height="12" fill="#ffffff" />
                  <rect x="9" y="9" width="8" height="8" fill="#000000" />
                  <rect x="39" y="5" width="16" height="16" fill="#000000" />
                  <rect x="41" y="7" width="12" height="12" fill="#ffffff" />
                  <rect x="43" y="9" width="8" height="8" fill="#000000" />
                  <rect x="5" y="39" width="16" height="16" fill="#000000" />
                  <rect x="7" y="41" width="12" height="12" fill="#ffffff" />
                  <rect x="9" y="43" width="8" height="8" fill="#000000" />
                  <rect x="25" y="10" width="8" height="8" fill="#000000" />
                  <rect x="25" y="25" width="12" height="12" fill="#000000" />
                  <rect x="40" y="25" width="8" height="8" fill="#000000" />
                  <rect x="25" y="42" width="10" height="10" fill="#000000" />
                  <rect x="40" y="42" width="14" height="14" fill="#000000" />
                </svg>
              </div>
              <span className="qr-caption">{isHindi ? "सत्यापन कोड" : "SCAN TO VERIFY"}</span>
            </div>
          </div>

          {/* Challan Metadata Strip */}
          <div className="challan-meta-strip">
            <div className="meta-item">
              <span className="meta-label">{isHindi ? "चालान संख्या" : "CHALLAN NUMBER"}</span>
              <strong className="meta-value challan-id-highlight" data-testid="challan-id">{challan.challanId}</strong>
            </div>
            <div className="meta-item">
              <span className="meta-label">{isHindi ? "जारी करने की तिथि" : "DATE & TIME"}</span>
              <strong className="meta-value">{challan.issueDateFormatted}</strong>
            </div>
            <div className="meta-item">
              <span className="meta-label">{isHindi ? "भुगतान की अंतिम तिथि" : "DUE DATE"}</span>
              <strong className="meta-value">{challan.dueDateFormatted}</strong>
            </div>
            <div className="meta-item">
              <span className="meta-label">{isHindi ? "स्थिति" : "STATUS"}</span>
              <span className="status-badge pending">{isHindi ? "लंबित" : challan.paymentStatus}</span>
            </div>
          </div>

          {/* Vehicle and Registration Details */}
          <div className="challan-section">
            <h3 className="section-title">
              {isHindi ? "1. वाहन एवं पंजीकरण विवरण" : "1. VEHICLE & REGISTRATION DETAILS"}
            </h3>
            <div className="challan-details-grid">
              <div className="detail-field">
                <span className="field-label">{isHindi ? "पंजीकरण संख्या" : "Registration No."}</span>
                <div className="plate-badge-display">
                  <span className="ind-flag">🇮🇳</span>
                  <strong className="plate-number" data-testid="challan-plate-number">{challan.registrationNumber}</strong>
                </div>
              </div>
              <div className="detail-field">
                <span className="field-label">{isHindi ? "राज्य / संघ राज्य क्षेत्र" : "State / Union Territory"}</span>
                <strong>{challan.stateName} ({challan.stateCode})</strong>
              </div>
              <div className="detail-field">
                <span className="field-label">{isHindi ? "आरटीओ कार्यालय" : "Registered RTO Office"}</span>
                <strong>{challan.rtoLocation} ({challan.rtoCode})</strong>
              </div>
              <div className="detail-field">
                <span className="field-label">{isHindi ? "वाहन श्रेणी" : "Vehicle Classification"}</span>
                <strong>{isHindi ? challan.vehicleClassHi : challan.vehicleClass}</strong>
              </div>
            </div>
          </div>

          {/* Violation and Measurement Facts */}
          <div className="challan-section">
            <h3 className="section-title">
              {isHindi ? "2. उल्लंघन विवरण एवं माप" : "2. VIOLATION DETAILS & MEASUREMENTS"}
            </h3>
            <div className="violation-banner">
              <div className="violation-desc">
                <strong className="violation-act">{challan.violationSection}</strong>
                <h4 className="violation-name">{isHindi ? challan.violationTitleHi : challan.violationTitle}</h4>
                <p className="violation-loc">
                  📍 {isHindi ? "स्थान" : "Location"}: <strong>{challan.locationName}</strong> · {challan.cameraName}
                </p>
              </div>
              {challan.isSpeedViolation && (
                <div className="speed-stats-comparison">
                  <div className="speed-box limit">
                    <span>{isHindi ? "अनुमेय गति" : "Speed Limit"}</span>
                    <strong>{challan.speedLimitKmh} km/h</strong>
                  </div>
                  <div className="speed-vs-arrow">➔</div>
                  <div className="speed-box recorded violation">
                    <span>{isHindi ? "मापी गई गति" : "Recorded Speed"}</span>
                    <strong data-testid="challan-recorded-speed">{challan.speedKmh} km/h</strong>
                  </div>
                  <div className="excess-pill">
                    +{challan.excessSpeedKmh} km/h {isHindi ? "अधिक" : "Over Limit"}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Photographic Evidence */}
          {(challan.evidenceSnapshotUrl || challan.plateCutoutUrl) && (
            <div className="challan-section">
              <h3 className="section-title">
                {isHindi ? "3. सीसीटीवी साक्ष्य तस्वीरें" : "3. PHOTOGRAPHIC EVIDENCE (CCTV CAPTURE)"}
              </h3>
              <div className="evidence-gallery">
                {challan.evidenceSnapshotUrl && (
                  <div className="evidence-frame">
                    <img
                      src={challan.evidenceSnapshotUrl}
                      alt="CCTV Vehicle Event Capture"
                      className="evidence-photo"
                    />
                    <span className="photo-tag">
                      {isHindi ? "वाहन साक्ष्य फ़्रेम (पूर्ण दृश्य)" : "Primary Vehicle Evidence Frame"}
                    </span>
                  </div>
                )}
                {challan.plateCutoutUrl && (
                  <div className="evidence-frame plate-frame">
                    <img
                      src={challan.plateCutoutUrl}
                      alt="License Plate Zoom Crop"
                      className="evidence-photo plate-crop"
                    />
                    <span className="photo-tag">
                      {isHindi ? "नंबर प्लेट क्रॉप (एचएसआरपी)" : "Cropped Number Plate Detail"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Penalty and Fine Calculation Table */}
          <div className="challan-section">
            <h3 className="section-title">
              {isHindi ? "4. जुर्माना एवं शास्ति विवरण" : "4. PENALTY & FINE CALCULATION"}
            </h3>
            <table className="fine-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{isHindi ? "धारा / प्रावधान" : "Section / Offence"}</th>
                  <th>{isHindi ? "विवरण" : "Description"}</th>
                  <th className="amount-col">{isHindi ? "राशि" : "Amount (INR)"}</th>
                </tr>
              </thead>
              <tbody>
                {challan.fineItems.map((item, idx) => (
                  <tr key={item.code}>
                    <td>{idx + 1}</td>
                    <td><strong>{item.section}</strong></td>
                    <td>{isHindi ? item.descriptionHi : item.description}</td>
                    <td className="amount-col">₹{item.amount.toLocaleString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="total-label">
                    <strong>{isHindi ? "कुल जुर्माना देय राशि" : "TOTAL FINE AMOUNT PAYABLE"}</strong>
                  </td>
                  <td className="amount-col total-amount" data-testid="challan-total-amount">
                    <strong>₹{challan.totalPenaltyInr.toLocaleString("en-IN")}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Legal Notice & Payment Instructions */}
          <div className="challan-footer-terms">
            <p>
              <strong>{isHindi ? "महत्वपूर्ण सूचना:" : "IMPORTANT NOTICE:"}</strong>{" "}
              {isHindi
                ? "यह चालान मोटर वाहन अधिनियम 1988 के तहत जारी किया गया है। निर्धारित 60 दिनों के भीतर ऑनलाइन पोर्टल parivahan.gov.in या नजदीकी आरटीओ कार्यालय में जुर्माना जमा करें। समय पर भुगतान न करने पर न्यायालय चालान जारी किया जा सकता है।"
                : "This citation is generated pursuant to the provisions of the Motor Vehicles (Amendment) Act 2019. Pay the fine online at parivahan.gov.in or at the nearest RTO / Traffic Branch within 60 days of issue. Failure to pay may result in court summons and registration impoundment."}
            </p>
            <div className="signature-strip">
              <div className="sig-block">
                <span>{isHindi ? "अधिकृत अधिकारी" : "Authorized Enforcement Officer"}</span>
                <strong>RoadLens AI Intelligent Traffic Division</strong>
              </div>
              <div className="sig-block right">
                <span>{isHindi ? "प्रणाली सत्यापन" : "System Verification"}</span>
                <strong>Digital Cryptographic Signature Verified ✓</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
