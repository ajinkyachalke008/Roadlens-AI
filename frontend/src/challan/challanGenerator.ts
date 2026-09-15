import type { Report } from "../../../shared/src/schemas";
import { parseIndianPlate, type ParsedIndianPlate } from "../../../shared/src/indianPlates";

export interface ChallanFineItem {
  code: string;
  section: string;
  description: string;
  descriptionHi: string;
  amount: number;
}

export interface EChallanNotice {
  challanId: string;
  issuedAt: string;
  issueDateFormatted: string;
  dueDateFormatted: string;
  authorityName: string;
  authorityNameHi: string;
  stateCode: string;
  stateName: string;
  rtoCode: string;
  rtoLocation: string;
  registrationNumber: string;
  isRegisteredPlate: boolean;
  vehicleClass: string;
  vehicleClassHi: string;
  vehicleCategoryRaw: string;
  speedKmh: number | null;
  speedLimitKmh: number | null;
  excessSpeedKmh: number;
  isSpeedViolation: boolean;
  violationSection: string;
  violationTitle: string;
  violationTitleHi: string;
  totalPenaltyInr: number;
  fineItems: ChallanFineItem[];
  paymentStatus: "PENDING" | "PROCESSED";
  evidenceSnapshotUrl?: string;
  plateCutoutUrl?: string;
  reportId: string;
  trackId: number | null;
  locationName: string;
  cameraName: string;
}

/**
 * Calculates fine and violation section according to the
 * Motor Vehicles (Amendment) Act 2019 (India).
 */
export function calculateIndianTrafficFine(
  category: string,
  speedMps: number | null,
  limitMps: number | null,
): {
  section: string;
  title: string;
  titleHi: string;
  penaltyInr: number;
  items: ChallanFineItem[];
  excessKmh: number;
  isViolation: boolean;
} {
  const speedKmh = speedMps !== null ? Math.round(speedMps * 3.6) : null;
  const limitKmh = limitMps !== null ? Math.round(limitMps * 3.6) : null;

  const excessKmh =
    speedKmh !== null && limitKmh !== null && speedKmh > limitKmh
      ? speedKmh - limitKmh
      : 0;

  const isHeavy = category === "truck" || category === "bus";
  const isTwoWheeler = category === "motorcycle";

  if (excessKmh > 0) {
    if (isHeavy) {
      // Section 183(2): MMV/HGV Over-speeding
      const amount = excessKmh > 25 ? 4000 : 2000;
      return {
        section: "Section 183(2), Motor Vehicles (Amendment) Act 2019",
        title: "Over-speeding (Medium / Heavy Goods or Passenger Vehicle)",
        titleHi: "गति सीमा उल्लंघन (मध्यम / भारी माल या यात्री वाहन)",
        penaltyInr: amount,
        excessKmh,
        isViolation: true,
        items: [
          {
            code: "MV-183-2",
            section: "Sec 183(2) MV Act",
            description: `Exceeding specified speed limit by +${excessKmh} km/h (Commercial/HGV)`,
            descriptionHi: `निर्धारित गति सीमा से +${excessKmh} किमी/घंटा अधिक गति (भारी वाहन)`,
            amount,
          },
        ],
      };
    }

    if (isTwoWheeler) {
      // Section 183(1): Two-Wheeler Over-speeding
      const amount = excessKmh > 25 ? 1500 : 1000;
      return {
        section: "Section 183(1), Motor Vehicles (Amendment) Act 2019",
        title: "Over-speeding (Two-Wheeler / Motorcycle)",
        titleHi: "गति सीमा उल्लंघन (दोपहिया वाहन / मोटरसाइकिल)",
        penaltyInr: amount,
        excessKmh,
        isViolation: true,
        items: [
          {
            code: "MV-183-1-2W",
            section: "Sec 183(1) MV Act",
            description: `Exceeding specified speed limit by +${excessKmh} km/h (Two-Wheeler)`,
            descriptionHi: `निर्धारित गति सीमा से +${excessKmh} किमी/घंटा अधिक गति (दोपहिया)`,
            amount,
          },
        ],
      };
    }

    // Default: Light Motor Vehicle (LMV / Car)
    const amount = excessKmh > 30 ? 2000 : 1000;
    return {
      section: "Section 183(1), Motor Vehicles (Amendment) Act 2019",
      title: "Over-speeding (Light Motor Vehicle)",
      titleHi: "गति सीमा उल्लंघन (हल्का मोटर वाहन)",
      penaltyInr: amount,
      excessKmh,
      isViolation: true,
      items: [
        {
          code: "MV-183-1-LMV",
          section: "Sec 183(1) MV Act",
          description: `Exceeding prescribed speed limit by +${excessKmh} km/h (LMV)`,
          descriptionHi: `निर्धारित गति सीमा से +${excessKmh} किमी/घंटा अधिक गति (एलएमवी)`,
          amount,
        },
      ],
    };
  }

  // General Traffic Observation / Non-speeding infraction
  return {
    section: "Section 177, Motor Vehicles (Amendment) Act 2019",
    title: "General Traffic Observation Notice",
    titleHi: "सामान्य यातायात निरीक्षण सूचना",
    penaltyInr: 500,
    excessKmh: 0,
    isViolation: false,
    items: [
      {
        code: "MV-177",
        section: "Sec 177 MV Act",
        description: "Standard CCTV Traffic Observation Record",
        descriptionHi: "मानक सीसीटीवी यातायात निगरानी रिकॉर्ड",
        amount: 500,
      },
    ],
  };
}

