import { useEffect, useRef } from "react";
import type { FrameResult } from "../../../shared/src/schemas";
import { speedFactor, displaySpeed, type SpeedUnit } from "./speedUnits";
export interface DisplayFrame {
  result: FrameResult;
  image: CanvasImageSource;
  width: number;
  height: number;
  receivedAt: number;
  processingMs?: number;
}
export function Stage({
  frame,
  status,
  speedUnit = "mph",
}: {
  frame: DisplayFrame | null;
  status: string;
  speedUnit?: SpeedUnit;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!frame || !canvas.current) return;
    const c = canvas.current;
    c.width = frame.width;
    c.height = frame.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(frame.image, 0, 0, c.width, c.height);
    ctx.font = `600 ${Math.max(12, c.width / 65)}px system-ui`;
    ctx.lineWidth = Math.max(1.5, c.width / 450);
    for (const t of frame.result.tracks) {
      if (!t.observed) continue;
      const [x1, y1, x2, y2] = t.bbox;
      const x = x1 * c.width,
        y = y1 * c.height,
        w = (x2 - x1) * c.width,
        h = (y2 - y1) * c.height;
      const color = t.ruleState === "candidate" ? "#ffbf69" : "#a3edb8";
      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, w, h);
      const label = `${t.className} #${t.trackId}${t.speedMps !== null ? " · " + displaySpeed(t.speedMps, speedUnit) : ""}`;
      const height = Math.max(20, c.width / 40);
      const textWidth = ctx.measureText(label).width + 12;
      const top = Math.max(0, y - height);
      ctx.fillStyle = color;
      ctx.fillRect(x, top, Math.min(textWidth, c.width - x), height);
      ctx.fillStyle = "#0e1812";
      ctx.fillText(label, x + 5, top + height * 0.74);
    }
  }, [frame, speedUnit]);
  return (
    <section className="stage" aria-label="Analyzed camera frame">
      <div className="stage-top">
        <span className="stage-label">
          <i className={frame ? "dot active" : "dot"} />
          {frame?.result.sourceMode === "replay_video"
            ? "REPLAY"
            : "ANALYZED VIEW"}
        </span>
        <span>{status}</span>
      </div>
      {frame ? (
        <canvas
          ref={canvas}
          data-testid="analyzed-frame"
          data-frame-id={frame.result.frameId}
          data-provider={frame.result.executionProvider}
          aria-label={`Analyzed frame ${frame.result.frameSeq}, ${frame.result.tracks.filter((t) => t.observed).length} observed objects`}
        />
      ) : (
        <div className="stage-empty">
          <span className="viewfinder" aria-hidden="true">
            ＋
          </span>
          <h2>
            {status === "Paused" ? "Camera paused" : "Ready when you are"}
          </h2>
          <p>
            {status === "Paused"
              ? "Resume to start a fresh measurement."
              : "Completed analysis frames will appear here."}
          </p>
        </div>
      )}
      <div className="stage-bottom">
        <span>
          {frame
            ? `${frame.result.frameWidth} × ${frame.result.frameHeight}`
            : "CAMERA-SIDE INFERENCE"}
        </span>
        <span data-testid="frame-clock-label">
          {frame
            ? `Frame ${frame.result.frameSeq} · ${frame.result.sourceTimeMs.toFixed(0)} ms source time`
            : "Temporary session"}
        </span>
      </div>
    </section>
  );
}
export function Metrics({
  frame,
  previewHz = 0,
  speedUnit = "mph",
}: {
  frame: DisplayFrame | null;
  previewHz?: number;
  speedUnit?: SpeedUnit;
}) {
  const counts = frame?.result.stats.counts;
  const speed = frame?.result.stats.averageSpeedMps;
  return (
    <section className="metrics" aria-label="Measured metrics">
      <div>
        <strong>
          {counts
            ? counts.car + counts.bus + counts.truck + counts.motorcycle
            : "—"}
        </strong>
        <span>Vehicles now</span>
      </div>
      <div>
        <strong>{counts?.person ?? "—"}</strong>
        <span>People now</span>
      </div>
      <div title={frame?.result.tracks[0]?.speedReason ?? "not_calibrated"}>
        <strong>
          {speed !== undefined && speed !== null
            ? (speed * speedFactor(speedUnit)).toFixed(1)
            : "—"}
          <small>
            {speed !== undefined && speed !== null ? ` ${speedUnit}` : ""}
          </small>
        </strong>
        <span>Valid average estimate</span>
      </div>
      <div>
        <strong>
          {frame?.result.analysisHz.toFixed(1) ?? "—"}
          <small> Hz</small>
        </strong>
        <span>Local analysis</span>
      </div>
      <div>
        <strong>
          {previewHz.toFixed(1)}
          <small> Hz</small>
        </strong>
        <span>Sampled preview</span>
      </div>
    </section>
  );
}
