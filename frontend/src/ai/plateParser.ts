/**
 * Indian number plate and state detection parser.
 */

import { INDIAN_STATES, parseIndianPlate } from "../../../shared/src/indianPlates";
import type { PlateCondition } from "../../../shared/src/forensicTypes";

const STATE_NAME_TO_CODE: Record<string, string> = {
  maharashtra: "MH",
  delhi: "DL",
  karnataka: "KA",
  gujarat: "GJ",
  "tamil nadu": "TN",
  tamilnadu: "TN",
  "uttar pradesh": "UP",
  uttarpradesh: "UP",
  haryana: "HR",
  punjab: "PB",
  rajasthan: "RJ",
  kerala: "KL",
  "andhra pradesh": "AP",
  andhra: "AP",
  telangana: "TS",
  "west bengal": "WB",
  bengal: "WB",
  "madhya pradesh": "MP",
  bihar: "BR",
  odisha: "OD",
  orissa: "OD",
  goa: "GA",
  assam: "AS",
  chandigarh: "CH",
  uttarakhand: "UK",
  jharkhand: "JH",
  himachal: "HP",
  "himachal pradesh": "HP",
  jammu: "JK",
  kashmir: "JK",
  "jammu and kashmir": "JK",
};

export function parsePlateCondition(normalizedQuery: string, rawQuery: string): PlateCondition | undefined {
  // 1. Check for exact plate pattern (e.g. MH 12 AB 1234, MH12AB1234, DL01A1234)
  const plateCandidate = rawQuery.match(/\b([A-Z]{2}\s*[-]?\s*[0-9]{1,2}\s*[-]?\s*[A-Z]{0,3}\s*[-]?\s*[0-9]{4})\b/i);
  if (plateCandidate) {
    const parsed = parseIndianPlate(plateCandidate[1]);
    if (parsed) {
      return {
        mode: "exact",
        text: parsed.rawNormalized,
        stateCode: parsed.stateCode,
      };
    }
  }

  // 2. Check for "without plate" / "no plate" / "unscanned"
  if (
    /\b(without plate|without number plate|no plate|unscanned plate|missing plate|no number plate)\b/i.test(
      normalizedQuery,
    )
  ) {
    return {
      mode: "unscanned",
    };
  }

  // 3. Check for state name (e.g. "from Maharashtra", "Gujarat plates")
  for (const [stateName, stateCode] of Object.entries(STATE_NAME_TO_CODE)) {
    const regex = new RegExp(`\\b${stateName}\\b`, "i");
    if (regex.test(normalizedQuery)) {
      return {
        mode: "state",
        stateCode,
      };
    }
  }

  // 4. Check for state code (e.g. "plates from MH", "DL registered", "KA vehicles")
  const stateCodeMatch = rawQuery.match(/\b([A-Z]{2})\b/);
  if (stateCodeMatch) {
    const code = stateCodeMatch[1].toUpperCase();
    if (INDIAN_STATES[code]) {
      // Confirm context implies state plate (e.g. "MH", "plates from MH", etc.)
      const isContextual =
        normalizedQuery.includes("plate") ||
        normalizedQuery.includes("rto") ||
        normalizedQuery.includes("from") ||
        normalizedQuery.includes("state") ||
        normalizedQuery.includes("registered") ||
        normalizedQuery.includes(code.toLowerCase());
      if (isContextual) {
        return {
          mode: "state",
          stateCode: code,
        };
      }
    }
  }

  // 5. Check strict "with plate" / "having plates"
  if (
    /\b(with plate|with number plate|having plate|having number plate|with scanned plate)\b/i.test(
      normalizedQuery,
    )
  ) {
    return {
      mode: "has_plate",
    };
  }

  return undefined;
}
