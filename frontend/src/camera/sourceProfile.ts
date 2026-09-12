export type CameraSourceProfile = "standard" | "showcase";

export const CAMERA_SOURCE_PROFILES = Object.freeze({
  standard: { width: 1280, height: 720, frameRate: null },
  showcase: { width: 1920, height: 1080, frameRate: 30 },
});

type Range = { min?: number; max?: number };
export interface CameraCapabilitiesLike {
  width?: Range;
  height?: Range;
  frameRate?: Range;
  focusMode?: string[];
  exposureMode?: string[];
}
export interface CameraSettingsLike {
  width?: number;
  height?: number;
  frameRate?: number;
  focusMode?: string;
  exposureMode?: string;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * A preference, never a promise. Ideal constraints let the browser choose a
 * supported fallback, which is important on Safari devices that expose little
 * or no capability detail.
 */
export function cameraSourceConstraints(
  profile: CameraSourceProfile,
): MediaTrackConstraints {
  const selected = CAMERA_SOURCE_PROFILES[profile];
  return {
    facingMode: { ideal: "environment" },
    width: { ideal: selected.width },
    height: { ideal: selected.height },
    ...(selected.frameRate === null
      ? {}
      : { frameRate: { ideal: selected.frameRate } }),
  };
}

export interface CameraSourceStatus {
  profile: CameraSourceProfile;
  requestedWidth: number;
  requestedHeight: number;
  actualWidth: number | null;
  actualHeight: number | null;
  actualFrameRate: number | null;
  capabilityWidthMax: number | null;
  capabilityHeightMax: number | null;
  capabilityFrameRateMax: number | null;
  supports1080: boolean | null;
  focusMode: string | null;
  continuousFocusAvailable: boolean | null;
  exposureMode: string | null;
  note: string;
}

/** Report what the camera actually selected; capabilities are advisory only. */
export function cameraSourceStatus(
  profile: CameraSourceProfile,
  capabilities?: CameraCapabilitiesLike | null,
  settings?: CameraSettingsLike | null,
  videoSize?: { width: number; height: number } | null,
): CameraSourceStatus {
  const requested = CAMERA_SOURCE_PROFILES[profile];
  const actualWidth = finite(settings?.width)
    ? settings.width
    : finite(videoSize?.width)
      ? videoSize.width
      : null;
  const actualHeight = finite(settings?.height)
    ? settings.height
    : finite(videoSize?.height)
      ? videoSize.height
      : null;
  const widthMax = finite(capabilities?.width?.max)
    ? capabilities.width.max
    : null;
  const heightMax = finite(capabilities?.height?.max)
    ? capabilities.height.max
    : null;
  const supports1080 =
    widthMax === null || heightMax === null
      ? null
      : widthMax >= 1920 && heightMax >= 1080;
  const focusModes = Array.isArray(capabilities?.focusMode)
    ? capabilities.focusMode
    : null;
  const selected =
    actualWidth && actualHeight
      ? `${actualWidth} × ${actualHeight}`
      : "unknown";
  return {
    profile,
    requestedWidth: requested.width,
    requestedHeight: requested.height,
    actualWidth,
    actualHeight,
    actualFrameRate: finite(settings?.frameRate) ? settings.frameRate : null,
    capabilityWidthMax: widthMax,
    capabilityHeightMax: heightMax,
    capabilityFrameRateMax: finite(capabilities?.frameRate?.max)
      ? capabilities.frameRate.max
      : null,
    supports1080,
    focusMode:
      typeof settings?.focusMode === "string" ? settings.focusMode : null,
    continuousFocusAvailable: focusModes
      ? focusModes.includes("continuous")
      : null,
    exposureMode:
      typeof settings?.exposureMode === "string" ? settings.exposureMode : null,
    note:
      profile === "showcase"
        ? `${selected} actual · 1080p-class / 30 FPS preferred`
        : `${selected} actual · standard profile`,
  };
}
