import { describe, it, expect } from "vitest";
import {
  parseIndianPlate,
  INDIAN_STATES,
  COMMON_INDIAN_RTOS,
} from "../../shared/src/indianPlates";

describe("parseIndianPlate - Detailed Engine Tests", () => {
  it("parses standard Maharashtra private car plate with RTO district", () => {
    const result = parseIndianPlate("MH 12 AB 1234");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.formatted).toBe("MH 12 AB 1234");
    expect(result?.stateCode).toBe("MH");
    expect(result?.stateName).toBe("Maharashtra");
    expect(result?.rtoLocation).toContain("Pune");
    expect(result?.districtCode).toBe("12");
    expect(result?.series).toBe("AB");
    expect(result?.uniqueNumber).toBe("1234");
    expect(result?.isBharatSeries).toBe(false);
  });

  it("parses Delhi number plate with single letter series", () => {
    const result = parseIndianPlate("DL01A1234");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.stateCode).toBe("DL");
    expect(result?.formatted).toBe("DL 01 A 1234");
    expect(result?.stateName).toBe("Delhi");
    expect(result?.rtoLocation).toContain("Mall Road");
  });

  it("parses Karnataka vehicle plate with lowercase and dashes", () => {
    const result = parseIndianPlate("ka-05-mn-9999");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.stateCode).toBe("KA");
    expect(result?.formatted).toBe("KA 05 MN 9999");
    expect(result?.rtoLocation).toContain("Bangalore South");
  });

  it("parses Tamil Nadu plate with 3-letter series", () => {
    const result = parseIndianPlate("TN 01 ABC 5678");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.stateCode).toBe("TN");
    expect(result?.formatted).toBe("TN 01 ABC 5678");
    expect(result?.rtoLocation).toContain("Chennai Central");
  });

  it("parses plate without sub-series (older/direct numbering)", () => {
    const result = parseIndianPlate("MH 04 1234");
    expect(result).not.toBeNull();
    expect(result?.isValid).toBe(true);
    expect(result?.formatted).toBe("MH 04 1234");
    expect(result?.rtoLocation).toContain("Thane");
  });

  it("validates every Indian State and Union Territory code", () => {
    for (const [code, name] of Object.entries(INDIAN_STATES)) {
      const plateStr = `${code} 01 AB 1234`;
      const result = parseIndianPlate(plateStr);
      expect(result).not.toBeNull();
      expect(result?.isValid).toBe(true);
      expect(result?.stateCode).toBe(code);
      expect(result?.stateName).toBe(name);
      expect(result?.formatted).toBe(`${code} 01 AB 1234`);
    }
  });

  it("resolves major metropolitan RTO hubs accurately", () => {
    const hubs: Record<string, string> = {
      "MH 01 AB 1111": "Mumbai South",
      "MH 02 XY 2222": "Mumbai West (Andheri)",
      "MH 43 CD 3333": "Navi Mumbai",
      "DL 02 AB 4444": "Delhi New (Tilak Marg)",
      "DL 04 EF 5555": "Delhi West (Janakpuri)",
      "KA 01 ZZ 6666": "Bangalore Central",
      "KA 51 MM 7777": "Bangalore Electronic City",
      "GJ 01 TT 8888": "Ahmedabad",
      "GJ 05 WW 9999": "Surat",
      "HR 26 AA 1010": "Gurugram North",
      "UP 16 BB 2020": "Gautam Buddha Nagar (Noida)",
      "TS 09 CC 3030": "Hyderabad Central",
      "WB 02 DD 4040": "Kolkata North",
    };

    for (const [plate, expectedRto] of Object.entries(hubs)) {
      const res = parseIndianPlate(plate);
      expect(res).not.toBeNull();
      expect(res?.rtoLocation).toBe(expectedRto);
    }
  });

  describe("Bharat (BH) Series", () => {
    it("parses Bharat (BH) series across different registration years", () => {
      const years = ["21", "22", "23", "24", "25", "26"];
      for (const year of years) {
        const plateStr = `${year} BH 1234 AA`;
        const result = parseIndianPlate(plateStr);
        expect(result).not.toBeNull();
        expect(result?.isValid).toBe(true);
        expect(result?.isBharatSeries).toBe(true);
        expect(result?.stateName).toContain("Bharat Series");
        expect(result?.formatted).toBe(`${year} BH 1234 AA`);
        expect(result?.uniqueNumber).toBe("1234");
        expect(result?.series).toBe("AA");
      }
    });

    it("parses BH series with single-letter series suffix", () => {
      const result = parseIndianPlate("23 BH 9876 A");
      expect(result).not.toBeNull();
      expect(result?.isValid).toBe(true);
      expect(result?.isBharatSeries).toBe(true);
      expect(result?.formatted).toBe("23 BH 9876 A");
    });
  });

  describe("OCR Noise & Positional Correction", () => {
    it("handles HSRP IND prefix and O/0 confusion", () => {
      // Common OCR noise: "IND MHIZAB1234" (I instead of 1, Z instead of 2)
      const result = parseIndianPlate("IND MHIZAB1234");
      expect(result).not.toBeNull();
      expect(result?.formatted).toBe("MH 12 AB 1234");
      expect(result?.stateCode).toBe("MH");
      expect(result?.districtCode).toBe("12");
    });

    it("corrects letter 'O' to digit '0' in RTO district code", () => {
      const result = parseIndianPlate("MH O4 AB 1234");
      expect(result).not.toBeNull();
      expect(result?.formatted).toBe("MH 04 AB 1234");
      expect(result?.districtCode).toBe("04");
    });

    it("corrects letter 'S' to digit '5' in 4-digit number portion", () => {
      const result = parseIndianPlate("MH 12 AB 12S4");
      expect(result).not.toBeNull();
      expect(result?.formatted).toBe("MH 12 AB 1254");
      expect(result?.uniqueNumber).toBe("1254");
    });

    it("corrects digit '0' to letter 'O' in state code position", () => {
      // Odisha state code OD misread as 0D
      const result = parseIndianPlate("0D 02 AB 1234");
      expect(result).not.toBeNull();
      expect(result?.stateCode).toBe("OD");
      expect(result?.stateName).toBe("Odisha");
    });

    it("handles spaces, dots, and hyphens mixed together", () => {
      const result = parseIndianPlate("M.H - 12 . A-B - 9999");
      expect(result).not.toBeNull();
      expect(result?.formatted).toBe("MH 12 AB 9999");
    });
  });

  describe("Negative / Rejection Tests", () => {
    it("rejects non-Indian plates and random noise", () => {
      const invalidStrings = [
        "XYZ",
        "123456789",
        "CALIFORNIA",
        "NEW YORK",
        "ABC-1234",
        "XX 99 ZZ 9999", // Invalid state XX
        "MH 12 AB", // Incomplete number
        "MH AB 1234", // Missing RTO code
        "1234 MH AB", // Inverted order
        "!@#$%^&*",
        "",
      ];

      for (const str of invalidStrings) {
        expect(parseIndianPlate(str)).toBeNull();
      }
    });
  });
});
