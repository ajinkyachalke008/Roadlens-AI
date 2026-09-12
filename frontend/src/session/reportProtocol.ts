import { PLATE_LIMITS } from "../../../shared/src/limits";
import type { Report } from "../../../shared/src/schemas";

/**
 * Relays deployed before the adaptive-capture report extension use a strict
 * schema. Keep pairing usable during a backend-first rollout by removing only
 * fields they do not understand and clamping the former four-frame maximum.
 */
export function reportForProtocol(report: Report, protocol: number): Report {
  if (protocol >= 2) return report;
  const {
    plateCandidateText: _plateCandidateText,
    plateCandidateConfidence: _plateCandidateConfidence,
    plateCandidateSupportingFrames: _plateCandidateSupportingFrames,
    plateAttemptFrames: _plateAttemptFrames,
    plateLocalizedFrames: _plateLocalizedFrames,
    plateReadableFrames: _plateReadableFrames,
    bestCapture: _bestCapture,
    bestPlateDetail: _bestPlateDetail,
    measurementFrameId: _measurementFrameId,
    measurementSourceTimeMs: _measurementSourceTimeMs,
    ...legacy
  } = report;
  return {
    ...legacy,
    ...(typeof legacy.plateSupportingFrames === "number"
      ? {
          plateSupportingFrames: Math.min(
            legacy.plateSupportingFrames,
            PLATE_LIMITS.framesPerTrack,
          ),
        }
      : {}),
  };
}
