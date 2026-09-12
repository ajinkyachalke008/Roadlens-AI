import { describe, expect, it } from "vitest";
import { reportForProtocol } from "../../frontend/src/session/reportProtocol";
import { ReportSchema } from "../../shared/src/schemas";
import { report, uuid } from "../contracts/fixtures";

describe("adaptive report protocol negotiation", () => {
  const adaptive = () =>
    ReportSchema.parse({
      ...report(),
      plateStatus: "pending",
      plateText: null,
      plateConfidence: null,
      plateSupportingFrames: 6,
      plateDetectorConfidence: 0.9,
      plateCandidateText: "ABC1234",
      plateCandidateConfidence: 0.94,
      plateCandidateSupportingFrames: 1,
      plateAttemptFrames: 6,
      plateLocalizedFrames: 4,
      plateReadableFrames: 1,
      bestCapture: {
        imageId: uuid(99),
        state: "available",
        frameId: report().frameId,
        sourceTimeMs: report().sourceTimeMs,
        width: 900,
        height: 480,
        quality: 0.81,
        sharpness: 12,
      },
    });

  it("keeps adaptive fields for a relay that advertises revision 2", () => {
    expect(reportForProtocol(adaptive(), 2)).toEqual(adaptive());
  });

  it("strips new strict-schema fields for an older relay", () => {
    const legacy = reportForProtocol(adaptive(), 1) as Record<string, unknown>;
    expect(legacy).not.toHaveProperty("bestCapture");
    expect(legacy).not.toHaveProperty("plateCandidateText");
    expect(legacy).not.toHaveProperty("plateAttemptFrames");
    expect(legacy.plateSupportingFrames).toBe(4);
  });
});
