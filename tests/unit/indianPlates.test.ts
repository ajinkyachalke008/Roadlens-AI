import { describe, it, expect } from "vitest";
import { parseIndianPlate, INDIAN_STATES } from "../../shared/src/indianPlates";

describe("parseIndianPlate", () => {
  it("parses standard Maharashtra private car plate", () => {
    const result = parseIndianPlate("MH 12 AB 1234");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.formatted).toBe("MH 12 AB 1234");
    expect(result?.stateCode).toBe("MH");
    expect(result?.stateName).toBe("Maharashtra");
    expect(result?.rtoLocation).toContain("Pune");
  });

  it("parses Delhi number plate with single letter series", () => {
    const result = parseIndianPlate("DL01A1234");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.stateCode).toBe("DL");
    expect(result?.formatted).toBe("DL 01 A 1234");
    expect(result?.stateName).toBe("Delhi");
  });

  it("parses Karnataka vehicle plate with lowercase and dashes", () => {
    const result = parseIndianPlate("ka-05-mn-9999");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.stateCode).toBe("KA");
    expect(result?.formatted).toBe("KA 05 MN 9999");
    expect(result?.rtoLocation).toContain("Bangalore");
  });

  it("handles OCR noise with HSRP IND prefix and O/0 confusion", () => {
    // Common OCR mistake: "IND MHIZAB1234" (I instead of 1, Z instead of 2)
    const result = parseIndianPlate("IND MHIZAB1234");
    expect(result).not.toBeNull();
    expect(result?.formatted).toBe("MH 12 AB 1234");
  });

  it("parses Bharat (BH) series plate", () => {
    const result = parseIndianPlate("22 BH 1234 AA");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.isBharatSeries).toBe(true);
    expect(result?.stateName).toContain("Bharat Series");
    expect(result?.formatted).toBe("22 BH 1234 AA");
  });

  it("rejects invalid plate strings", () => {
    expect(parseIndianPlate("XYZ")).toBeNull();
    expect(parseIndianPlate("123456789")).toBeNull();
    expect(parseIndianPlate("CALIFORNIA")).toBeNull();
  });
});
