import { LIMITS, PLATE_LIMITS } from "../../../shared/src/limits";
import {
  ReportSchema,
  FrameSchema,
  PolicySchema,
  type Report,
  type FrameResult,
  type CameraPolicy,
} from "../../../shared/src/schemas";
import { SHOWCASE_TRIGGER_REASON } from "../showcase/constants";
/** The optional plate half of a report, always supplied or omitted together. */
export type PlateFields = Pick<
  Report,
  | "plateStatus"
  | "plateText"
  | "plateConfidence"
  | "plateSupportingFrames"
  | "plateDetectorConfidence"
  | "plateCandidateText"
  | "plateCandidateConfidence"
  | "plateCandidateSupportingFrames"
  | "plateAttemptFrames"
  | "plateLocalizedFrames"
  | "plateReadableFrames"
>;
export interface ReportArtifactInput {
  blob: Blob;
  frameId: string;
  sourceTimeMs: number;
  width: number;
  height: number;
  quality: number;
  sharpness: number;
}
type ArtifactKind = "vehicle" | "plate";
export class SessionStore {
  readonly reports = new Map<string, Report>();
  private images = new Map<string, Blob>();
  private imageBytes = 0;
  private details = new Map<string, Blob>();
  private detailBytes = 0;
  private episodes = new Map<string, string>();
  constructor(private authoritative = true) {}
  onChange = () => {};
  onReport = (_report: Report) => {};
  upsert(report: Report) {
    ReportSchema.parse(report);
    const old = this.reports.get(report.reportId);
    if (old && old.revision >= report.revision) return false;
    if (
      old?.bestCapture &&
      (old.bestCapture.imageId !== report.bestCapture?.imageId ||
        report.bestCapture?.state === "evicted")
    )
      this.removeDetail(old.bestCapture.imageId);
    if (
      old?.bestPlateDetail &&
      (old.bestPlateDetail.imageId !== report.bestPlateDetail?.imageId ||
        report.bestPlateDetail?.state === "evicted")
    )
      this.removeDetail(old.bestPlateDetail.imageId);
    if (
      old?.evidenceId &&
      (old.evidenceId !== report.evidenceId ||
        report.evidenceState === "evicted")
    )
      this.removeImage(old.evidenceId);
    this.reports.set(report.reportId, structuredClone(report));
    while (this.reports.size > LIMITS.reports) {
      const first = this.reports.keys().next().value!;
      const evicted = this.reports.get(first)!;
      if (evicted.evidenceId) this.removeImage(evicted.evidenceId);
      if (evicted.bestCapture) this.removeDetail(evicted.bestCapture.imageId);
      if (evicted.bestPlateDetail)
        this.removeDetail(evicted.bestPlateDetail.imageId);
      this.reports.delete(first);
    }
    this.onChange();
    return true;
  }
  private removeImage(id: string) {
    const image = this.images.get(id);
    if (image) {
      this.imageBytes -= image.size;
      this.images.delete(id);
    }
  }
  private removeDetail(id: string) {
    const image = this.details.get(id);
    if (image) {
      this.detailBytes -= image.size;
      this.details.delete(id);
    }
  }
  retain(id: string, blob: Blob) {
    if (blob.size > LIMITS.evidenceBytes) return false;
    // Event evidence is historical: a later, prettier frame must never replace
    // the bytes associated with its original id.
    if (this.images.has(id)) return true;
    this.images.set(id, blob);
    this.imageBytes += blob.size;
    while (
      this.images.size > LIMITS.evidenceImages ||
      this.imageBytes > LIMITS.evidenceBytes
    ) {
      const first = this.images.keys().next().value!;
      this.removeImage(first);
      for (const report of this.reports.values())
        if (
          this.authoritative &&
          report.evidenceId === first &&
          report.evidenceState === "available"
        ) {
          const next = {
            ...report,
            evidenceState: "evicted" as const,
            revision: report.revision + 1,
            updatedAt: new Date().toISOString(),
          };
          this.reports.set(next.reportId, next);
          this.onReport(next);
        }
    }
    this.onChange();
    return true;
  }
  image(id: string) {
    const image = this.images.get(id) ?? this.details.get(id);
    if (this.images.has(id)) {
      this.images.delete(id);
      this.images.set(id, image!);
    } else if (this.details.has(id)) {
      this.details.delete(id);
      this.details.set(id, image!);
    }
    return image;
  }
  /** Retain an image returned by the camera under the matching RAM budget. */
  retainRequested(id: string, blob: Blob) {
    const detail = [...this.reports.values()].some(
      (report) =>
        report.bestCapture?.imageId === id ||
        report.bestPlateDetail?.imageId === id,
    );
    return detail ? this.retainDetail(id, blob) : this.retain(id, blob);
  }
  get evidenceCount() {
    return this.images.size;
  }
  get evidenceSize() {
    return this.imageBytes;
  }
  get detailCount() {
    return this.details.size;
  }
  get detailSize() {
    return this.detailBytes;
  }

