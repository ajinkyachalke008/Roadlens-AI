import { describe, it, expect } from "vitest";
import { routeVoiceTranscript } from "../../frontend/src/voice/voiceCommandRouter";

describe("Voice Command & Traffic Query Router", () => {
  it("routes direct operational camera commands", () => {
    expect(routeVoiceTranscript("scan plate")).toEqual({
      type: "command",
      action: "scan_plate",
      rawTranscript: "scan plate",
    });

    expect(routeVoiceTranscript("SCAN NOW")).toEqual({
      type: "command",
      action: "scan_plate",
      rawTranscript: "SCAN NOW",
    });

    expect(routeVoiceTranscript("toggle auto scan")).toEqual({
      type: "command",
      action: "toggle_autoscan",
      rawTranscript: "toggle auto scan",
    });

    expect(routeVoiceTranscript("open hotlist")).toEqual({
      type: "command",
      action: "open_hotlist",
      rawTranscript: "open hotlist",
    });

    expect(routeVoiceTranscript("system health")).toEqual({
      type: "command",
      action: "open_diagnostics",
      rawTranscript: "system health",
    });

    expect(routeVoiceTranscript("close")).toEqual({
      type: "command",
      action: "close_drawer",
      rawTranscript: "close",
    });
  });

  it("routes natural language traffic search queries to the AI assistant", () => {
    const queryResult1 = routeVoiceTranscript("Find all red cars");
    expect(queryResult1.type).toBe("query");
    expect(queryResult1.query).toBe("Find all red cars");

    const queryResult2 = routeVoiceTranscript("Show trucks faster than 50 km/h");
    expect(queryResult2.type).toBe("query");
    expect(queryResult2.query).toBe("Show trucks faster than 50 km/h");

    const queryResult3 = routeVoiceTranscript("Where was MH12AB1234 last seen?");
    expect(queryResult3.type).toBe("query");
    expect(queryResult3.query).toBe("Where was MH12AB1234 last seen?");
  });
});
