/**
 * Indian High Security Registration Plate (HSRP) and Bharat Series Parser.
 *
 * Covers standard Indian RTO formats:
 * - Standard Format: State (2 letters) + RTO Code (2 digits) + Series (0-3 letters) + Number (4 digits)
 *   e.g. "MH 12 AB 1234", "DL 01 A 1234", "KA 05 MN 9999"
 * - Bharat (BH) Series: Year (2 digits) + BH + Number (4 digits) + Series (1-2 letters)
 *   e.g. "22 BH 1234 AA"
 */

export const INDIAN_STATES: Readonly<Record<string, string>> = Object.freeze({
  AN: "Andaman and Nicobar Islands",
  AP: "Andhra Pradesh",
  AR: "Arunachal Pradesh",
  AS: "Assam",
  BR: "Bihar",
  CH: "Chandigarh",
  CG: "Chhattisgarh",
  DD: "Daman and Diu",
  DL: "Delhi",
  DN: "Dadra and Nagar Haveli",
  GA: "Goa",
  GJ: "Gujarat",
  HR: "Haryana",
  HP: "Himachal Pradesh",
  JH: "Jharkhand",
  JK: "Jammu and Kashmir",
  KA: "Karnataka",
  KL: "Kerala",
  LA: "Ladakh",
  LD: "Lakshadweep",
  MH: "Maharashtra",
  ML: "Meghalaya",
  MN: "Manipur",
  MP: "Madhya Pradesh",
  MZ: "Mizoram",
  NL: "Nagaland",
  OD: "Odisha",
  PB: "Punjab",
  PY: "Puducherry",
  RJ: "Rajasthan",
  SK: "Sikkim",
  TN: "Tamil Nadu",
  TR: "Tripura",
  TS: "Telangana",
  UK: "Uttarakhand",
  UA: "Uttarakhand",
  UP: "Uttar Pradesh",
  WB: "West Bengal",
});

export const COMMON_INDIAN_RTOS: Readonly<Record<string, string>> = Object.freeze({
  MH01: "Mumbai South",
  MH02: "Mumbai West (Andheri)",
  MH03: "Mumbai East (Wadala)",
  MH04: "Thane",
  MH12: "Pune",
  MH14: "Pimpri-Chinchwad",
  MH20: "Chhatrapati Sambhajinagar",
  MH31: "Nagpur",
  MH43: "Navi Mumbai",
  MH46: "Panvel",
  MH47: "Mumbai North (Borivali)",
  DL01: "Delhi North (Mall Road)",
  DL02: "Delhi New (Tilak Marg)",
  DL03: "Delhi South (Sheikh Sarai)",
  DL04: "Delhi West (Janakpuri)",
  DL05: "Delhi North East (Loni)",
  DL06: "Delhi Central (Sarai Kale Khan)",
  DL07: "Delhi East (Mayur Vihar)",
  DL08: "Delhi North West (Wazirpur)",
  DL09: "Delhi South West (Palam)",
  DL10: "Delhi West (Raja Garden)",
  KA01: "Bangalore Central",
  KA02: "Bangalore West",
  KA03: "Bangalore East (Indiranagar)",
  KA04: "Bangalore North (Yeshwanthpur)",
  KA05: "Bangalore South (Jayanagar)",
  KA51: "Bangalore Electronic City",
  KA53: "Bangalore KR Puram",
  TN01: "Chennai Central",
  TN02: "Chennai North West",
  TN07: "Chennai South",
  TN09: "Chennai West",
  TN10: "Chennai South West",
  GJ01: "Ahmedabad",
  GJ02: "Mehsana",
  GJ03: "Rajkot",
  GJ05: "Surat",
  GJ06: "Vadodara",
  GJ27: "Ahmedabad East",
  HR01: "Ambala",
  HR26: "Gurugram North",
  HR51: "Faridabad",
  HR55: "Gurugram Commercial",
  UP14: "Ghaziabad",
  UP16: "Gautam Buddha Nagar (Noida)",
  UP32: "Lucknow",
  UP70: "Prayagraj",
  UP78: "Kanpur",
  TS07: "Ranga Reddy",
  TS08: "Medchal-Malkajgiri",
  TS09: "Hyderabad Central",
  TS10: "Hyderabad North (Secunderabad)",
  TS11: "Hyderabad East (Malakpet)",
  AP09: "Chittoor",
  AP16: "Vijayawada",
  AP39: "Tirupati",
  WB01: "Kolkata Central",
  WB02: "Kolkata North",
  WB06: "Kolkata South",
  RJ14: "Jaipur South",
  RJ45: "Jaipur North",
  KL01: "Thiruvananthapuram",
  KL07: "Kochi (Ernakulam)",
});

export interface ParsedIndianPlate {
  isValid: boolean;
  formatted: string;
  rawNormalized: string;
  stateCode?: string;
  stateName?: string;
  rtoCode?: string;
  rtoLocation?: string;
  series?: string;
  uniqueNumber?: string;
  isBharatSeries: boolean;
}

