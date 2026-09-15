/**
 * Time range parser for traffic queries.
 */

import type { TimeRangeCondition } from "../../../shared/src/forensicTypes";

export function parseTimeCondition(normalizedQuery: string): TimeRangeCondition | undefined {
  const now = new Date();

  // 1. "last hour" / "past hour"
  if (/\b(last hour|past hour|previous hour)\b/i.test(normalizedQuery)) {
    const from = new Date(now.getTime() - 60 * 60 * 1000);
    return {
      preset: "last_hour",
      fromIso: from.toISOString(),
      toIso: now.toISOString(),
    };
  }

  // 2. "last 24 hours" / "past 24 hours" / "past day"
  if (/\b(last 24 hours|past 24 hours|past 24h|last 24h|past day)\b/i.test(normalizedQuery)) {
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
      preset: "last_24h",
      fromIso: from.toISOString(),
      toIso: now.toISOString(),
    };
  }

  // 3. "this morning"
  if (/\b(this morning|today morning)\b/i.test(normalizedQuery)) {
    const start = new Date(now);
    start.setHours(6, 0, 0, 0);
    const end = new Date(now);
    end.setHours(12, 0, 0, 0);
    return {
      preset: "this_morning",
      fromIso: start.toISOString(),
      toIso: end.toISOString(),
    };
  }

  // 4. "yesterday"
  if (/\b(yesterday)\b/i.test(normalizedQuery)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setDate(end.getDate() - 1);
    end.setHours(23, 59, 59, 999);
    return {
      preset: "yesterday",
      fromIso: start.toISOString(),
      toIso: end.toISOString(),
    };
  }

  // 5. "today"
  if (/\b(today|so far today)\b/i.test(normalizedQuery)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return {
      preset: "today",
      fromIso: start.toISOString(),
      toIso: now.toISOString(),
    };
  }

  return undefined;
}
