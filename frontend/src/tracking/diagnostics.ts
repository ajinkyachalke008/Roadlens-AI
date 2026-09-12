/**
 * Development-only tracker instrumentation.
 *
 * A sink is attached explicitly, so production runs with no diagnostic work at
 * all: the tracker calls the sink only when one exists. Nothing here records
 * pixels, plate text or any image content - only geometry, timing and the
 * reason an association was refused.
 */
import type { Box, ClassName } from "./tracker";

/** Why a track/detection pair was refused before assignment. */
export type RejectionReason =
  | "class_mismatch"
  | "iou_below_gate"
  | "predicted_center_far"
  | "motion_gate"
  | "scale_mismatch"
  | "assignment_cost";

/** Why a detection became a new identity instead of continuing one. */
export type NewTrackReason =
  | "no_candidate_track"
  | "all_candidates_gated"
  | "assignment_lost"
  | "capacity_evicted";

export interface AssociationDiagnostic {
  kind: "association";
  sourceTimeMs: number;
  trackId: number;
  trackClass: ClassName;
  detectionClass: ClassName;
  previousBox: Box;
  predictedBox: Box;
  candidateBox: Box;
  iou: number;
  centerDistance: number;
  /** Centre distance in units of the track's own box diagonal. */
  relativeDistance: number;
  timeGapMs: number;
  score: number;
  cost: number;
  accepted: boolean;
  rejection: RejectionReason | null;
  trackState: "tentative" | "confirmed" | "lost";
}

export interface NewTrackDiagnostic {
  kind: "new_track";
  sourceTimeMs: number;
  trackId: number;
  className: ClassName;
  bbox: Box;
  score: number;
  reason: NewTrackReason;
  /** Best refused candidate, when one existed. Explains the fragmentation. */
  nearestRejection: RejectionReason | null;
  nearestIou: number;
  nearestRelativeDistance: number;
}

export interface ResetDiagnostic {
  kind: "reset";
  sourceTimeMs: number;
  reason: "epoch_changed" | "time_not_advancing" | "explicit";
}

export type TrackerDiagnostic =
  | AssociationDiagnostic
  | NewTrackDiagnostic
  | ResetDiagnostic;

export type DiagnosticSink = (event: TrackerDiagnostic) => void;

/** Bounded in-memory collector for the Advanced Diagnostics panel and tests. */
export class DiagnosticRecorder {
  readonly events: TrackerDiagnostic[] = [];
  constructor(private readonly limit = 2000) {}
  readonly sink: DiagnosticSink = (event) => {
    this.events.push(event);
    if (this.events.length > this.limit)
      this.events.splice(0, this.events.length - this.limit);
  };
  clear() {
    this.events.length = 0;
  }
  /** New identities grouped by the reason their best candidate was refused. */
  fragmentationCauses(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.events) {
      if (event.kind !== "new_track") continue;
      const key = event.nearestRejection ?? event.reason;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
}
