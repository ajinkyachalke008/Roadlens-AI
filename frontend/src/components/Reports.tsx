import { useEffect, useRef, useState } from "react";
import type { Report } from "../../../shared/src/schemas";
import type { SessionStore } from "../session/store";
import { csvExport, jsonExport, download } from "../session/export";
import { displaySpeed, type SpeedUnit } from "./speedUnits";
import { Drawer } from "./Drawer";
import { SHOWCASE_TRIGGER_REASON } from "../showcase/constants";
import { parseIndianPlate } from "../../../shared/src/indianPlates";
import { ChallanModal } from "./ChallanModal";
import { createEChallanFromReport, type EChallanNotice } from "../challan/challanGenerator";
/**
 * One settled line of plate text for a report.
 *
 * Confirmed text still requires multi-frame consensus. A separately gated
 * single-frame candidate may be shown only as "Possible" and "Unconfirmed";
 * it never populates the confirmed plate field.
 */
export function plateLabel(report: Report) {
  switch (report.plateStatus) {
    case "read": {
      if (!report.plateText) return "Unreadable";
      const indian = parseIndianPlate(report.plateText);
      const conf =
        typeof report.plateConfidence === "number"
          ? ` · ${(report.plateConfidence * 100).toFixed(0)}%`
          : "";
      if (indian?.isValid) {
        return `🇮🇳 ${indian.formatted} · ${indian.stateName} (${indian.rtoLocation})${conf}`;
      }
      return `${report.plateText}${conf}`;
    }
    case "pending":
      return report.plateCandidateText
        ? `Possible plate: ${report.plateCandidateText} · Unconfirmed · ${report.plateCandidateSupportingFrames ?? 1} frame`
        : "Analyzing clearer frames…";
    case "unreadable":
      return report.plateCandidateText
        ? `Possible plate: ${report.plateCandidateText} · Unconfirmed · ${report.plateCandidateSupportingFrames ?? 1} frame`
        : typeof report.plateDetectorConfidence === "number"
          ? "Plate located · text unreadable"
          : "Unreadable";
    case "unavailable":
      return "Plate unavailable";
    default:
      return null;
  }
}
export const isShowcaseReport = (report: Report) =>
  report.kind === "observation" &&
  report.validityReasons.includes(SHOWCASE_TRIGGER_REASON);

const speedReasons = (report: Report) =>
  report.validityReasons.filter((reason) => reason !== SHOWCASE_TRIGGER_REASON);

const SPEED_REASON_LABELS: Record<string, string> = {
  handheld: "Mounted calibration required",
  not_calibrated: "Mounted calibration required",
  calibration_invalid: "Calibration needs review",
  background_unverified: "Background validation required",
  camera_moved: "Camera moved · recalibrate",
  insufficient_samples: "More observations required",
  insufficient_displacement: "More vehicle movement required",
  sampling_too_sparse: "Analysis sampling too sparse",
  outside_zone: "Vehicle outside measurement zone",
  residual_too_high: "Measurement consistency too low",
  inconsistent_direction: "Vehicle direction not stable",
  implausible_motion: "Motion did not pass validation",
  time_discontinuity: "Measurement continuity reset",
  track_ambiguous: "Vehicle track is ambiguous",
  paused: "Measurement paused",
};

export function reportSpeedStatus(report: Report) {
  if (report.speedMps !== null) return "Qualified measurement";
  const labels = [
    ...new Set(
      speedReasons(report).map(
        (reason) => SPEED_REASON_LABELS[reason] ?? "No qualified measurement",
      ),
    ),
  ];
  return labels.join(" · ") || "No qualified measurement";
}

