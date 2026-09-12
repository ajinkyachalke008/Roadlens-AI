/**
 * Hard tier.
 *
 * The main suite is a correctness set: every modern tracker should pass it, and
 * one that does not has a real defect. It cannot rank trackers, because they all
 * reach the ceiling. These scenarios are deliberately adversarial - dense
 * traffic, long occlusions, near-identical neighbours, degraded cadence - so the
 * ranking and, more importantly, the false-merge behaviour are visible.
 */
import { build, linear, type GroundTruthObject, type Scenario } from "./scenarios";

const lane = (
  id: number,
  y: number,
  startMs: number,
  reverse = false,
  size = 0.14,
): GroundTruthObject =>
  linear({
    id,
    from: reverse ? [1.02, y] : [-0.02, y],
    to: reverse ? [-0.02, y] : [1.02, y],
    size: [size, size * 0.8],
    startMs,
    endMs: startMs + 3500,
  });

export function stress(): Scenario[] {
  return [
    build({
      name: "dense-queue",
      purpose: "Six near-identical cars nose to tail: the classic merge trap.",
      hz: 10,
      durationMs: 5000,
      objects: Array.from({ length: 6 }, (_, i) =>
        linear({
          id: i + 1,
          from: [0.08 + i * 0.15, 0.6],
          to: [0.3 + i * 0.115, 0.62],
          size: [0.12, 0.1],
          startMs: 0,
          endMs: 5000,
        }),
      ),
      noise: { seed: 201, dropout: 0.08, classFlip: 0.06 },
    }),
    build({
      name: "opposing-lanes",
      purpose: "Two streams crossing in opposite directions at the same scale.",
      hz: 10,
      durationMs: 5000,
      objects: [
        lane(1, 0.55, 0),
        lane(2, 0.56, 900),
        lane(3, 0.7, 200, true, 0.16),
        lane(4, 0.71, 1300, true, 0.16),
      ],
      noise: { seed: 202, dropout: 0.07, classFlip: 0.05 },
    }),
    build({
      name: "long-occlusion",
      purpose: "A full second hidden behind a bus, at 10 Hz.",
      hz: 10,
      durationMs: 6000,
      objects: [
        linear({
          id: 1,
          from: [0.1, 0.6],
          to: [0.9, 0.6],
          size: [0.14, 0.12],
          startMs: 0,
          endMs: 6000,
        }),
      ],
      occlusions: [{ id: 1, frames: [25, 26, 27, 28, 29, 30, 31, 32, 33, 34] }],
      noise: { seed: 203, dropout: 0 },
    }),
    build({
      name: "heavy-dropout",
      purpose: "A detector missing one frame in four.",
      hz: 10,
      durationMs: 5000,
      objects: [
        linear({
          id: 1,
          from: [0.12, 0.58],
          to: [0.88, 0.63],
          size: [0.13, 0.11],
          startMs: 0,
          endMs: 5000,
        }),
        linear({
          id: 2,
          from: [0.9, 0.7],
          to: [0.15, 0.68],
          size: [0.18, 0.15],
          startMs: 0,
          endMs: 5000,
        }),
      ],
      noise: { seed: 204, dropout: 0.25, classFlip: 0.08 },
    }),
    build({
      name: "degraded-cadence",
      purpose: "3 Hz analysis: a third of a second between observations.",
      hz: 3,
      durationMs: 7000,
      objects: [
        linear({
          id: 1,
          from: [0.05, 0.55],
          to: [0.95, 0.62],
          size: [0.16, 0.13],
          startMs: 0,
          endMs: 7000,
        }),
        linear({
          id: 2,
          from: [0.95, 0.68],
          to: [0.05, 0.64],
          size: [0.19, 0.16],
          startMs: 500,
          endMs: 6500,
        }),
      ],
      noise: { seed: 205, dropout: 0.05 },
    }),
    build({
      name: "small-and-crowded",
      purpose: "Four distant vehicles whose boxes are smaller than their travel.",
      hz: 8,
      durationMs: 5000,
      objects: Array.from({ length: 4 }, (_, i) =>
        linear({
          id: i + 1,
          from: [0.2 + i * 0.04, 0.42 + i * 0.012],
          to: [0.75 + i * 0.04, 0.45 + i * 0.012],
          size: [0.045, 0.035],
          startMs: i * 200,
          endMs: 5000,
        }),
      ),
      noise: { seed: 206, jitter: 0.07, dropout: 0.1, classFlip: 0.05 },
    }),
    build({
      name: "stop-and-go",
      purpose: "A vehicle that halts, is passed, then moves again.",
      hz: 10,
      durationMs: 6000,
      objects: [
        {
          id: 1,
          className: "car" as const,
          at: (t: number) => {
            if (t > 6000) return null;
            const x = t < 2000 ? 0.2 + (t / 2000) * 0.2 : t < 4000 ? 0.4 : 0.4 + ((t - 4000) / 2000) * 0.3;
            const w = 0.15,
              h = 0.12;
            return [x - w / 2, 0.6 - h / 2, x + w / 2, 0.6 + h / 2] as [
              number,
              number,
              number,
              number,
            ];
          },
        },
        linear({
          id: 2,
          from: [0.05, 0.52],
          to: [0.95, 0.54],
          size: [0.15, 0.12],
          startMs: 1500,
          endMs: 4500,
        }),
      ],
      noise: { seed: 207, dropout: 0.06, classFlip: 0.05 },
    }),
  ];
}
