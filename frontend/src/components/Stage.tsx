import { useEffect, useRef, type RefObject } from "react";
import type { FrameResult } from "../../../shared/src/schemas";
import { speedFactor, displaySpeed, type SpeedUnit } from "./speedUnits";
import {
  contentRect,
  OverlayModel,
  toContent,
  type ContentRect,
  type OverlayState,
} from "../camera/overlay";
export interface DisplayFrame {
  result: FrameResult;
  image: CanvasImageSource;
  width: number;
  height: number;
  receivedAt: number;
  processingMs?: number;
}
/** Written by the render loop and read at a low rate; never React state. */
export interface OverlayTelemetry {
  ageMs: number;
  holdMs: number;
  health: OverlayState["health"];
  displayHz: number;
  boxes: number;
  extrapolatedMs: number;
}
const colorFor = (ruleState: string) =>
  ruleState === "candidate" ? "#ffbf69" : "#a3edb8";

function drawBoxes(
  ctx: CanvasRenderingContext2D,
  rect: ContentRect,
  boxes: {
    bbox: readonly [number, number, number, number];
    className: string;
    trackId: number;
    speedMps: number | null;
    ruleState: string;
    opacity?: number;
  }[],
  speedUnit: SpeedUnit,
) {
  ctx.save();
  // Detections belong to the video content, never to the letterbox bars.
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.font = `600 ${Math.max(12, rect.width / 65)}px system-ui`;
  ctx.lineWidth = Math.max(1.5, rect.width / 450);
  ctx.textBaseline = "alphabetic";
  for (const box of boxes) {
    const { x, y, width, height } = toContent(box.bbox, rect);
    const color = colorFor(box.ruleState);
    ctx.globalAlpha = box.opacity ?? 1;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, width, height);
    const label = `${box.className} #${box.trackId}${
      box.speedMps !== null ? " · " + displaySpeed(box.speedMps, speedUnit) : ""
    }`;
    const labelHeight = Math.max(20, rect.width / 40);
    const textWidth = ctx.measureText(label).width + 12;
    const top = Math.max(rect.y, y - labelHeight);
    ctx.fillStyle = color;
    ctx.fillRect(
      x,
      top,
      Math.min(textWidth, rect.x + rect.width - x),
      labelHeight,
    );
    ctx.fillStyle = "#0e1812";
    ctx.fillText(label, x + 5, top + labelHeight * 0.74);
  }
  ctx.restore();
}
export function Stage({
  frame,
  status,
  speedUnit = "mph",
  videoRef,
  sourceTimeNow,
  smoothing = true,
  telemetry,
}: {
  frame: DisplayFrame | null;
  status: string;
  speedUnit?: SpeedUnit;
  /** Present on the source device: the live element is composited natively. */
  videoRef?: RefObject<HTMLVideoElement | null>;
  sourceTimeNow?: () => number;
  smoothing?: boolean;
  telemetry?: RefObject<OverlayTelemetry>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const model = useRef(new OverlayModel()).current;
  const live = !!videoRef;
  // Analysed results reach the render loop without re-rendering the page.
  useEffect(() => {
    if (!live) return;
    if (frame) model.update(frame.result);
    else model.reset();
  }, [frame, live, model]);
  // Source-device path: native video plus an overlay driven by the display.
  useEffect(() => {
    if (!live) return;
    let handle = 0;
    const marks: number[] = [];
    const render = () => {
      handle = requestAnimationFrame(render);
      const video = videoRef.current;
      const container = view.current;
      if (!container) return;
      const now = performance.now();
      marks.push(now);
      while (marks.length > 1 && now - marks[0]! > 2000) marks.shift();
      const displayHz =
        marks.length > 1 ? ((marks.length - 1) * 1000) / (now - marks[0]!) : 0;
      const playing =
        !!video &&
        !!(video.srcObject || video.currentSrc) &&
        video.videoWidth > 0;
      container.dataset.live = playing ? "true" : "false";
      const element = canvas.current;
      if (!element) {
        if (telemetry?.current)
          Object.assign(telemetry.current, {
            ageMs: 0,
            holdMs: 0,
            health: "healthy",
            displayHz,
            boxes: 0,
            extrapolatedMs: 0,
          });
        return;
      }
      const cssWidth = element.clientWidth;
      const cssHeight = element.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(cssWidth * ratio));
      const height = Math.max(1, Math.round(cssHeight * ratio));
      if (element.width !== width) element.width = width;
      if (element.height !== height) element.height = height;
      const ctx = element.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      const source = model.result;
      if (!source) return;
      const rect = contentRect(
        cssWidth,
        cssHeight,
        video?.videoWidth || source.frameWidth,
        video?.videoHeight || source.frameHeight,
      );
      const sourceNow = sourceTimeNow?.() ?? source.sourceTimeMs;
      const state = smoothing
        ? model.stateAt(sourceNow)
        : model.stateAt(source.sourceTimeMs);
      drawBoxes(ctx, rect, state.boxes, speedUnit);
      if (telemetry?.current)
        Object.assign(telemetry.current, {
          ageMs: state.ageMs,
          holdMs: state.holdMs,
          health: state.health,
          displayHz,
          boxes: state.boxes.length,
          extrapolatedMs: Math.max(
            0,
            ...state.boxes.map((box) => box.extrapolatedMs),
          ),
        });
    };
    handle = requestAnimationFrame(render);
    return () => cancelAnimationFrame(handle);
  }, [live, videoRef, model, smoothing, speedUnit, sourceTimeNow, telemetry]);
  // Viewer path: the analysed image itself is the picture.
  useEffect(() => {
    if (live || !frame || !canvas.current) return;
    const c = canvas.current;
    c.width = frame.width;
    c.height = frame.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(frame.image, 0, 0, c.width, c.height);
    drawBoxes(
      ctx,
      { x: 0, y: 0, width: c.width, height: c.height },
      frame.result.tracks.filter((t) => t.observed),
      speedUnit,
    );
  }, [frame, speedUnit, live]);
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
      <div className="stage-view" ref={view} data-live="false">
        {live && (
          <video
            ref={videoRef}
            className="stage-video"
            playsInline
            muted
            aria-hidden="true"
          />
        )}
        {frame ? (
          <canvas
            ref={canvas}
            className={live ? "stage-overlay" : undefined}
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
      </div>
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
  cameraHz,
}: {
  frame: DisplayFrame | null;
  previewHz?: number;
  speedUnit?: SpeedUnit;
  cameraHz?: number;
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
      {cameraHz !== undefined && (
        <div data-testid="camera-hz">
          <strong>
            {cameraHz.toFixed(1)}
            <small> FPS</small>
          </strong>
          <span>Camera frames</span>
        </div>
      )}
      <div data-testid="analysis-hz">
        <strong>
          {frame?.result.analysisHz.toFixed(1) ?? "—"}
          <small> Hz</small>
        </strong>
        <span>AI analysis</span>
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
