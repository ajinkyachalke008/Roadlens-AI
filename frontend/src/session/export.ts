import type { Report } from "../../../shared/src/schemas";
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
