import type { PlateFields } from "../session/store";
import type { PlateTrackState } from "./capture";

/**
 * Project a track's live plate state onto the optional report fields.
 *
 * Returning `null` means "say nothing": a track that never entered the plate
 * pipeline leaves the report exactly as a build without this feature would have
 * written it, rather than carrying empty plate columns around.
 */
export function plateFields(state: PlateTrackState): PlateFields | null {
  if (state.status === "idle") return null;
  if (state.status === "read" && state.plateText)
    return {
      plateStatus: "read",
      plateText: state.plateText,
      plateConfidence: state.plateConfidence,
      plateSupportingFrames: state.supportingFrames,
      plateDetectorConfidence: state.detectorConfidence,
    };
  return {
    plateStatus: state.status === "read" ? "unreadable" : state.status,
    plateText: null,
    plateConfidence: null,
    plateSupportingFrames:
      state.status === "unavailable" ? 0 : state.supportingFrames,
    plateDetectorConfidence:
      state.status === "unavailable" ? null : state.detectorConfidence,
  };
}
