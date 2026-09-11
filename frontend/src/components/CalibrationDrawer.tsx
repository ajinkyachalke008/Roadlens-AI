import { useEffect, useRef, useState } from "react";
import {
  createCalibration,
  type Calibration,
  type Correspondence,
  type Point,
} from "../geometry/calibration";
import type { CompletedFrame } from "../camera/capture";
import { Drawer } from "./Drawer";
export function CalibrationDrawer({
  frame,
  onSave,
  onClose,
}: {
  frame: CompletedFrame;
  onSave: (c: Calibration, frozen: CompletedFrame) => void;
  onClose: () => void;
}) {
  const [frozen] = useState(frame);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [world, setWorld] = useState<string[][]>(
    Array.from({ length: 5 }, () => ["", ""]),
  );
  const [length, setLength] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = frozen.canvas.width;
    c.height = frozen.canvas.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(frozen.canvas, 0, 0);
    points.forEach(([x, y], i) => {
      ctx.fillStyle = "#b7efc5";
      ctx.beginPath();
      ctx.arc(x * c.width, y * c.height, c.width / 80, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.font = `bold ${c.width / 50}px system-ui`;
      ctx.fillText(String(i + 1), x * c.width + 10, y * c.height);
    });
  }, [points, frozen]);
  function submit() {
    try {
      if (
        points.length !== 5 ||
        world.some((p) => p.some((v) => v.trim() === "")) ||
        !length.trim()
      )
        throw new Error(
          "Enter five measured points and the independent reference length.",
        );
      const pairs: Correspondence[] = points.map((image, i) => ({
        image,
        world: [Number(world[i][0]), Number(world[i][1])],
      }));
      const calibration = createCalibration({
        pairs: pairs.slice(0, 4),
        check: { ...pairs[4], checkedLengthM: Number(length) },
        zone: points.slice(0, 4),
        frameWidth: frozen.result.frameWidth,
        frameHeight: frozen.result.frameHeight,
        captureEpoch: frozen.result.captureEpoch,
        stationaryConfirmed: confirmed,
      });
      onSave(calibration, frozen);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Calibration rejected");
    }
  }
  return (
    <Drawer title="Measured calibration" onClose={onClose}>
      <p>
        Mark four road-plane corners in order, then a fifth independent check
        point. Enter measured world coordinates in meters.
      </p>
      <canvas
        className="calibration-frame"
        ref={canvas}
        aria-label="Frozen calibration frame. Click five points, or enter normalized coordinates below."
        onClick={(e) => {
          if (points.length >= 5) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setPoints([
            ...points,
            [
              (e.clientX - rect.left) / rect.width,
              (e.clientY - rect.top) / rect.height,
            ],
          ]);
        }}
      />
      <div className="actions">
        <button
          onClick={() => setPoints(points.slice(0, -1))}
          disabled={!points.length}
        >
          Undo point
        </button>
        <button
          disabled={points.length >= 5}
          onClick={() => setPoints([...points, [0, 0]])}
        >
          Add coordinate row
        </button>
      </div>
      {points.map((point, i) => (
        <fieldset className="point-row" key={i}>
          <legend>{i === 4 ? "Independent check" : `Corner ${i + 1}`}</legend>
          {["Image X (0–1)", "Image Y (0–1)", "World X (m)", "World Y (m)"].map(
            (label, j) => (
              <label key={label}>
                {label}
                <input
                  type="number"
                  step="any"
                  value={j < 2 ? point[j] : world[i][j - 2]}
                  onChange={(e) => {
                    if (j < 2)
                      setPoints(
                        points.map((p, k) =>
                          k === i
                            ? (p.map((v, a) =>
                                a === j ? Number(e.target.value) : v,
                              ) as Point)
                            : p,
                        ),
                      );
                    else
                      setWorld(
                        world.map((p, k) =>
                          k === i
                            ? p.map((v, a) =>
                                a === j - 2 ? e.target.value : v,
                              )
                            : p,
                        ),
                      );
                  }}
                />
              </label>
            ),
          )}
        </fieldset>
      ))}
      <label>
        Independent measured reference length (m)
        <input
          type="number"
          min="0.01"
          step="any"
          value={length}
          onChange={(e) => setLength(e.target.value)}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Camera is fixed; points are measured on an approximately planar road.
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" onClick={submit}>
        Validate calibration
      </button>
      <p className="footnote">
        An independent geometry check does not establish field speed accuracy.
        Movement or uncertain background verification disables speed.
      </p>
    </Drawer>
  );
}