/** Position-based character correction for OCR confusions in Indian plates */
function correctLetter(char: string): string {
  const map: Record<string, string> = {
    "0": "O",
    "1": "I",
    "2": "Z",
    "5": "S",
    "8": "B",
  };
  return map[char] ?? char;
}

function correctDigit(char: string): string {
  const map: Record<string, string> = {
    O: "0",
    Q: "0",
    D: "0",
    I: "1",
    L: "1",
    Z: "2",
    S: "5",
    B: "8",
    G: "6",
  };
  return map[char] ?? char;
}

/**
 * Parses, validates, and standardizes an Indian registration number from raw OCR output.
 */
export function parseIndianPlate(rawInput: string): ParsedIndianPlate | null {
  if (!rawInput) return null;

  // 1. Clean raw text: uppercase, remove non-alphanumeric, strip HSRP "IND" prefix if present
  let clean = rawInput.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.startsWith("IND") && clean.length > 8) {
    clean = clean.slice(3);
  }

  if (clean.length < 7 || clean.length > 11) {
    return null;
  }

  // 2. Check for Bharat (BH) Series: e.g. "22BH1234AA"
  // Format: [2 digits year] + BH + [4 digits] + [1-2 letters]
  const bhMatch = clean.match(/^([0-9]{2})(BH)([0-9]{4})([A-Z]{1,2})$/);
  if (bhMatch) {
    const [, year, , num, series] = bhMatch;
    return {
      isValid: true,
      formatted: `${year} BH ${num} ${series}`,
      rawNormalized: clean,
      stateCode: "BH",
      stateName: "All India (Bharat Series)",
      rtoCode: "BH",
      rtoLocation: `Registered in 20${year}`,
      series,
      uniqueNumber: num,
      isBharatSeries: true,
    };
  }

  // 3. Check for standard Indian Plate format:
  // Usually 9 or 10 characters:
  // e.g. MH12AB1234 (10) or DL1C1234 (8-9) or KA05MN9999 (10)
  // Let's attempt smart positional correction:
  const chars = clean.split("");

  // Position 0 & 1 must be letters (State code)
  chars[0] = correctLetter(chars[0]);
  chars[1] = correctLetter(chars[1]);
  const stateCodeCandidate = chars[0] + chars[1];

  if (!INDIAN_STATES[stateCodeCandidate]) {
    // If state code isn't recognized, check if it's BH series with OCR mistakes
    if (clean.includes("BH")) {
      const bhAttempt = clean.replace(/O/g, "0").replace(/I/g, "1");
      const match = bhAttempt.match(/^([0-9]{2})(BH)([0-9]{4})([A-Z]{1,2})$/);
      if (match) {
        return {
          isValid: true,
          formatted: `${match[1]} BH ${match[3]} ${match[4]}`,
          rawNormalized: match[0],
          stateCode: "BH",
          stateName: "All India (Bharat Series)",
          rtoCode: "BH",
          rtoLocation: `Registered in 20${match[1]}`,
          series: match[4],
          uniqueNumber: match[3],
          isBharatSeries: true,
        };
      }
    }
    return null;
  }

  // Next 1 or 2 characters must be digits (RTO code)
  chars[2] = correctDigit(chars[2]);
  let rtoDigits = chars[2];
  let remainderIdx = 3;

  if (chars.length >= 8 && /[0-9OIZSB]/.test(chars[3])) {
    chars[3] = correctDigit(chars[3]);
    rtoDigits += chars[3];
    remainderIdx = 4;
  }

  const rtoKey = `${stateCodeCandidate}${rtoDigits.padStart(2, "0")}`;

  // Last 4 characters are always the registration digits
  const lastFourStart = chars.length - 4;
  if (lastFourStart < remainderIdx) return null;

  for (let i = lastFourStart; i < chars.length; i++) {
    chars[i] = correctDigit(chars[i]);
  }
  const uniqueNum = chars.slice(lastFourStart).join("");
  if (!/^\d{4}$/.test(uniqueNum)) return null;

  // Middle characters (between RTO code and last 4 digits) are letters (Series: 0 to 3 letters)
  for (let i = remainderIdx; i < lastFourStart; i++) {
    chars[i] = correctLetter(chars[i]);
  }
  const series = chars.slice(remainderIdx, lastFourStart).join("");
  if (series && !/^[A-Z]{1,3}$/.test(series)) return null;

  const normalized = chars.join("");
  const formatted = `${stateCodeCandidate} ${rtoDigits} ${series ? series + " " : ""}${uniqueNum}`.replace(/\s+/g, " ").trim();

  return {
    isValid: true,
    formatted,
    rawNormalized: normalized,
    stateCode: stateCodeCandidate,
    stateName: INDIAN_STATES[stateCodeCandidate],
    rtoCode: rtoKey,
    rtoLocation: COMMON_INDIAN_RTOS[rtoKey] ?? `${INDIAN_STATES[stateCodeCandidate]} RTO ${rtoDigits}`,
    series: series || undefined,
    uniqueNumber: uniqueNum,
    isBharatSeries: false,
  };
}
