import type { Report } from "../../../shared/src/schemas";
import {
  summarize,
  validationNotice,
  type SpeedTrial,
} from "../validation/speedTrial";
export const exportNotice =
  "Hackathon prototype; review candidates; not certified enforcement. Downloads cannot be revoked.";
export function jsonExport(reports: Report[]) {
  return JSON.stringify({ notice: exportNotice, reports }, null, 2);
}
export function csvCell(value: unknown) {
  const s = value === null || value === undefined ? "" : String(value);
  return (
    '"' +
    (/^[\s]*[=+@\-\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') +
    '"'
  );
}
export function csvExport(reports: Report[]) {
  const keys = [
    "reportId",
    "kind",
    "sourceMode",
    "capturedAtIso",
    "className",
    "trackId",
    "speedMps",
    "review",
    "revision",
  ] as const;
  return [
    csvCell(exportNotice),
    keys.join(","),
    ...reports.map((r) => keys.map((k) => csvCell(r[k])).join(",")),
  ].join("\r\n");
}
const trialKeys = [
  "passIndex",
  "trialId",
  "capturedAtIso",
  "captureEpoch",
  "calibrationVersion",
  "trackId",
  "className",
  "estimatedMps",
  "referenceMps",
  "referenceMethod",
  "residualM",
  "sampleCount",
  "coverageMs",
  "trajectoryPoints",
  "notes",
] as const;
/**
 * A finite number cannot be a formula, so numeric columns skip the apostrophe
 * that `csvCell` prefixes to anything starting with `-`. Without this a signed
 * error of -2 would export as '-2 and stop being analysable as a number.
 */
export function csvNumber(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '""'
    : `"${value}"`;
}
const numericTrialKeys = new Set<string>([
  "passIndex",
  "trackId",
  "estimatedMps",
  "referenceMps",
  "residualM",
  "sampleCount",
  "coverageMs",
  "trajectoryPoints",
]);
/** Signed error is derived, never stored, so exports cannot disagree with it. */
const signedErrorMps = (trial: SpeedTrial) =>
  trial.estimatedMps - trial.referenceMps;
export function speedValidationJson(trials: readonly SpeedTrial[]) {
  return JSON.stringify(
    {
      notice: validationNotice,
      summary: summarize(trials),
      trials: trials.map((trial) => ({
        ...trial,
        signedErrorMps: signedErrorMps(trial),
        absoluteErrorMps: Math.abs(signedErrorMps(trial)),
      })),
    },
    null,
    2,
  );
}
export function speedValidationCsv(trials: readonly SpeedTrial[]) {
  return [
    csvCell(validationNotice),
    [...trialKeys, "signedErrorMps", "absoluteErrorMps"].join(","),
    ...trials.map((trial) =>
      [
        ...trialKeys.map((key) =>
          numericTrialKeys.has(key)
            ? csvNumber(trial[key] as number | null)
            : csvCell(trial[key]),
        ),
        csvNumber(signedErrorMps(trial)),
        csvNumber(Math.abs(signedErrorMps(trial))),
      ].join(","),
    ),
  ].join("\r\n");
}
export function download(
  data: string | Blob,
  filename: string,
  type = "application/json",
) {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
