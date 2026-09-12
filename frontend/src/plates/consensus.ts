import { PLATE_LIMITS } from "../../../shared/src/limits";

/**
 * Turn several single-frame plate readings into one defensible answer.
 *
 * A single OCR result is never trusted. Frames of the same vehicle disagree in
 * characteristic ways — a `1` read as `I`, an `8` read as `B` — and the honest
 * way to resolve that is agreement across independent looks, not a substitution
 * table applied to one reading. So readings are first grouped by the shape they
 * *could* share, then each character position is decided by a weighted vote
 * among the characters actually observed there. Nothing is ever padded or
 * invented: a position only exists if every voter in the group had one.
 *
 * When the winner does not clear both the supporting-frame floor and the
 * confidence floor, the answer is `null` and the UI says the plate is
 * unreadable. That is a correct outcome, not a failure.
 */
export interface PlateObservation {
  text: string | null;
  /** OCR confidence for `text`; null exactly when `text` is null. */
  confidence: number | null;
  detectorConfidence: number | null;
  /** Crop quality in (0,1]; how much this look is worth relative to others. */
  quality: number;
  /** Independent captured source frame. Variants/retries share this key. */
  sourceFrame?: string;
}
export interface PlateConsensus {
  plateText: string | null;
  plateConfidence: number | null;
  supportingFrames: number;
  detectorConfidence: number | null;
  /** Readings considered, including those that read nothing. */
  observations: number;
}
/**
 * Glyph pairs that genuinely confuse plate OCR. Used only to decide which
 * readings are candidates for the *same* plate, never to rewrite a reading.
 */
const CONFUSABLE = ["0ODQ", "1IL", "2Z", "5S", "8B", "6G", "7T"];
const CLASS_OF = new Map<string, string>();
for (const group of CONFUSABLE)
  for (const character of group) CLASS_OF.set(character, group[0]!);
/** Characters that may be confused are folded to one representative. */
export const shapeKey = (text: string) =>
  [...text].map((character) => CLASS_OF.get(character) ?? character).join("");

export function plateConsensus(
  observations: readonly PlateObservation[],
): PlateConsensus {
  const distinct = new Map<string, PlateObservation>();
  observations.forEach((observation, index) => {
    const key = observation.sourceFrame ?? `legacy:${index}`;
    const prior = distinct.get(key);
    const weight = (value: PlateObservation) =>
      Math.max(0, value.confidence ?? 0) * Math.max(0.05, value.quality);
    if (!prior || weight(observation) > weight(prior))
      distinct.set(key, observation);
  });
  observations = [...distinct.values()];
  const readings = observations.filter(
    (observation): observation is PlateObservation & { text: string } =>
      typeof observation.text === "string" && observation.text.length > 0,
  );
  const empty: PlateConsensus = {
    plateText: null,
    plateConfidence: null,
    supportingFrames: 0,
    detectorConfidence: null,
    observations: observations.length,
  };
  if (!readings.length) return empty;
  const weightOf = (observation: PlateObservation) =>
    Math.max(0, observation.confidence ?? 0) *
    Math.max(0.05, Math.min(1, observation.quality));
  // Total weight includes blank readings: a vehicle the worker repeatedly could
  // not read is evidence against whatever the one lucky frame claimed.
  const total = observations.reduce(
    (sum, observation) =>
      sum + Math.max(weightOf(observation), observation.text ? 0 : 0.25),
    0,
  );
  const groups = new Map<string, (PlateObservation & { text: string })[]>();
  for (const reading of readings) {
    const key = shapeKey(reading.text);
    const group = groups.get(key);
    if (group) group.push(reading);
    else groups.set(key, [reading]);
  }
  let best: {
    members: (PlateObservation & { text: string })[];
    weight: number;
  } | null = null;
  for (const members of groups.values()) {
    const weight = members.reduce((sum, member) => sum + weightOf(member), 0);
    if (!best || weight > best.weight) best = { members, weight };
  }
  if (!best) return empty;
  const { members, weight } = best;
  // Every member of a group shares a shape, so they share a length; resolving a
  // position is a vote among the characters that were actually seen there.
  const length = members[0]!.text.length;
  let text = "";
  let agreement = 0;
  for (let index = 0; index < length; index++) {
    const votes = new Map<string, number>();
    for (const member of members) {
      const character = member.text[index]!;
      votes.set(character, (votes.get(character) ?? 0) + weightOf(member));
    }
    let winner = "";
    let winnerWeight = 0;
    let castTotal = 0;
    for (const [character, value] of votes) {
      castTotal += value;
      if (
        value > winnerWeight ||
        (value === winnerWeight && character < winner)
      ) {
        winner = character;
        winnerWeight = value;
      }
    }
    text += winner;
    agreement += castTotal > 0 ? winnerWeight / castTotal : 0;
  }
  const supportingFrames = members.length;
  const share = total > 0 ? weight / total : 0;
  const meanConfidence =
    members.reduce((sum, member) => sum + (member.confidence ?? 0), 0) /
    supportingFrames;
  const positional = length > 0 ? agreement / length : 0;
  const plateConfidence = Math.max(
    0,
    Math.min(1, share * meanConfidence * positional),
  );
  const detectorConfidences = members
    .map((member) => member.detectorConfidence)
    .filter((value): value is number => typeof value === "number");
  const detectorConfidence = detectorConfidences.length
    ? Math.max(...detectorConfidences)
    : null;
  if (
    supportingFrames < PLATE_LIMITS.minSupportingFrames ||
    plateConfidence < PLATE_LIMITS.minConfidence
  )
    return {
      ...empty,
      supportingFrames,
      detectorConfidence,
    };
  return {
    plateText: text,
    plateConfidence,
    supportingFrames,
    detectorConfidence,
    observations: observations.length,
  };
}
