import { describe, expect, it } from "vitest";
import {
  ADDED_FRAME_FIELDS,
  ADDED_TRACK_FIELDS,
  legacyFrame,
} from "../../frontend/src/transport/legacyFrame";
import { FrameSchema } from "../../shared/src/schemas";
import { frame as frameFixture } from "../contracts/fixtures";
import type { FrameResult } from "../../shared/src/schemas";

/**
 * A relay deployed before this release parses the analysis header with a strict
 * schema, and a header it cannot parse disconnects the camera rather than being
 * dropped. So the projection has to remove every field this release added, at
 * both the frame and the track level.
 *
 * The frame-level fields alone were not enough in production: a frame carrying
 * any track still failed, because TrackSchema is strict too. These tests exist
 * so that is caught here instead.
 */
const enriched = (): FrameResult => {
  const base = frameFixture(1);
  return {
    ...base,
    mode: {
      operating: "mounted" as const,
      speedActive: true,
      reason: "speed_active",
    },
    selectedTrackId: 7,
    tracks: [
      {
        trackId: 7,
        className: "car" as const,
        score: 0.91,
        bbox: [0.2, 0.3, 0.4, 0.5] as [number, number, number, number],
        observed: true,
        speedMps: null,
        speedStatus: "unavailable" as const,
        speedReason: "handheld",
        ruleState: "unmeasured" as const,
        motion: "right" as const,
        trackState: "confirmed" as const,
        observedMs: 2400,
      },
    ],
  };
};

/**
 * What an older relay accepts, expressed the way its strict schema behaves: any
 * key outside the known set is a parse failure. Emulated rather than imported,
 * because that schema no longer exists in this tree.
 */
const PRIOR_FRAME_KEYS = Object.keys(frameFixture(1));
const PRIOR_TRACK_KEYS = [
  "trackId",
  "className",
  "score",
  "bbox",
  "observed",
  "speedMps",
  "speedStatus",
  "speedReason",
  "ruleState",
];
function parseAsOlderRelay(result: FrameResult) {
  const unknown = Object.keys(result).filter(
    (key) => !PRIOR_FRAME_KEYS.includes(key),
  );
  if (unknown.length)
    throw new Error(`unrecognized_keys: ${unknown.join(", ")}`);
  for (const track of result.tracks) {
    const extra = Object.keys(track).filter(
      (key) => !PRIOR_TRACK_KEYS.includes(key),
    );
    if (extra.length)
      throw new Error(`unrecognized_track_keys: ${extra.join(", ")}`);
  }
  return result;
}

describe("legacy analysis-frame projection", () => {
  it("removes every field this release added", () => {
    const legacy = legacyFrame(enriched()) as unknown as Record<string, unknown>;
    for (const field of ADDED_FRAME_FIELDS)
      expect(legacy).not.toHaveProperty(field);
    for (const track of legacy.tracks as Record<string, unknown>[])
      for (const field of ADDED_TRACK_FIELDS)
        expect(track).not.toHaveProperty(field);
  });

  it("still parses under the schema an older relay validates with", () => {
    expect(() => parseAsOlderRelay(legacyFrame(enriched()))).not.toThrow();
  });

  it("proves the unprojected frame would be refused by that relay", () => {
    // If this ever stops throwing, the negotiation is no longer load-bearing
    // and the projection can go - but not before.
    expect(() => parseAsOlderRelay(enriched())).toThrow(/unrecognized_keys/);
    expect(() =>
      parseAsOlderRelay({ ...enriched(), mode: undefined, selectedTrackId: undefined } as unknown as FrameResult),
    ).toThrow(/unrecognized/);
  });

  it("keeps every measured field untouched", () => {
    const original = enriched();
    const legacy = legacyFrame(original);
    expect(legacy.frameId).toBe(original.frameId);
    expect(legacy.sourceTimeMs).toBe(original.sourceTimeMs);
    expect(legacy.trackerVersion).toBe(original.trackerVersion);
    expect(legacy.stats).toEqual(original.stats);
    expect(legacy.tracks[0]!.trackId).toBe(7);
    expect(legacy.tracks[0]!.bbox).toEqual([0.2, 0.3, 0.4, 0.5]);
    expect(legacy.tracks[0]!.speedMps).toBeNull();
  });

  it("is still a valid current frame, so a new relay accepts it too", () => {
    expect(() => FrameSchema.parse(legacyFrame(enriched()))).not.toThrow();
  });

  it("does not mutate the frame the camera keeps", () => {
    const original = enriched();
    legacyFrame(original);
    expect(original.mode).toBeDefined();
    expect(original.tracks[0]!.motion).toBe("right");
  });
});
