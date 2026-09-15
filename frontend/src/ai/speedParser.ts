/**
 * Speed condition parser for traffic queries.
 */

import type { SpeedCondition } from "../../../shared/src/forensicTypes";

export function parseSpeedCondition(normalizedQuery: string): SpeedCondition | undefined {
  // 1. Check for "fastest" / "highest speed" / "top speed"
  if (
    /\b(fastest|highest speed|top speed|max speed|fastest vehicles)\b/i.test(
      normalizedQuery,
    )
  ) {
    return { operator: "fastest" };
  }

  // 2. Check for "slowest" / "lowest speed"
  if (/\b(slowest|lowest speed|min speed)\b/i.test(normalizedQuery)) {
    return { operator: "slowest" };
  }

  // 3. Check for "between X and Y" / "from X to Y"
  const betweenMatch = normalizedQuery.match(
    /\b(?:between|from)\s+(\d+)\s*(?:and|to|-)\s*(\d+)\s*(?:km\/?h|kmph|kph)?\b/i,
  );
  if (betweenMatch) {
    const val1 = Number(betweenMatch[1]);
    const val2 = Number(betweenMatch[2]);
    return {
      operator: "between",
      value: Math.min(val1, val2),
      upperValue: Math.max(val1, val2),
    };
  }

  // 4. Check for "> X", "above X", "over X", "faster than X", "exceeding X"
  const aboveMatch = normalizedQuery.match(
    /(?:above|over|exceeding|faster than|>|more than)\s*(\d+)\s*(?:km\/?h|kmph|kph)?\b/i,
  );
  if (aboveMatch) {
    return {
      operator: ">",
      value: Number(aboveMatch[1]),
    };
  }

  // 5. Check for "< X", "below X", "under X", "slower than X"
  const belowMatch = normalizedQuery.match(
    /(?:below|under|slower than|<|less than)\s*(\d+)\s*(?:km\/?h|kmph|kph)?\b/i,
  );
  if (belowMatch) {
    return {
      operator: "<",
      value: Number(belowMatch[1]),
    };
  }

  // 6. Check generic "speeding", "overspeeding"
  if (
    /\b(speeding|overspeeding|over speed|over-speed|speed candidate|speed violation)\b/i.test(
      normalizedQuery,
    )
  ) {
    return { operator: "speeding", value: 50 };
  }

  return undefined;
}
