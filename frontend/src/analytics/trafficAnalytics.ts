import type { Report } from "../../../shared/src/schemas";
import { parseIndianPlate, INDIAN_STATES } from "../../../shared/src/indianPlates";

export interface VehicleClassCount {
  category: string;
  label: string;
  labelHi: string;
  icon: string;
  count: number;
  percentage: number;
}

export interface SpeedBucket {
  range: string;
  label: string;
  count: number;
  percentage: number;
  status: "safe" | "warning" | "violation";
}

export interface StateOriginCount {
  stateCode: string;
  stateName: string;
  count: number;
  percentage: number;
}

export interface TrafficAnalyticsSummary {
  totalObservations: number;
  totalUniqueVehicles: number;
  vehicleClasses: VehicleClassCount[];
  speedStats: {
    measuredCount: number;
    averageSpeedKmh: number;
    maxSpeedKmh: number;
    minSpeedKmh: number;
    violationsCount: number;
    compliantCount: number;
    complianceRate: number; // 0 - 100%
  };
  speedDistribution: SpeedBucket[];
  plateStats: {
    totalPlatesDetected: number;
    confirmedIndianPlates: number;
    bharatSeriesPlates: number;
    topOriginStates: StateOriginCount[];
  };
  generatedAt: string;
}

/**
 * Computes comprehensive traffic analytics from active session reports.
 */
