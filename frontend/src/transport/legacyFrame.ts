import type { FrameResult } from "../../../shared/src/schemas";

/**
 * Project an analysed frame down to the header a relay deployed before the
 * vehicle-intelligence pass will accept.
 *
 * `FrameSchema` and `TrackSchema` are both strict, and a header the relay
 * cannot parse does not merely get dropped - it disconnects the camera. So
 * every field added by this release has to come off, at both levels. Missing
 * the per-track ones is exactly the mistake this function exists to prevent:
 * the frame-level fields alone looked sufficient, and were not, because a frame
 * carrying any track still failed.
 *
 * The cost is only that a viewer on an old relay loses mode, selection and
 * motion. Nothing measured changes, and the camera stays connected.
 */
export function legacyFrame(result: FrameResult): FrameResult {
  const {
    mode: _mode,
    selectedTrackId: _selectedTrackId,
    tracks,
    ...rest
  } = result;
  return {
    ...rest,
    tracks: tracks.map((track) => {
      const {
        motion: _motion,
        trackState: _trackState,
        observedMs: _observedMs,
        ...legacyTrack
      } = track;
      return legacyTrack;
    }),
  } as FrameResult;
}

/** Field names this release added, at each level. Asserted by the tests. */
export const ADDED_FRAME_FIELDS = ["mode", "selectedTrackId"] as const;
export const ADDED_TRACK_FIELDS = [
  "motion",
  "trackState",
  "observedMs",
] as const;
