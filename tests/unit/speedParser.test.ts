import { describe, it, expect } from "vitest";
import { parseSpeedCondition } from "../../frontend/src/ai/speedParser";

describe("speedParser", () => {
  it("parses speed threshold operators", () => {
    const above = parseSpeedCondition("vehicles speeding above 60 km/h");
    expect(above).toEqual({ operator: ">", value: 60 });

    const over = parseSpeedCondition("faster than 55 kmph");
    expect(over).toEqual({ operator: ">", value: 55 });

    const below = parseSpeedCondition("cars below 30 km/h");
    expect(below).toEqual({ operator: "<", value: 30 });

    const between = parseSpeedCondition("vehicles between 40 and 70 km/h");
    expect(between).toEqual({ operator: "between", value: 40, upperValue: 70 });
  });

  it("parses fastest and slowest keywords", () => {
    expect(parseSpeedCondition("the fastest vehicles today")).toEqual({ operator: "fastest" });
    expect(parseSpeedCondition("show top speed vehicles")).toEqual({ operator: "fastest" });
    expect(parseSpeedCondition("find the slowest trucks")).toEqual({ operator: "slowest" });
  });

  it("parses generic speeding violations", () => {
    expect(parseSpeedCondition("show speeding vehicles")).toEqual({ operator: "speeding", value: 50 });
    expect(parseSpeedCondition("find overspeeding candidates")).toEqual({ operator: "speeding", value: 50 });
  });
});
