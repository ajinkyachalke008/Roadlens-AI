export type SpeedUnit = "mph" | "km/h";
export const speedFactor = (unit: SpeedUnit) =>
  unit === "mph" ? 2.2369362921 : 3.6;
export const displaySpeed = (
  speed: number | null | undefined,
  unit: SpeedUnit,
) =>
  speed == null ? "—" : `${(speed * speedFactor(unit)).toFixed(1)} ${unit}`;