export function computeTrafficAnalytics(reports: Report[]): TrafficAnalyticsSummary {
  const total = reports.length;

  // 1. Vehicle Class Distribution
  const classMap: Record<string, number> = {
    car: 0,
    motorcycle: 0,
    truck: 0,
    bus: 0,
    other: 0,
  };

  const trackedSet = new Set<number>();
  let measuredCount = 0;
  let speedSum = 0;
  let maxSpeed = 0;
  let minSpeed = Infinity;
  let violationsCount = 0;

  // Speed buckets (km/h)
  const bucketCounts = {
    "0-20": 0,
    "21-40": 0,
    "41-60": 0,
    "61-80": 0,
    "80+": 0,
  };

  let totalPlatesDetected = 0;
  let confirmedIndianPlates = 0;
  let bharatSeriesPlates = 0;
  const stateCounts: Record<string, number> = {};

  for (const rep of reports) {
    if (rep.trackId !== null) {
      trackedSet.add(rep.trackId);
    }

    // Vehicle category
    const cat = (rep.className ?? "").toLowerCase();
    if (cat in classMap) {
      classMap[cat]++;
    } else {
      classMap.other++;
    }

    // Speed calculation
    if (rep.speedMps !== null && rep.speedMps > 0) {
      const kmh = Math.round(rep.speedMps * 3.6);
      measuredCount++;
      speedSum += kmh;
      if (kmh > maxSpeed) maxSpeed = kmh;
      if (kmh < minSpeed) minSpeed = kmh;

      const limitKmh =
        rep.policy.speedLimitMps !== null
          ? Math.round(rep.policy.speedLimitMps * 3.6)
          : 50;

      if (kmh > limitKmh) {
        violationsCount++;
      }

      // Buckets
      if (kmh <= 20) bucketCounts["0-20"]++;
      else if (kmh <= 40) bucketCounts["21-40"]++;
      else if (kmh <= 60) bucketCounts["41-60"]++;
      else if (kmh <= 80) bucketCounts["61-80"]++;
      else bucketCounts["80+"]++;
    }

    // Plate processing
    const plateCandidate = rep.plateText ?? rep.plateCandidateText;
    if (plateCandidate) {
      totalPlatesDetected++;
      const parsed = parseIndianPlate(plateCandidate);
      if (parsed && parsed.isValid) {
        confirmedIndianPlates++;
        if (parsed.isBharatSeries) {
          bharatSeriesPlates++;
        }
        if (parsed.stateCode) {
          stateCounts[parsed.stateCode] =
            (stateCounts[parsed.stateCode] ?? 0) + 1;
        }
      }
    }
  }

  // Format Vehicle Classes
  const vehicleClasses: VehicleClassCount[] = [
    {
      category: "car",
      label: "Cars / LMVs",
      labelHi: "कारें / हल्के वाहन",
      icon: "🚗",
      count: classMap.car,
      percentage: total > 0 ? Math.round((classMap.car / total) * 100) : 0,
    },
    {
      category: "motorcycle",
      label: "Two-Wheelers",
      labelHi: "दोपहिया / बाइक",
      icon: "🏍️",
      count: classMap.motorcycle,
      percentage:
        total > 0 ? Math.round((classMap.motorcycle / total) * 100) : 0,
    },
    {
      category: "truck",
      label: "Heavy Trucks",
      labelHi: "भारी ट्रक",
      icon: "🚚",
      count: classMap.truck,
      percentage: total > 0 ? Math.round((classMap.truck / total) * 100) : 0,
    },
    {
      category: "bus",
      label: "Buses",
      labelHi: "बसें",
      icon: "🚌",
      count: classMap.bus,
      percentage: total > 0 ? Math.round((classMap.bus / total) * 100) : 0,
    },
  ];

  // Format Speed Buckets
  const speedDistribution: SpeedBucket[] = [
    {
      range: "0-20",
      label: "0 - 20 km/h (Crawling)",
      count: bucketCounts["0-20"],
      percentage:
        measuredCount > 0
          ? Math.round((bucketCounts["0-20"] / measuredCount) * 100)
          : 0,
      status: "safe",
    },
    {
      range: "21-40",
      label: "21 - 40 km/h (City Flow)",
      count: bucketCounts["21-40"],
      percentage:
        measuredCount > 0
          ? Math.round((bucketCounts["21-40"] / measuredCount) * 100)
          : 0,
      status: "safe",
    },
    {
      range: "41-60",
      label: "41 - 60 km/h (Moderate)",
      count: bucketCounts["41-60"],
      percentage:
        measuredCount > 0
          ? Math.round((bucketCounts["41-60"] / measuredCount) * 100)
          : 0,
      status: "warning",
    },
    {
      range: "61-80",
      label: "61 - 80 km/h (Highway / Fast)",
      count: bucketCounts["61-80"],
      percentage:
        measuredCount > 0
          ? Math.round((bucketCounts["61-80"] / measuredCount) * 100)
          : 0,
      status: "violation",
    },
    {
      range: "80+",
      label: "80+ km/h (Excessive Speed)",
      count: bucketCounts["80+"],
      percentage:
        measuredCount > 0
          ? Math.round((bucketCounts["80+"] / measuredCount) * 100)
          : 0,
      status: "violation",
    },
  ];

  // Top Origin States
  const topOriginStates: StateOriginCount[] = Object.entries(stateCounts)
    .map(([code, count]) => ({
      stateCode: code,
      stateName: INDIAN_STATES[code] ?? code,
      count,
      percentage:
        confirmedIndianPlates > 0
          ? Math.round((count / confirmedIndianPlates) * 100)
          : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const compliantCount = measuredCount - violationsCount;
  const complianceRate =
    measuredCount > 0 ? Math.round((compliantCount / measuredCount) * 100) : 100;

  return {
    totalObservations: total,
    totalUniqueVehicles: trackedSet.size || total,
    vehicleClasses,
    speedStats: {
      measuredCount,
      averageSpeedKmh:
        measuredCount > 0 ? Math.round(speedSum / measuredCount) : 0,
      maxSpeedKmh: maxSpeed > 0 ? maxSpeed : 0,
      minSpeedKmh: minSpeed !== Infinity ? minSpeed : 0,
      violationsCount,
      compliantCount,
      complianceRate,
    },
    speedDistribution,
    plateStats: {
      totalPlatesDetected,
      confirmedIndianPlates,
      bharatSeriesPlates,
      topOriginStates,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Converts traffic analytics into a downloadable CSV report.
 */
export function generateAnalyticsCsv(summary: TrafficAnalyticsSummary): string {
  const lines: string[] = [
    `# RoadLens AI Traffic Analytics Summary Report`,
    `Generated At,${summary.generatedAt}`,
    `Total Observations,${summary.totalObservations}`,
    `Unique Tracked Vehicles,${summary.totalUniqueVehicles}`,
    `Speed Compliance Rate,${summary.speedStats.complianceRate}%`,
    `Speeding Violations,${summary.speedStats.violationsCount}`,
    `Average Speed,${summary.speedStats.averageSpeedKmh} km/h`,
    `Peak Speed Recorded,${summary.speedStats.maxSpeedKmh} km/h`,
    ``,
    `# Vehicle Class Distribution`,
    `Category,Count,Percentage`,
    ...summary.vehicleClasses.map(
      (c) => `"${c.label}",${c.count},${c.percentage}%`,
    ),
    ``,
    `# Speed Distribution`,
    `Range,Count,Percentage,Status`,
    ...summary.speedDistribution.map(
      (s) => `"${s.label}",${s.count},${s.percentage}%,${s.status}`,
    ),
    ``,
    `# Indian Plate Origin Demographics`,
    `State Code,State Name,Count,Percentage`,
    ...summary.plateStats.topOriginStates.map(
      (o) => `${o.stateCode},"${o.stateName}",${o.count},${o.percentage}%`,
    ),
  ];

  return lines.join("\n");
}
