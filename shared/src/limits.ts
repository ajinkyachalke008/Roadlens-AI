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
