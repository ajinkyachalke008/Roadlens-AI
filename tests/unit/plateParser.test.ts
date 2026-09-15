import { describe, it, expect } from "vitest";
import { parsePlateCondition } from "../../frontend/src/ai/plateParser";

describe("plateParser", () => {
  it("detects exact Indian license plates", () => {
    const res1 = parsePlateCondition("where was mh12ab1234 last seen", "Where was MH12AB1234 last seen?");
    expect(res1).toEqual({
      mode: "exact",
      text: "MH12AB1234",
      stateCode: "MH",
    });

    const res2 = parsePlateCondition("find dl 01 c 9999", "Find DL 01 C 9999");
    expect(res2).toEqual({
      mode: "exact",
      text: "DL01C9999",
      stateCode: "DL",
    });
  });

  it("detects Indian state names and codes", () => {
    const resMH = parsePlateCondition("show vehicles from maharashtra", "Show vehicles from Maharashtra");
    expect(resMH).toEqual({ mode: "state", stateCode: "MH" });

    const resDL = parsePlateCondition("find plates from delhi", "Find plates from Delhi");
    expect(resDL).toEqual({ mode: "state", stateCode: "DL" });

    const resGJ = parsePlateCondition("show plates from gj", "Show plates from GJ");
    expect(resGJ).toEqual({ mode: "state", stateCode: "GJ" });
  });

  it("detects unscanned and has_plate modes", () => {
    expect(parsePlateCondition("find cars without plate", "Find cars without plate")).toEqual({
      mode: "unscanned",
    });
    expect(parsePlateCondition("show vehicles with number plate", "Show vehicles with number plate")).toEqual({
      mode: "has_plate",
    });
  });
});
