import { Matrix, SingularValueDecomposition } from "ml-matrix";
export type Point = [number, number];
export interface Correspondence {
  image: Point;
  world: Point;
}
export interface CalibrationInput {
  pairs: Correspondence[];
  check: Correspondence & { checkedLengthM: number };
  zone: Point[];
  frameWidth: number;
  frameHeight: number;
  captureEpoch: string;
  stationaryConfirmed: boolean;
}
export interface Calibration extends CalibrationInput {
  version: string;
  H: number[];
  units: "meters";
  independentErrorM: number;
  fitResidualM: number;
  assumedPlanarRoad: true;
}
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const validPoint = (p: Point) => p.length === 2 && p.every(Number.isFinite);
export function validPolygon(p: Point[]): boolean {
  if (
    p.length < 3 ||
    p.length > 16 ||
    p.some((v) => !validPoint(v) || v.some((x) => x < 0 || x > 1))
  )
    return false;
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!,
      b = p[(i + 1) % p.length]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) return false;
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 1; j < p.length; j++) {
      if (j === i + 1 || (i === 0 && j === p.length - 1)) continue;
      const c = p[j]!,
        d = p[(j + 1) % p.length]!;
      if (
        cross(a, b, c) * cross(a, b, d) <= 0 &&
        cross(c, d, a) * cross(c, d, b) <= 0
      )
        return false;
    }
  }
  return Math.abs(area) > 1e-6;
}
export function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (
      Math.abs(cross(a, b, point)) < 1e-9 &&
      point[0] >= Math.min(a[0], b[0]) &&
      point[0] <= Math.max(a[0], b[0]) &&
      point[1] >= Math.min(a[1], b[1]) &&
      point[1] <= Math.max(a[1], b[1])
    )
      return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