export function reportMeasurementMode(report: Report) {
  if (report.validityReasons.includes("handheld")) return "Handheld";
  return report.calibrationVersion === null ? "Uncalibrated" : "Mounted";
}
export function Reports({
  store,
  revision,
  onReview,
  onEvidence,
  reviewEnabled = true,
  pending,
  speedUnit = "mph",
}: {
  store: SessionStore;
  revision: number;
  onReview: (r: Report, status: Report["review"]) => void;
  onEvidence?: (r: Report, imageId?: string) => void;
  reviewEnabled?: boolean;
  pending?: string;
  speedUnit?: SpeedUnit;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedChallan, setSelectedChallan] = useState<EChallanNotice | null>(null);
  const [filter, setFilter] = useState("all");
  const [urls, setUrls] = useState<{
    event: string | null;
    vehicle: string | null;
    plate: string | null;
  }>({ event: null, vehicle: null, plate: null });
  const reports = store.snapshot().reverse();
  const report = selected ? store.reports.get(selected) : undefined;
  const evidenceRequest = useRef(onEvidence);
  evidenceRequest.current = onEvidence;
  useEffect(() => {
    const created: string[] = [];
    const resolve = (id?: string | null, available = false) => {
      if (!id) return null;
      const blob = store.image(id);
      if (!blob) {
        if (available && report) evidenceRequest.current?.(report, id);
        return null;
      }
      const url = URL.createObjectURL(blob);
      created.push(url);
      return url;
    };
    const next = {
      event: resolve(report?.evidenceId, report?.evidenceState === "available"),
      vehicle: resolve(
        report?.bestCapture?.imageId,
        report?.bestCapture?.state === "available",
      ),
      plate: resolve(
        report?.bestPlateDetail?.imageId,
        report?.bestPlateDetail?.state === "available",
      ),
    };
    setUrls(next);
    return () => {
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [report, revision, store]);
  return (
    <section className="reports" aria-label="Reports">
      <div className="section-head">
        <div>
          <span className="eyebrow">TEMPORARY SESSION</span>
          <h2>
            Reports <span className="counter">{reports.length}</span>
          </h2>
        </div>
        <div className="actions">
          <select
            aria-label="Filter reports"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All reports</option>
            <option value="observation">Observations</option>
            <option value="speed_candidate">Speed candidates</option>
          </select>
          <button
            disabled={!reports.length}
            onClick={() =>
              download(jsonExport(store.snapshot()), "roadlens-reports.json")
            }
          >
            JSON
          </button>
          <button
            disabled={!reports.length}
            onClick={() =>
              download(
                csvExport(store.snapshot()),
                "roadlens-reports.csv",
                "text/csv",
              )
            }
          >
            CSV
          </button>
        </div>
      </div>
      {reports.length === 0 ? (
        <div className="empty-reports">
          <strong>No reports recorded yet</strong>
          <p>
            Tap <strong>📸 Capture Snapshot & Report</strong> above to save any analyzed frame with photo, or calibrate the road to record automated speed candidates.
          </p>
        </div>
      ) : (
        <div className="report-list">
          {reports
            .filter((r) => filter === "all" || r.kind === filter)
            .map((r) => (
              <button
                className="report-row"
                key={r.reportId}
                onClick={() => {
                  setSelected(r.reportId);
                  for (const imageId of [
                    r.evidenceState === "available" ? r.evidenceId : null,
                    r.bestCapture?.state === "available"
                      ? r.bestCapture.imageId
                      : null,
                    r.bestPlateDetail?.state === "available"
                      ? r.bestPlateDetail.imageId
                      : null,
                  ])
                    if (imageId && !store.image(imageId))
                      onEvidence?.(r, imageId);
                }}
              >
                <time>
                  {new Date(r.capturedAtIso).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
                <span>
                  <strong>
                    {isShowcaseReport(r)
                      ? "Traffic alert"
                      : r.kind === "observation"
                        ? "Observation"
                        : "Speed review candidate"}
                  </strong>
                  <small>
                    {r.sourceMode === "replay_video" ? "Replay · " : ""}
                    {(r.className ?? "Scene").toUpperCase()}
                    {r.trackId !== null ? ` · ID ${r.trackId}` : ""}
                    {/* The row is a fixed grid, so the plate rides along with
                        the object line rather than claiming a column of its
                        own; the full reading and its confidence are in the
                        detail view. */}
                    {r.plateStatus === "read" && r.plateText
                      ? ` · 🇮🇳 ${r.plateText}`
                      : ""}
                  </small>
                </span>
                <span className="report-speed">
                  {r.speedMps === null
                    ? "—"
                    : displaySpeed(r.speedMps, speedUnit)}
                </span>
                <span className="badge">{r.review}</span>
                <span aria-hidden="true">↗</span>
              </button>
            ))}
        </div>
      )}
      <p className="footnote">
        Review candidates, not legal citations. Reload or end session clears
        temporary data. Downloads and screenshots cannot be revoked.
      </p>
      {report && (
        <Drawer
          title={
            isShowcaseReport(report)
              ? "Traffic alert"
              : report.kind === "observation"
                ? "Observation"
                : "Speed review candidate"
          }
          onClose={() => setSelected(null)}
        >
          {urls.event ? (
            <>
              <h3>Event evidence</h3>
              <img
                className="evidence"
                src={urls.event}
                alt={
                  isShowcaseReport(report)
                    ? `Annotated report evidence with a red alert box around ${(report.className ?? "vehicle").toUpperCase()} · ID ${report.trackId}`
                    : "Exact event frame retained by the camera"
                }
                data-testid="report-evidence"
                data-evidence-annotation={
                  isShowcaseReport(report) ? "showcase" : "none"
                }
                data-evidence-frame-id={report.frameId}
                data-evidence-track-id={report.trackId ?? undefined}
              />
              {isShowcaseReport(report) && (
                <p className="evidence-caption">
                  <strong>Annotated report frame</strong>
                  <span>
                    Immutable event-time image. The red box marks the exact
                    reported vehicle.
                  </span>
                </p>
              )}
              <button
                onClick={() => {
                  const blob =
                    report.evidenceId && store.image(report.evidenceId);
                  if (blob)
                    download(
                      blob,
                      isShowcaseReport(report)
                        ? "roadlens-traffic-alert.jpg"
                        : "roadlens-evidence.jpg",
                    );
                }}
              >
                Download image
              </button>
            </>
          ) : (
            <div className="empty-reports">
              {report.evidenceState === "evicted"
                ? "Image evicted from memory"
                : report.evidenceState === "available"
                  ? "Image held by camera · unavailable while source is offline"
                  : "Image retention was off"}
            </div>
          )}
          {report.bestCapture && (
            <section className="report-artifact" aria-live="polite">
              <h3>Best vehicle capture</h3>
              {urls.vehicle ? (
                <img
                  className="evidence"
                  src={urls.vehicle}
                  alt="Best real vehicle crop selected across the capture window"
                  data-testid="report-best-capture"
                  data-artifact-frame-id={report.bestCapture.frameId}
                />
              ) : (
                <div className="empty-reports">
                  {report.bestCapture.state === "evicted"
                    ? "Best capture evicted from memory"
                    : "Best capture held by camera · loading when connected"}
                </div>
              )}
              <p className="evidence-caption">
                <strong>
                  {report.bestCapture.width} × {report.bestCapture.height}{" "}
                  source px
                </strong>
                <span>
                  Quality {report.bestCapture.quality.toFixed(2)} · source time{" "}
                  {report.bestCapture.sourceTimeMs.toFixed(0)} ms
                </span>
              </p>
            </section>
          )}
          {report.bestPlateDetail && (
            <section className="report-artifact" aria-live="polite">
              <h3>Best plate detail</h3>
              {urls.plate ? (
                <img
                  className="evidence plate-detail"
                  src={urls.plate}
                  alt="Best real plate-region crop selected across the capture window"
                  data-testid="report-best-plate"
                  data-artifact-frame-id={report.bestPlateDetail.frameId}
                />
              ) : (
                <div className="empty-reports">
                  {report.bestPlateDetail.state === "evicted"
                    ? "Plate detail evicted from memory"
                    : "Plate detail held by camera · loading when connected"}
                </div>
              )}
              <p className="evidence-caption">
                <strong>
                  {report.bestPlateDetail.width} ×{" "}
                  {report.bestPlateDetail.height} source px
                </strong>
                <span>
                  Unmodified source pixels · quality{" "}
                  {report.bestPlateDetail.quality.toFixed(2)}
                </span>
              </p>
            </section>
          )}
          <dl className="facts">
            <dt>Source</dt>
            <dd>
              {report.sourceMode === "replay_video" ? "Replay" : "Live camera"}
            </dd>
            {isShowcaseReport(report) && (
              <>
                <dt>Trigger</dt>
                <dd data-testid="report-trigger">Showcase trigger</dd>
              </>
            )}
            <dt>Vehicle</dt>
            <dd data-testid="report-vehicle">
              {/* Same identity form as the overlay and the selected card, so one
                  vehicle reads the same everywhere. */}
              {(report.className ?? "Scene").toUpperCase()}
              {report.trackId !== null ? ` · ID ${report.trackId}` : ""}
            </dd>
            <dt>Measured speed</dt>
            <dd data-testid="report-speed">
              {report.speedMps === null ? (
                <>
                  —{" "}
                  <small>
                    {report.validityReasons.includes("handheld") ||
                    report.calibrationVersion === null
                      ? "Mounted calibration required"
                      : "No qualified measurement"}
                  </small>
                </>
              ) : (
                displaySpeed(report.speedMps, speedUnit)
              )}
            </dd>
            <dt>Measurement mode</dt>
            <dd>{reportMeasurementMode(report)}</dd>
            {report.speedMps !== null &&
              report.policy.speedLimitMps !== null && (
                <>
                  <dt>Over the limit</dt>
                  <dd data-testid="report-over">
                    {report.speedMps > report.policy.speedLimitMps
                      ? `+${displaySpeed(report.speedMps - report.policy.speedLimitMps, speedUnit)}`
                      : "Within the configured limit"}
                  </dd>
                </>
              )}
            {plateLabel(report) !== null && (
              <>
                <dt>Plate</dt>
                <dd
                  data-testid="report-plate"
                  data-plate-status={report.plateStatus}
                  aria-live="polite"
                  aria-atomic="true"
                  title={
                    report.plateStatus === "read"
                      ? `Agreed across ${report.plateSupportingFrames ?? 0} frames`
                      : "Plate recognition is a review aid, never an identification"
                  }
                >
                  {plateLabel(report)}
                </dd>
                {report.plateStatus === "read" && (
                  <>
                    <dt>Plate support</dt>
                    <dd data-testid="report-plate-support">
                      Confirmed from {report.plateSupportingFrames ?? 0}{" "}
                      distinct frames
                    </dd>
                  </>
                )}
                {(report.plateAttemptFrames ?? 0) > 0 && (
                  <>
                    <dt>Plate attempts</dt>
                    <dd data-testid="report-plate-attempts">
                      {report.plateAttemptFrames} distinct ·{" "}
                      {report.plateLocalizedFrames ?? 0} localized ·{" "}
                      {report.plateReadableFrames ?? 0} readable
                    </dd>
                  </>
                )}
              </>
            )}
            <dt>Speed status</dt>
            <dd data-testid="report-speed-status">
              {reportSpeedStatus(report)}
            </dd>
            {report.policy.speedLimitMps !== null && (
              <>
                <dt>Configured speed limit</dt>
                <dd>{displaySpeed(report.policy.speedLimitMps, speedUnit)}</dd>
                <dt>Candidate margin</dt>
                <dd>{displaySpeed(report.policy.demoMarginMps, speedUnit)}</dd>
              </>
            )}
            <dt>Detector score</dt>
            <dd title="Model detection score, not speed accuracy or event probability">
              {report.score === null
                ? "—"
                : `${(report.score * 100).toFixed(1)}%`}
            </dd>
            <dt>Frame</dt>
            <dd>{report.frameId}</dd>
            <dt>Source time</dt>
            <dd>{report.sourceTimeMs.toFixed(0)} ms</dd>
            {report.measurementFrameId && (
              <>
                <dt>Measurement frame</dt>
                <dd>{report.measurementFrameId}</dd>
                <dt>Measurement source time</dt>
                <dd>{report.measurementSourceTimeMs?.toFixed(0)} ms</dd>
              </>
            )}
            <dt>Model</dt>
            <dd>
              {report.modelId} · {report.detectorProfile}
            </dd>
            <dt>Model hash</dt>
            <dd>{report.modelSha256}</dd>
            <dt>Calibration</dt>
            <dd>{report.calibrationVersion ?? "Not calibrated"}</dd>
            <dt>Tracker</dt>
            <dd>{report.trackerVersion}</dd>
            <dt>Revision</dt>
            <dd>{report.revision}</dd>
          </dl>
          <div className="actions">
            <button
              type="button"
              className="challan-trigger-btn"
              data-testid="generate-challan-btn"
              onClick={() => {
                const notice = createEChallanFromReport(report, urls);
                setSelectedChallan(notice);
                setSelected(null);
              }}
              title="Generate official Indian traffic e-Challan with photo evidence and fine calculation"
            >
              📄 Generate e-Challan
            </button>
            <button
              disabled={!reviewEnabled || pending === report.reportId}
              onClick={() => onReview(report, "noted")}
            >
              Mark noted
            </button>
            <button
              disabled={!reviewEnabled || pending === report.reportId}
              onClick={() => onReview(report, "dismissed")}
            >
              Dismiss
            </button>
          </div>
          {pending === report.reportId && (
            <p role="status">Waiting for camera confirmation…</p>
          )}
        </Drawer>
      )}
      {selectedChallan && (
        <ChallanModal
          challan={selectedChallan}
          onClose={() => setSelectedChallan(null)}
        />
      )}
    </section>
  );
}
