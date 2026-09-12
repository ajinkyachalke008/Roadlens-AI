/**
 * Tracker adapters under evaluation.
 *
 * Every adapter sees exactly the same detections at the same source times, so
 * differences in the metrics are differences in association, never in input.
 */
import { TimeAwareTracker } from "../../frontend/src/tracking/tracker";
import { TimeAwareTrackerV2 } from "../../frontend/src/tracking/trackerV2";
import { ByteTrackReference, BotSortReference } from "./reference";
import type { Scenario } from "./scenarios";
import type { TrackerRun, TrackerOutput } from "./metrics";

const EPOCH = "evaluation-epoch";

export const runV1: TrackerRun = (scenario: Scenario) => {
  const tracker = new TimeAwareTracker();
  return scenario.frames.map((frame) =>
    tracker
      .update(frame.detections, frame.sourceTimeMs, EPOCH, false)
      .map<TrackerOutput>((t) => ({
        trackId: t.trackId,
        bbox: t.bbox,
        observed: t.observed,
      })),
  );
};

export const runV2: TrackerRun = (scenario: Scenario) => {
  const tracker = new TimeAwareTrackerV2();
  return scenario.frames.map((frame) =>
    tracker
      .update(frame.detections, frame.sourceTimeMs, EPOCH, false)
      .map<TrackerOutput>((t) => ({
        trackId: t.trackId,
        bbox: t.bbox,
        observed: t.observed,
      })),
  );
};

export const runByteTrack: TrackerRun = (scenario: Scenario) => {
  const tracker = new ByteTrackReference();
  return scenario.frames.map((frame) =>
    tracker.update(frame.detections, frame.sourceTimeMs),
  );
};

export const runBotSort: TrackerRun = (scenario: Scenario) => {
  const tracker = new BotSortReference();
  return scenario.frames.map((frame) =>
    tracker.update(frame.detections, frame.sourceTimeMs),
  );
};

export const TRACKERS: { name: string; run: TrackerRun }[] = [
  { name: "time_aware_iou_v1", run: runV1 },
  { name: "bytetrack_reference", run: runByteTrack },
  { name: "botsort_reference", run: runBotSort },
  { name: "time_aware_iou_v2", run: runV2 },
];
