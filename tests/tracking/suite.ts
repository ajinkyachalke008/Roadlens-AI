/**
 * The RoadLens tracking evaluation set.
 *
 * Synthetic rather than filmed, deliberately: identity metrics need per-frame
 * ground-truth association, and hand-labelling phone footage frame by frame
 * would give a smaller, less reproducible and less legally clean set than
 * generating the exact motion regimes the product meets. The regimes and the
 * detector noise model are taken from measured RoadLens behaviour - see
 * docs/TRACKING_EVALUATION.md. Filmed footage is used separately, for detector
 * recall, where ground truth is per-frame class presence rather than identity.
 */
import { build, linear, type Scenario } from "./scenarios";

/** Analysis cadence actually delivered by the bounded GPU pipeline. */
export const ANALYSIS_HZ = 10;
/** Worst cadence still expected to work: congested relay or browser fallback. */
export const SLOW_HZ = 5;

export function suite(): Scenario[] {
  return [
    build({
      name: "single-car-continuous",
      purpose: "One vehicle, 60+ analysis frames: the headline continuity case.",
      hz: ANALYSIS_HZ,
      durationMs: 6000,
      objects: [
        linear({
          id: 1,
          from: [0.15, 0.55],
          to: [0.85, 0.62],
          size: [0.18, 0.14],
          startMs: 0,
          endMs: 6000,
        }),
      ],
      noise: { seed: 101 },
    }),
    build({
      name: "fast-lateral",
      purpose:
        "A near vehicle crossing the frame in 1.5 s: large inter-frame displacement.",
      hz: ANALYSIS_HZ,
      durationMs: 1600,
      objects: [
        linear({
          id: 1,
          from: [0.05, 0.6],
          to: [0.95, 0.6],
          size: [0.2, 0.16],
          startMs: 0,
          endMs: 1500,
        }),
      ],
      noise: { seed: 102 },
    }),
    build({
      name: "distant-small-car",
      purpose:
        "A small distant box moving further than its own width per frame.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.45],
          to: [0.8, 0.47],
          size: [0.05, 0.04],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      noise: { seed: 103, jitter: 0.05 },
    }),
    build({
      name: "one-frame-miss",
      purpose: "Detector drops a single frame; identity must survive.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.6],
          to: [0.8, 0.6],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      occlusions: [{ id: 1, frames: [12, 25] }],
      noise: { seed: 104, dropout: 0 },
    }),
    build({
      name: "two-frame-miss",
      purpose: "Two consecutive missed detections.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.6],
          to: [0.8, 0.6],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      occlusions: [{ id: 1, frames: [14, 15] }],
      noise: { seed: 105, dropout: 0 },
    }),
    build({
      name: "five-frame-occlusion",
      purpose: "A vehicle behind a pole or van for half a second.",
      hz: ANALYSIS_HZ,
      durationMs: 5000,
      objects: [
        linear({
          id: 1,
          from: [0.15, 0.6],
          to: [0.85, 0.6],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 5000,
        }),
      ],
      occlusions: [{ id: 1, frames: [20, 21, 22, 23, 24] }],
      noise: { seed: 106, dropout: 0 },
    }),
    build({
      name: "confidence-dip",
      purpose:
        "Score collapses below the new-track floor without the vehicle changing.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.6],
          to: [0.8, 0.6],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      confidenceDips: [{ id: 1, frames: [10, 11, 12, 13], score: 0.28 }],
      noise: { seed: 107, dropout: 0 },
    }),
    build({
      name: "partial-occlusion",
      purpose: "Box truncated to 55% while emerging from behind an obstruction.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.6],
          to: [0.8, 0.6],
          size: [0.18, 0.14],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      truncations: [{ id: 1, frames: [15, 16, 17], keep: 0.55 }],
      noise: { seed: 108, dropout: 0 },
    }),
    build({
      name: "two-cars-crossing",
      purpose:
        "Opposing vehicles whose boxes overlap mid-scene: the false-merge test.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.1, 0.55],
          to: [0.9, 0.62],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 4000,
        }),
        linear({
          id: 2,
          from: [0.9, 0.6],
          to: [0.1, 0.55],
          size: [0.15, 0.13],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      noise: { seed: 109 },
    }),
    build({
      name: "parallel-cars",
      purpose: "Two vehicles in adjacent lanes, similar size and heading.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.15, 0.52],
          to: [0.8, 0.52],
          size: [0.14, 0.11],
          startMs: 0,
          endMs: 4000,
        }),
        linear({
          id: 2,
          from: [0.15, 0.68],
          to: [0.8, 0.68],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      noise: { seed: 110 },
    }),
    build({
      name: "approaching-vehicle",
      purpose:
        "Box grows fourfold as a vehicle approaches: scale change, not translation.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.5, 0.45],
          to: [0.52, 0.7],
          size: [0.07, 0.06],
          endSize: [0.3, 0.26],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      noise: { seed: 111 },
    }),
    build({
      name: "class-wobble",
      purpose:
        "car/truck ambiguity on an SUV: the class gate must not cut identity.",
      hz: ANALYSIS_HZ,
      durationMs: 4000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.6],
          to: [0.8, 0.6],
          size: [0.19, 0.16],
          startMs: 0,
          endMs: 4000,
        }),
      ],
      classFlips: [
        { id: 1, frames: [8, 9, 14, 20, 21, 22, 30], className: "truck" },
      ],
      noise: { seed: 112, dropout: 0, classFlip: 0 },
    }),
    build({
      name: "motorcycle",
      purpose: "Small two-wheeler, faster and jumpier than a car.",
      hz: ANALYSIS_HZ,
      durationMs: 3000,
      objects: [
        linear({
          id: 1,
          className: "motorcycle",
          from: [0.1, 0.62],
          to: [0.9, 0.58],
          size: [0.07, 0.09],
          startMs: 0,
          endMs: 2800,
        }),
      ],
      noise: { seed: 113, jitter: 0.05 },
    }),
    build({
      name: "leave-and-reenter",
      purpose:
        "A vehicle exits and a different one enters: identities must not be recycled.",
      hz: ANALYSIS_HZ,
      durationMs: 6000,
      objects: [
        linear({
          id: 1,
          from: [0.2, 0.6],
          to: [0.95, 0.6],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 2000,
        }),
        linear({
          id: 2,
          from: [0.05, 0.6],
          to: [0.8, 0.6],
          size: [0.16, 0.13],
          startMs: 4000,
          endMs: 6000,
        }),
      ],
      noise: { seed: 114 },
    }),
    build({
      name: "slow-cadence",
      purpose: "Congested relay at 5 Hz: displacement per frame doubles.",
      hz: SLOW_HZ,
      durationMs: 6000,
      objects: [
        linear({
          id: 1,
          from: [0.1, 0.55],
          to: [0.9, 0.62],
          size: [0.15, 0.12],
          startMs: 0,
          endMs: 6000,
        }),
        linear({
          id: 2,
          from: [0.85, 0.7],
          to: [0.15, 0.66],
          size: [0.2, 0.16],
          startMs: 1000,
          endMs: 5000,
        }),
      ],
      noise: { seed: 115 },
    }),
    build({
      name: "mixed-traffic",
      purpose: "Five objects of four classes sharing a scene, the realistic load.",
      hz: ANALYSIS_HZ,
      durationMs: 5000,
      objects: [
        linear({
          id: 1,
          from: [0.1, 0.55],
          to: [0.9, 0.6],
          size: [0.15, 0.12],
          startMs: 0,
          endMs: 5000,
        }),
        linear({
          id: 2,
          className: "truck",
          from: [0.95, 0.65],
          to: [0.1, 0.62],
          size: [0.22, 0.2],
          startMs: 500,
          endMs: 5000,
        }),
        linear({
          id: 3,
          className: "person",
          from: [0.3, 0.8],
          to: [0.36, 0.82],
          size: [0.05, 0.14],
          startMs: 0,
          endMs: 5000,
        }),
        linear({
          id: 4,
          className: "motorcycle",
          from: [0.2, 0.48],
          to: [0.85, 0.5],
          size: [0.06, 0.08],
          startMs: 1500,
          endMs: 4500,
        }),
        linear({
          id: 5,
          from: [0.45, 0.42],
          to: [0.55, 0.44],
          size: [0.05, 0.04],
          startMs: 0,
          endMs: 5000,
        }),
      ],
      noise: { seed: 116 },
    }),
  ];
}
