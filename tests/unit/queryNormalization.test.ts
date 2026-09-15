import { describe, it, expect } from "vitest";
import {
  normalizeQueryText,
  COLOR_SYNONYMS,
  CLASS_SYNONYMS,
} from "../../frontend/src/ai/queryNormalization";

describe("queryNormalization", () => {
  it("normalizes text by trimming, lowercasing, and stripping punctuation", () => {
    expect(normalizeQueryText("  Find ALL Red Cars!  ")).toBe("find all red cars");
    expect(normalizeQueryText("Where's the two-wheeler?")).toBe("wheres the two-wheeler");
  });

  it("maps color synonyms correctly", () => {
    expect(COLOR_SYNONYMS["maroon"]).toBe("Red");
    expect(COLOR_SYNONYMS["crimson"]).toBe("Red");
    expect(COLOR_SYNONYMS["ivory"]).toBe("White");
    expect(COLOR_SYNONYMS["dark"]).toBe("Black");
    expect(COLOR_SYNONYMS["grey"]).toBe("Silver");
    expect(COLOR_SYNONYMS["chocolate"]).toBe("Brown");
  });

  it("maps vehicle class synonyms correctly", () => {
    expect(CLASS_SYNONYMS["bike"]).toBe("motorcycle");
    expect(CLASS_SYNONYMS["scooter"]).toBe("motorcycle");
    expect(CLASS_SYNONYMS["two-wheeler"]).toBe("motorcycle");
    expect(CLASS_SYNONYMS["lorry"]).toBe("truck");
    expect(CLASS_SYNONYMS["auto"]).toBe("autorickshaw");
    expect(CLASS_SYNONYMS["sedan"]).toBe("car");
    expect(CLASS_SYNONYMS["suv"]).toBe("car");
  });
});
