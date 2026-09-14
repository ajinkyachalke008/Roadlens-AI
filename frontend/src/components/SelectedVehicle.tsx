import type { CameraPolicy, TrackView } from "../../../shared/src/schemas";
import type { PlateTrackState } from "../plates/capture";
import { displaySpeed, type SpeedUnit } from "./speedUnits";

/**
 * What the operator learns by tapping a vehicle.
 *
 * This is the layer the product was missing: boxes told you a vehicle existed
 * and nothing else. Everything shown here is either measured or explicitly
 * marked unavailable - the card never fills a gap with a plausible-looking
 * number, because a speed that is actually unavailable is the one thing a
 * traffic tool must not invent.
 */
export interface SelectedVehicleProps {
  track: TrackView | null;
  /** True when the selected identity is no longer in the analysed frame. */
  lost: boolean;
  plate: PlateTrackState | null;
  plateAvailable: boolean;
  mode: {
    operating: "handheld" | "mounted";
    speedActive: boolean;
    reason: string;
  };
  policy: CameraPolicy;
  speedUnit: SpeedUnit;
  onAnalyzePlate: () => void;
  onClear: () => void;
  onSaveObservation?: () => void;
  onScanIndianPlate?: () => void;
  isScanningIndianPlate?: boolean;
  indianPlateResult?: string | null;
  indianPlateDetail?: string | null;
}

const MOTION: Record<string, string> = {
  approaching: "Approaching",
  receding: "Receding",
  left: "Moving left",
  right: "Moving right",
  stationary: "Stationary in frame",
  unknown: "Establishing motion",
};

/**
 * Why speed is unavailable, in the operator's language. Each maps to a real
 * gate in the speed estimator or the operating-mode check, so the card can
 * never claim a cause the system did not actually hit.
 */
const SPEED_REASON: Record<string, string> = {
  handheld: "Mount and calibrate for speed",
  not_calibrated: "Mounted · calibration required",
  calibration_invalid: "Calibration no longer valid",
  camera_moved: "Camera moved · recalibrate",
  background_unverified: "Verifying the camera is still",
  track_ambiguous: "Vehicle too ambiguous to measure",
  insufficient_samples: "Gathering measurement samples",
  sampling_too_sparse: "Analysis too sparse to measure",
  insufficient_displacement: "Not enough travel to measure",
  outside_zone: "Outside the calibrated zone",
  residual_too_high: "Motion did not fit a straight path",
  implausible_motion: "Measurement rejected as implausible",
  inconsistent_direction: "Direction reversed during measurement",
  time_discontinuity: "Timing broke during measurement",
  paused: "Paused",
};

const plateLine = (plate: PlateTrackState | null) => {
  if (!plate || plate.status === "idle") return "Not analyzed";
  if (plate.status === "unavailable") return "Plate unavailable";
  if (plate.status === "pending" || plate.status === "unreadable")
    return plate.candidateText
      ? `Possible ${plate.candidateText} · unconfirmed (${plate.candidateSupportingFrames ?? 1} frame)`
      : plate.status === "pending"
        ? "Analyzing clearer frames…"
        : "Unreadable";
  return `${plate.plateText} · ${Math.round((plate.plateConfidence ?? 0) * 100)}%`;
};

export function SelectedVehicle({
  track,
  lost,
  plate,
  plateAvailable,
  mode,
  policy,
  speedUnit,
  onAnalyzePlate,
  onClear,
  onSaveObservation,
  onScanIndianPlate,
  isScanningIndianPlate = false,
  indianPlateResult = null,
  indianPlateDetail = null,
}: SelectedVehicleProps) {
  if (!track && !lost) return null;
  const over =
    track?.speedMps != null && policy.speedLimitMps != null
      ? track.speedMps - policy.speedLimitMps
      : null;
  const analyzing = plate?.status === "pending";
  return (
    <section className="selected-vehicle" aria-label="Selected vehicle">
      <div className="selected-head">
        <span className="eyebrow">SELECTED VEHICLE</span>
        <button aria-label="Clear selection" onClick={onClear}>
          ×
        </button>
      </div>
      {lost || !track ? (
        <p className="selected-lost" data-testid="selected-lost">
          Track lost. Tap another vehicle to inspect it.
        </p>
      ) : (
        <>
          <strong className="selected-title" data-testid="selected-title">
            {track.className.toUpperCase()} · ID {track.trackId}
          </strong>
          <dl className="selected-facts">
            <div>
              <dt>Detection</dt>
              <dd data-testid="selected-confidence">
                {Math.round(track.score * 100)}%
              </dd>
            </div>
            <div>
              <dt>Tracking</dt>
              <dd data-testid="selected-state">{track.trackState ?? "—"}</dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd data-testid="selected-observed">
                {track.observedMs != null
                  ? `${(track.observedMs / 1000).toFixed(1)} s`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Motion</dt>
              <dd data-testid="selected-motion">
                {MOTION[track.motion ?? "unknown"]}
              </dd>
            </div>
            <div className="selected-speed">
              <dt>Speed</dt>
              <dd data-testid="selected-speed">
                {track.speedMps !== null ? (
                  <>
                    <strong>{displaySpeed(track.speedMps, speedUnit)}</strong>
                    {policy.speedLimitMps !== null && (
                      <small>
                        {" "}
                        limit {displaySpeed(policy.speedLimitMps, speedUnit)}
                        {over !== null && over > 0
                          ? ` · +${displaySpeed(over, speedUnit)}`
                          : ""}
                      </small>
                    )}
                  </>
                ) : (
                  <span className="unavailable">
                    {SPEED_REASON[track.speedReason ?? mode.reason] ??
                      SPEED_REASON[mode.reason] ??
                      "Unavailable"}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>License Plate</dt>
              <dd data-testid="selected-plate">
                {indianPlateResult ? (
                  <span className="indian-plate-badge">
                    <strong>🇮🇳 {indianPlateResult}</strong>
                    {indianPlateDetail && <small> · {indianPlateDetail}</small>}
                  </span>
                ) : (
                  plateLine(plate)
                )}
              </dd>
            </div>
          </dl>
          <div className="actions">
            {onScanIndianPlate && (
              <button
                className="indian-plate-btn"
                onClick={onScanIndianPlate}
                disabled={isScanningIndianPlate}
                title="Scan Indian number plate from this vehicle in real-time"
              >
                {isScanningIndianPlate ? "🔍 Scanning Indian Plate..." : "🇮🇳 Scan Indian Number Plate"}
              </button>
            )}
            {onSaveObservation && (
              <button
                className="primary"
                onClick={onSaveObservation}
                title="Capture this vehicle into a report with photo"
              >
                📸 Capture Vehicle Report
              </button>
            )}
            {plateAvailable && (
              <button
                onClick={onAnalyzePlate}
                disabled={analyzing}
                data-testid="analyze-plate"
              >
                {analyzing ? "Analyzing plate…" : "Analyze plate"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
