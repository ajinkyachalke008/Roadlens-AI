import { describe, it, expect } from "vitest";
import { parseTimeCondition } from "../../frontend/src/ai/timeParser";

describe("timeParser", () => {
  it("parses relative time windows", () => {
    const today = parseTimeCondition("show all trucks detected today");
    expect(today?.preset).toBe("today");
    expect(today?.fromIso).toBeDefined();

    const yesterday = parseTimeCondition("find speeding cars yesterday");
    expect(yesterday?.preset).toBe("yesterday");

    const lastHour = parseTimeCondition("vehicles seen in the last hour");
    expect(lastHour?.preset).toBe("last_hour");

    const morning = parseTimeCondition("buses detected this morning");
    expect(morning?.preset).toBe("this_morning");
  });
});