export function project(H: number[], p: Point): Point | null {
  if (H.length !== 9 || H.some((x) => !Number.isFinite(x)) || !validPoint(p))
    return null;
  const denominator = H[6]! * p[0] + H[7]! * p[1] + H[8]!;
  const norm = Math.hypot(H[6]!, H[7]!, H[8]!);
  if (Math.abs(denominator) < 1e-5 * Math.max(1, norm)) return null;
  const result: Point = [
    (H[0]! * p[0] + H[1]! * p[1] + H[2]!) / denominator,
    (H[3]! * p[0] + H[4]! * p[1] + H[5]!) / denominator,
  ];
  return result.every(Number.isFinite) && result.every((v) => Math.abs(v) < 1e6)
    ? result
    : null;
}
function normalize(points: Point[]) {
  const mean: Point = [
    points.reduce((s, p) => s + p[0], 0) / points.length,
    points.reduce((s, p) => s + p[1], 0) / points.length,
  ];
  const distance =
    points.reduce((s, p) => s + Math.hypot(p[0] - mean[0], p[1] - mean[1]), 0) /
    points.length;
  if (
    !mean.every(Number.isFinite) ||
    !Number.isFinite(distance) ||
    distance < 1e-9
  )
    throw new Error(
      "calibration_invalid: coincident points or invalid numeric scale",
    );
  const scale = Math.SQRT2 / distance;
  return {
    points: points.map(
      (p) => [(p[0] - mean[0]) * scale, (p[1] - mean[1]) * scale] as Point,
    ),
    T: new Matrix([
      [scale, 0, -scale * mean[0]],
      [0, scale, -scale * mean[1]],
      [0, 0, 1],
    ]),
    inverse: new Matrix([
      [1 / scale, 0, mean[0]],
      [0, 1 / scale, mean[1]],
      [0, 0, 1],
    ]),
  };
}
export function solveHomography(pairs: Correspondence[]): number[] {
  if (
    pairs.length < 4 ||
    pairs.length > 16 ||
    pairs.some((p) => !validPoint(p.image) || !validPoint(p.world))
  )
    throw new Error("calibration_invalid: need 4–16 finite measured pairs");
  const image = normalize(pairs.map((p) => p.image)),
    world = normalize(pairs.map((p) => p.world));
  const rows: number[][] = [];
  image.points.forEach(([x, y], i) => {
    const [u, v] = world.points[i]!;
    rows.push(
      [-x, -y, -1, 0, 0, 0, u * x, u * y, u],
      [0, 0, 0, -x, -y, -1, v * x, v * y, v],
    );
  });
  // A zero row preserves the nullspace and makes the four-point 8×9 system square for full V.
  while (rows.length < 9) rows.push(Array<number>(9).fill(0));
  const svd = new SingularValueDecomposition(new Matrix(rows), {
    autoTranspose: false,
  });
  if (svd.diagonal[7]! < svd.diagonal[0]! * 1e-7)
    throw new Error(
      "calibration_invalid: rank deficient or poorly conditioned",
    );
  const vector = svd.rightSingularVectors.getColumn(8);
  const h = world.inverse
    .mmul(
      new Matrix([vector.slice(0, 3), vector.slice(3, 6), vector.slice(6, 9)]),
    )
    .mmul(image.T)
    .to1DArray();
  if (h.some((x) => !Number.isFinite(x)))
    throw new Error("calibration_invalid: invalid numeric scale");
  const divisor = Math.abs(h[8]!) > 1e-9 ? h[8]! : Math.hypot(...h);
  return h.map((value) => value / divisor);
}
export function createCalibration(input: CalibrationInput): Calibration {
  if (!input.stationaryConfirmed) throw new Error("handheld");
  if (
    !Number.isInteger(input.frameWidth) ||
    !Number.isInteger(input.frameHeight) ||
    input.frameWidth <= 0 ||
    input.frameHeight <= 0 ||
    !input.captureEpoch
  )
    throw new Error("calibration_invalid: capture geometry");
  if (!validPolygon(input.zone))
    throw new Error("calibration_invalid: invalid measurement polygon");
  if (
    !validPoint(input.check.image) ||
    input.check.image.some((x) => x < 0 || x > 1) ||
    !validPoint(input.check.world) ||
    input.check.checkedLengthM <= 0 ||
    !Number.isFinite(input.check.checkedLengthM)
  )
    throw new Error("calibration_invalid: independent check required");
  if (input.pairs.some((p) => p.image.some((x) => x < 0 || x > 1)))
    throw new Error("calibration_invalid: image points must be normalized");
  if (
    input.pairs.some(
      (p) =>
        Math.hypot(
          p.image[0] - input.check.image[0],
          p.image[1] - input.check.image[1],
        ) < 1e-5,
    )
  )
    throw new Error("calibration_invalid: check must not be a fitted point");
  const H = solveHomography(input.pairs),
    checked = project(H, input.check.image);
  if (!checked || input.zone.some((p) => project(H, p) === null))
    throw new Error("calibration_invalid: unstable projection");
  const denominators = input.zone.map(
    (p) => H[6]! * p[0] + H[7]! * p[1] + H[8]!,
  );
  if (Math.min(...denominators) * Math.max(...denominators) <= 0)
    throw new Error("calibration_invalid: zone crosses horizon");
  const independentErrorM = Math.hypot(
    checked[0] - input.check.world[0],
    checked[1] - input.check.world[1],
  );
  if (independentErrorM > Math.max(0.5, input.check.checkedLengthM * 0.05))
    throw new Error("calibration_invalid: independent check failed");
  const fitResidualM = Math.max(
    ...input.pairs.map((p) => {
      const q = project(H, p.image);
      return q ? Math.hypot(q[0] - p.world[0], q[1] - p.world[1]) : Infinity;
    }),
  );
  if (fitResidualM > Math.max(0.5, input.check.checkedLengthM * 0.05))
    throw new Error("calibration_invalid: excessive fit residual");
  return {
    ...structuredClone(input),
    version: crypto.randomUUID(),
    H,
    units: "meters",
    independentErrorM,
    fitResidualM,
    assumedPlanarRoad: true,
  };
}
