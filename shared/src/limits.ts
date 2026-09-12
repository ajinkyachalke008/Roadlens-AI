export const LIMITS = Object.freeze({
  rooms: 10,
  viewers: 2,
  codeTtlMs: 600_000,
  roomTtlMs: 3_600_000,
  ownerGraceMs: 45_000,
  helloMs: 5_000,
  heartbeatMs: 15_000,
  staleMs: 45_000,
  reservationMs: 20_000,
  requestMs: 10_000,
  requests: 16,
  textBytes: 32 * 1024,
  headerBytes: 32 * 1024,
  jpegTarget: 80 * 1024,
  jpegBytes: 128 * 1024,
  messageBytes: 192 * 1024,
  imageEdge: 640,
  previewHz: 2,
  bufferBytes: 256 * 1024,
  reports: 200,
  evidenceImages: 20,
  evidenceBytes: 8 * 1024 * 1024,
  tracks: 100,
  observations: 32,
  snapshotReports: 10,
  roomBytes: 128 * 1024 * 1024,
  processBytes: 256 * 1024 * 1024,
  rateEntries: 2048,
});

/** Analysis transport is separate from the 1 Hz viewer preview budget. */
export const GPU_LIMITS = Object.freeze({
  headerBytes: 4096,
  jpegBytes: 192 * 1024,
  jpegTarget: 80 * 1024,
  messageBytes: 256 * 1024,
  textBytes: 32 * 1024,
  imageEdge: 960,
  defaultEdge: 640,
  maxHz: 15,
  targetHz: 10,
  /**
   * Bounded analysis pipeline depth. The camera, the relay lease and the worker
   * each enforce this same ceiling, so no stage can build a queue: the worker
   * runs one CUDA call with at most one newest frame waiting behind it.
   */
  maxInFlight: 2,
  /**
   * Hard freshness ceiling for a completed analysis result, measured from
   * capture to arrival back at the camera. Beyond this the result is discarded
   * entirely: not displayed, not tracked, never a speed or candidate input.
   * Set at the overlay staleness ceiling, because a result older than that can
   * never be presented as live anyway. See docs/LATENCY_POLICY.md.
   */
  maxResultAgeMs: 700,
  frameTimeoutMs: 2000,
  helloMs: 5000,
  heartbeatMs: 15000,
  staleMs: 45000,
});

/**
 * Plate recognition is deliberately the lowest-priority work in the system.
 * Every bound here exists so that an unreadable, absent or slow plate pipeline
 * can never degrade traffic detection: at most one plate task exists anywhere
 * at a time, each track contributes a small fixed number of candidate crops,
 * and a session can only ever have a handful of tracks under analysis.
 */
export const PLATE_LIMITS = Object.freeze({
  headerBytes: 2048,
  /** A vehicle crop is a small region, so it needs far fewer bytes than a frame. */
  jpegTarget: 48 * 1024,
  jpegBytes: 96 * 1024,
  messageBytes: 128 * 1024,
  /**
   * Long edge of the encoded vehicle crop. The crop is taken from the full
   * resolution source frame, so 640 px across one vehicle carries far more
   * plate detail than the same vehicle inside a 640 px wide analysis frame.
   */
  cropEdge: 640,
  /** Below this the crop cannot hold a legible plate; do not spend GPU on it. */
  minCropEdge: 64,
  /** One plate task in flight, system wide. The camera, relay and worker agree. */
  maxInFlight: 1,
  /** Bounded candidate crops retained and submitted per track. */
  framesPerTrack: 4,
  /** Quality-aware Showcase candidates considered over time; only top-K stay. */
  adaptiveFrames: 8,
  /** Raw report-target crops retained briefly for one bounded rescue pass. */
  rescueFrames: 8,
  rescueReports: 2,
  /** Source-time collection window and hard wall-clock privacy TTL. */
  captureWindowMs: 4_800,
  rescueTtlMs: 9_000,
  rescueBytes: 8 * 96 * 1024,
  rescueRetriesPerCrop: 1,
  /** Roughly 3 Hz source sampling, with slower OCR admission for GPU headroom. */
  captureIntervalMs: 320,
  adaptiveSubmissionIntervalMs: 600,
  cropReplacementEpsilon: 0.025,
  previewImprovementEpsilon: 0.04,
  previewUpdates: 4,
  /** Final report-detail images have a separate RAM cap from event evidence. */
  detailImages: 16,
  detailBytes: 2 * 1024 * 1024,
  /** Bounded number of tracks under plate analysis at once. */
  tracks: 8,
  /** Submission floor, independent of the analysis rate. */
  minIntervalMs: 220,
  requestTimeoutMs: 3000,
  /**
   * How long a track may stay "Analyzing…" before the current consensus is
   * reported as final. A vehicle can leave, turn away, or simply never present
   * a readable plate, and neither the operator nor a report may wait forever
   * for a verdict that is not coming.
   */
  analysisDeadlineMs: 9000,
  /** Consensus needs genuine agreement, not one lucky read. */
  minSupportingFrames: 2,
  /** Below this the consensus is reported as unreadable rather than guessed. */
  minConfidence: 0.55,
  minTextLength: 2,
  maxTextLength: 10,
  /** A transparent single-frame candidate is never the confirmed plate field. */
  candidateConfidence: 0.88,
  candidateDetectorConfidence: 0.5,
  candidateQuality: 0.55,
});
