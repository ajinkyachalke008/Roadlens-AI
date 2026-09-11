/**
 * Camera frame-rate choices are derived from the actual track, never assumed.
 * A rate is offered only when the track's own capabilities admit it, and the
 * rate shown as current is always the one the browser reports back.
 */
export const FRAME_RATE_CANDIDATES = Object.freeze([24, 30, 60, 90, 120]);

export type FrameRateChoice = "auto" | number;

const round = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;

/**
 * Selectable rates for one video track. With no capability information the
 * only offer is what the track already reports: nothing is invented.
 */
export function frameRateOptions(
  capabilities?: { frameRate?: { min?: number; max?: number } } | null,
  settings?: { frameRate?: number } | null,
): number[] {
  const current = round(settings?.frameRate);
  const max = capabilities?.frameRate?.max;
  const min = capabilities?.frameRate?.min;
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0)
    return current ? [current] : [];
  const floor = typeof min === "number" && Number.isFinite(min) ? min : 0;
  const options = FRAME_RATE_CANDIDATES.filter(
    (value) => value <= max + 0.5 && value >= floor - 0.5,
  );
  if (current && current <= max + 0.5 && !options.includes(current))
    options.push(current);
  return [...new Set(options)].sort((a, b) => a - b);
}

export interface FrameRateStatus {
  /** What the operator asked for. */
  requested: FrameRateChoice;
  /** What MediaTrackSettings reports after the request. */
  actual: number | null;
  options: number[];
  supported: boolean;
  note: string;
}

/** Human-readable state; never claims a rate the track did not report. */
export function frameRateNote(
  requested: FrameRateChoice,
  actual: number | null,
): string {
  if (actual === null) return "Actual rate unavailable";
  if (requested === "auto") return `Automatic · ${actual.toFixed(1)} FPS`;
  return Math.abs(actual - requested) < 0.6
    ? `${actual.toFixed(1)} FPS`
    : `Requested ${requested}; camera selected ${actual.toFixed(1)} FPS`;
}
