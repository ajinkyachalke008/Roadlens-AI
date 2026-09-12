/**
 * Deterministic traffic scenarios with ground truth, for tracker evaluation.
 *
 * RoadLens tracks camera-side on *analysis* frames, not camera frames: the
 * bounded two-frame GPU pipeline delivers results at roughly 5-12 Hz while the
 * preview runs at 30-60. Inter-frame displacement is therefore large, which is
 * precisely the regime where an IoU-only association breaks down. Every
 * scenario here is parameterised by analysis Hz for that reason.
 *
 * Coordinates are normalised to the source frame, matching Detection.bbox.
 */
import type { Box, ClassName, Detection } from "../../frontend/src/tracking/tracker";

/** Small deterministic PRNG: reproducible fixtures, no test flake. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export interface GroundTruthObject {
  id: number;
  className: ClassName;
  /** Box at a source time, or null when the object is not in frame. */
  at: (tMs: number) => Box | null;
}

export interface FrameSample {
  sourceTimeMs: number;
  detections: Detection[];
  /** Parallel to `detections`: the ground-truth object each came from. */
  truth: number[];
  /** Ground-truth boxes present in this frame, by object id. */
  present: Map<number, Box>;
}

export interface Scenario {
  name: string;
  /** What this scenario is evidence about. */
  purpose: string;
  hz: number;
  frames: FrameSample[];
}

export interface NoiseModel {
  /** Box jitter as a fraction of box size (YOLO corner noise). */
  jitter: number;
  /** Probability a present object produces no detection in a frame. */
  dropout: number;
  meanScore: number;
  scoreNoise: number;
  /** Probability a vehicle is reported as a confusable neighbour class. */
  classFlip: number;
  seed: number;
}

export const DEFAULT_NOISE: NoiseModel = {
  jitter: 0.02,
  dropout: 0.04,
  meanScore: 0.82,
  scoreNoise: 0.07,
  classFlip: 0.03,
  seed: 12345,
};

const CONFUSABLE: Partial<Record<ClassName, ClassName>> = {
  car: "truck",
  truck: "car",
  bus: "truck",
  motorcycle: "bicycle",
  bicycle: "motorcycle",
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A box from centre, size, in normalised coordinates. */
export function box(cx: number, cy: number, w: number, h: number): Box {
  return [clamp01(cx - w / 2), clamp01(cy - h / 2), clamp01(cx + w / 2), clamp01(cy + h / 2)];
}

/** Linear traversal: an object crossing the frame at constant image velocity. */
export function linear(options: {
  id: number;
  className?: ClassName;
  from: [number, number];
  to: [number, number];
  size: [number, number];
  /** Size at the end, for approaching/receding motion. Defaults to `size`. */
  endSize?: [number, number];
  startMs: number;
  endMs: number;
}): GroundTruthObject {
  const { from, to, size, startMs, endMs } = options;
  const endSize = options.endSize ?? size;
  return {
    id: options.id,
    className: options.className ?? "car",
    at: (t) => {
      if (t < startMs || t > endMs) return null;
      const u = (t - startMs) / Math.max(1, endMs - startMs);
      return box(
        from[0] + (to[0] - from[0]) * u,
        from[1] + (to[1] - from[1]) * u,
        size[0] + (endSize[0] - size[0]) * u,
        size[1] + (endSize[1] - size[1]) * u,
      );
    },
  };
}

export interface BuildOptions {
  name: string;
  purpose: string;
  objects: GroundTruthObject[];
  durationMs: number;
  hz: number;
  noise?: Partial<NoiseModel>;
  /** Frame indices (0-based) in which the named objects produce no detection. */
  occlusions?: { id: number; frames: number[] }[];
  /** Frame indices in which the named object's score is forced low. */
  confidenceDips?: { id: number; frames: number[]; score: number }[];
  /** Frame indices in which the named object is reported as another class. */
  classFlips?: { id: number; frames: number[]; className: ClassName }[];
  /** Frame indices in which the object's box is truncated (partial occlusion). */
  truncations?: { id: number; frames: number[]; keep: number }[];
}

export function build(options: BuildOptions): Scenario {
  const noise = { ...DEFAULT_NOISE, ...options.noise };
  const random = rng(noise.seed);
  const step = 1000 / options.hz;
  const frames: FrameSample[] = [];
  const forced = (
    list: { id: number; frames: number[] }[] | undefined,
    id: number,
    frame: number,
  ) => !!list?.some((e) => e.id === id && e.frames.includes(frame));
  for (let index = 0; index * step <= options.durationMs; index++) {
    const sourceTimeMs = Math.round(index * step);
    const detections: Detection[] = [];
    const truth: number[] = [];
    const present = new Map<number, Box>();
    for (const object of options.objects) {
      const gt = object.at(sourceTimeMs);
      if (!gt) continue;
      present.set(object.id, gt);
      if (forced(options.occlusions, object.id, index)) continue;
      if (random() < noise.dropout) continue;
      let bbox: Box = [...gt];
      const truncation = options.truncations?.find(
        (t) => t.id === object.id && t.frames.includes(index),
      );
      if (truncation) {
        // A vehicle emerging from behind an obstruction is detected partially:
        // the box keeps one edge and loses width, which is exactly what breaks
        // an IoU gate tuned on whole boxes.
        const width = bbox[2] - bbox[0];
        bbox = [bbox[0], bbox[1], bbox[0] + width * truncation.keep, bbox[3]];
      }
      const w = bbox[2] - bbox[0],
        h = bbox[3] - bbox[1];
      bbox = [
        clamp01(bbox[0] + (random() - 0.5) * noise.jitter * w * 2),
        clamp01(bbox[1] + (random() - 0.5) * noise.jitter * h * 2),
        clamp01(bbox[2] + (random() - 0.5) * noise.jitter * w * 2),
        clamp01(bbox[3] + (random() - 0.5) * noise.jitter * h * 2),
      ];
      if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) continue;
      const dip = options.confidenceDips?.find(
        (d) => d.id === object.id && d.frames.includes(index),
      );
      const score = dip
        ? dip.score
        : clamp01(noise.meanScore + (random() - 0.5) * noise.scoreNoise * 2);
      const flip = options.classFlips?.find(
        (f) => f.id === object.id && f.frames.includes(index),
      );
      const className = flip
        ? flip.className
        : random() < noise.classFlip
          ? (CONFUSABLE[object.className] ?? object.className)
          : object.className;
      detections.push({ className, score, bbox });
      truth.push(object.id);
    }
    frames.push({ sourceTimeMs, detections, truth, present });
  }
  return { name: options.name, purpose: options.purpose, hz: options.hz, frames };
}