/**
 * Maps raw vehicle detector class to user-friendly Indian transport category.
 */
export function getIndianVehicleCategoryName(className: string | null): {
  en: string;
  hi: string;
} {
  const normalized = (className ?? "").toLowerCase();
  switch (normalized) {
    case "car":
      return {
        en: "Light Motor Vehicle (Car / SUV)",
        hi: "हल्का मोटर वाहन (कार / एसयूवी)",
      };
    case "motorcycle":
      return {
        en: "Two-Wheeler (Motorcycle / Scooter)",
        hi: "दोपहिया वाहन (मोटरसाइकिल / स्कूटर)",
      };
    case "truck":
      return {
        en: "Heavy Goods Vehicle (Truck / Lorry)",
        hi: "भारी माल वाहन (ट्रक)",
      };
    case "bus":
      return {
        en: "Heavy Passenger Vehicle (Bus)",
        hi: "भारी यात्री वाहन (बस)",
      };
    default:
      return {
        en: "Motor Vehicle",
        hi: "मोटर वाहन",
      };
  }
}

/**
 * Generates an authentic Challan Notice ID conforming to Indian state e-Challan format:
 * e.g., MH-2026-CH-749201
 */
export function generateChallanNoticeNumber(
  stateCode: string = "IN",
  seedDate: Date = new Date(),
): string {
  const year = seedDate.getFullYear();
  const randomSuffix = Math.floor(100000 + Math.random() * 900000);
  const cleanState = (stateCode || "IN").toUpperCase().slice(0, 2);
  return `${cleanState}-${year}-CH-${randomSuffix}`;
}

/**
 * Transforms an internal RoadLens session report into an official e-Challan notice document.
 */
export function createEChallanFromReport(
  report: Report,
  urls?: { event?: string | null; plate?: string | null; vehicle?: string | null },
  customLocation: string = "National Highway / Urban Corridor · Sector 4",
): EChallanNotice {
  const now = new Date();
  const dueDate = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days due date

  const plateText = report.plateText ?? report.plateCandidateText ?? "";
  const parsedPlate: ParsedIndianPlate | null = plateText
    ? parseIndianPlate(plateText)
    : null;

  const stateCode = parsedPlate?.stateCode ?? "MH";
  const stateName = parsedPlate?.stateName ?? "Maharashtra";
  const rtoCode = parsedPlate?.rtoCode ?? `${stateCode}01`;
  const rtoLocation =
    parsedPlate?.rtoLocation ?? `${stateName} Transport Authority`;
  const registrationNumber = parsedPlate?.formatted ?? (plateText || "UNREGISTERED / UNREADABLE");

  const vehicleClassInfo = getIndianVehicleCategoryName(report.className);

  const speedKmh =
    report.speedMps !== null ? Math.round(report.speedMps * 3.6) : null;
  const speedLimitKmh =
    report.policy.speedLimitMps !== null
      ? Math.round(report.policy.speedLimitMps * 3.6)
      : null;

  const fineCalc = calculateIndianTrafficFine(
    report.className ?? "car",
    report.speedMps,
    report.policy.speedLimitMps,
  );

  const challanId = generateChallanNoticeNumber(stateCode, now);

  return {
    challanId,
    issuedAt: now.toISOString(),
    issueDateFormatted: now.toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    dueDateFormatted: dueDate.toLocaleString("en-IN", {
      dateStyle: "medium",
    }),
    authorityName: `${stateName.toUpperCase()} TRAFFIC POLICE & TRANSPORT DEPT`,
    authorityNameHi: `${stateName} यातायात पुलिस एवं परिवहन विभाग`,
    stateCode,
    stateName,
    rtoCode,
    rtoLocation,
    registrationNumber,
    isRegisteredPlate: Boolean(parsedPlate?.isValid),
    vehicleClass: vehicleClassInfo.en,
    vehicleClassHi: vehicleClassInfo.hi,
    vehicleCategoryRaw: report.className ?? "car",
    speedKmh,
    speedLimitKmh,
    excessSpeedKmh: fineCalc.excessKmh,
    isSpeedViolation: fineCalc.isViolation,
    violationSection: fineCalc.section,
    violationTitle: fineCalc.title,
    violationTitleHi: fineCalc.titleHi,
    totalPenaltyInr: fineCalc.penaltyInr,
    fineItems: fineCalc.items,
    paymentStatus: "PENDING",
    evidenceSnapshotUrl: (urls?.event || urls?.vehicle) ?? undefined,
    plateCutoutUrl: urls?.plate ?? undefined,
    reportId: report.reportId,
    trackId: report.trackId,
    locationName: customLocation,
    cameraName: "RoadLens AI Fixed Camera #01",
  };
}