  private retainDetail(id: string, blob: Blob) {
    if (blob.size > PLATE_LIMITS.jpegBytes) return false;
    this.removeDetail(id);
    this.details.set(id, blob);
    this.detailBytes += blob.size;
    while (
      this.details.size > PLATE_LIMITS.detailImages ||
      this.detailBytes > PLATE_LIMITS.detailBytes
    ) {
      const first = this.details.keys().next().value!;
      this.removeDetail(first);
      for (const report of this.reports.values()) {
        const key =
          report.bestCapture?.imageId === first
            ? "bestCapture"
            : report.bestPlateDetail?.imageId === first
              ? "bestPlateDetail"
              : null;
        if (!key || !this.authoritative) continue;
        const next: Report = {
          ...report,
          [key]: { ...report[key]!, state: "evicted" as const },
          revision: report.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        this.reports.set(next.reportId, next);
        this.onReport(next);
      }
    }
    this.onChange();
    return true;
  }

  /** Publish only meaningful best-capture replacements as report revisions. */
  applyArtifact(
    reportId: string,
    kind: ArtifactKind,
    artifact: ReportArtifactInput,
  ) {
    const initial = this.reports.get(reportId);
    if (!initial) return false;
    const key = kind === "vehicle" ? "bestCapture" : "bestPlateDetail";
    const previous = initial[key];
    const imageId = crypto.randomUUID();
    if (!this.retainDetail(imageId, artifact.blob)) return false;
    const old = this.reports.get(reportId);
    if (!old) {
      this.removeDetail(imageId);
      return false;
    }
    if (previous) this.removeDetail(previous.imageId);
    const next: Report = {
      ...old,
      [key]: {
        imageId,
        state: "available",
        frameId: artifact.frameId,
        sourceTimeMs: artifact.sourceTimeMs,
        width: artifact.width,
        height: artifact.height,
        quality: artifact.quality,
        sharpness: artifact.sharpness,
      },
      revision: old.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    ReportSchema.parse(next);
    this.reports.set(reportId, next);
    this.onChange();
    this.onReport(next);
    return true;
  }
  /**
   * Apply a plate consensus to an existing report.
   *
   * Consensus firms up over several frames, so a report is normally created
   * with `plateStatus: "pending"` and updated once. Revisions are only spent
   * when something actually changed, so a stable reading does not churn the
   * viewer, and a report that never had plate fields never gains them.
   */
  applyPlate(reportId: string, plate: PlateFields) {
    const old = this.reports.get(reportId);
    if (!old) return false;
    if (
      old.plateStatus === plate.plateStatus &&
      (old.plateText ?? null) === (plate.plateText ?? null) &&
      (old.plateConfidence ?? null) === (plate.plateConfidence ?? null) &&
      (old.plateSupportingFrames ?? 0) === (plate.plateSupportingFrames ?? 0) &&
      (old.plateDetectorConfidence ?? null) ===
        (plate.plateDetectorConfidence ?? null) &&
      (old.plateCandidateText ?? null) === (plate.plateCandidateText ?? null) &&
      (old.plateCandidateConfidence ?? null) ===
        (plate.plateCandidateConfidence ?? null) &&
      (old.plateCandidateSupportingFrames ?? 0) ===
        (plate.plateCandidateSupportingFrames ?? 0) &&
      (old.plateAttemptFrames ?? 0) === (plate.plateAttemptFrames ?? 0) &&
      (old.plateLocalizedFrames ?? 0) === (plate.plateLocalizedFrames ?? 0) &&
      (old.plateReadableFrames ?? 0) === (plate.plateReadableFrames ?? 0)
    )
      return false;
    const next: Report = {
      ...old,
      ...plate,
      revision: old.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    ReportSchema.parse(next);
    this.reports.set(reportId, next);
    this.onChange();
    this.onReport(next);
    return true;
  }
  save(
    frame: FrameResult,
    policy: CameraPolicy,
    blob?: Blob,
    kind: Report["kind"] = "observation",
    trackId?: number,
    reportId: string = crypto.randomUUID(),
    summary?: Report["evidenceSummary"],
    plate?: PlateFields,
    trigger?: "showcase",
  ) {
    const old = this.reports.get(reportId);
    if (old) return structuredClone(old);
    FrameSchema.parse(frame);
    PolicySchema.parse(policy);
    if (policy.version !== frame.policyVersion)
      throw new Error("Report policy does not match the analyzed frame");
    const track =
      trackId === undefined
        ? frame.tracks.find((t) => t.observed)
        : frame.tracks.find((t) => t.trackId === trackId && t.observed);
    if (trackId !== undefined && !track)
      throw new Error("Selected track was not observed in this frame");
    if (kind !== "observation" && !track)
      throw new Error("A candidate requires an observed track");
    const now = new Date().toISOString();
    const evidenceId =
      blob && blob.size <= LIMITS.evidenceBytes ? crypto.randomUUID() : null;
    const validityReasons = !track
      ? ["no_observed_object"]
      : track.speedReason
        ? [track.speedReason]
        : [];
    if (trigger === "showcase" && kind === "observation")
      validityReasons.push(SHOWCASE_TRIGGER_REASON);
    const report: Report = {
      reportId,
      revision: 0,
      sourceId: frame.sourceId,
      captureEpoch: frame.captureEpoch,
      frameId: frame.frameId,
      trackId: track?.trackId ?? null,
      sourceMode: frame.sourceMode,
      sourceTimeMs: frame.sourceTimeMs,
      capturedAtIso: frame.capturedAtIso,
      kind,
      className: track?.className ?? null,
      score: track?.score ?? null,
      speedMps: track?.speedMps ?? null,
      policy: structuredClone(policy),
      calibrationVersion: frame.calibrationVersion,
      modelId: frame.modelId,
      modelSha256: frame.modelSha256,
      detectorProfile: frame.detectorProfile,
      trackerVersion: frame.trackerVersion,
      validityReasons,
      evidenceSummary: summary ?? {
        trajectory: [],
        residualM: null,
        coverageMs: null,
      },
      // Omitted entirely when plate recognition never ran for this report, so
      // the serialized shape stays identical to a build without the feature.
      ...(plate ?? {}),
      evidenceId,
      evidenceState: evidenceId ? "available" : "none",
      review: "pending",
      createdAt: now,
      updatedAt: now,
    };
    ReportSchema.parse(report);
    if (evidenceId && blob) this.retain(evidenceId, blob);
    this.upsert(report);
    this.onReport(report);
    return report;
  }

  /**
   * Promote the one Showcase observation when its locked track later becomes a
   * genuine speed candidate. The report identity is retained, its facts and
   * bounded evidence move to the qualifying frame, and viewers receive a normal
   * higher-revision upsert instead of a confusing duplicate.
   */
  upgradeToSpeedCandidate(
    reportId: string,
    frame: FrameResult,
    policy: CameraPolicy,
    trackId: number,
    summary: Report["evidenceSummary"],
    blob?: Blob,
    plate?: PlateFields,
  ) {
    const old = this.reports.get(reportId);
    if (!old || old.kind === "speed_candidate") return false;
    FrameSchema.parse(frame);
    PolicySchema.parse(policy);
    if (policy.version !== frame.policyVersion)
      throw new Error("Report policy does not match the analyzed frame");
    const track = frame.tracks.find(
      (candidate) => candidate.trackId === trackId && candidate.observed,
    );
    if (!track || track.speedMps === null || frame.calibrationVersion === null)
      throw new Error("A speed candidate requires a qualified observed track");
    // The original event image remains immutable. Improving vehicle/plate
    // imagery is published through applyArtifact under a different image id.
    const next: Report = {
      ...old,
      revision: old.revision + 1,
      trackId,
      kind: "speed_candidate",
      className: track.className,
      score: track.score,
      speedMps: track.speedMps,
      policy: structuredClone(policy),
      calibrationVersion: frame.calibrationVersion,
      measurementFrameId: frame.frameId,
      measurementSourceTimeMs: frame.sourceTimeMs,
      validityReasons: [],
      evidenceSummary: structuredClone(summary),
      ...(plate ?? {}),
      updatedAt: new Date().toISOString(),
    };
    ReportSchema.parse(next);
    this.reports.set(reportId, next);
    this.onChange();
    this.onReport(next);
    return true;
  }
  review(id: string, revision: number, review: Report["review"]) {
    const old = this.reports.get(id);
    if (!old) return "report_unavailable" as const;
    if (old.revision !== revision) return "revision_conflict" as const;
    const next = {
      ...old,
      revision: old.revision + 1,
      review,
      updatedAt: new Date().toISOString(),
    };
    this.upsert(next);
    this.onReport(next);
    return "ok" as const;
  }
  snapshot() {
    return [...this.reports.values()].map((r) => structuredClone(r));
  }
  episodeId(key: string, preferredId?: string) {
    const existing = this.episodes.get(key);
    if (existing) return existing;
    if (this.episodes.size >= 1000) return null;
    const id = preferredId ?? crypto.randomUUID();
    this.episodes.set(key, id);
    return id;
  }
  clear() {
    this.reports.clear();
    this.images.clear();
    this.imageBytes = 0;
    this.details.clear();
    this.detailBytes = 0;
    this.episodes.clear();
    this.onChange();
  }
}
