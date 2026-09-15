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
import {
  SHOWCASE_ACQUIRING_COLOR,
  SHOWCASE_TARGET_COLOR,
} from "../showcase/constants";
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
  ruleState === "candidate"
    ? "#ffbf69"
    : ruleState === "above_limit"
      ? "#ffd89b"
      : "#a3edb8";

export const overlayColor = (
  ruleState: string,
  selected = false,
  showcase = false,
  showcaseAlert = true,
) =>
  showcase
    ? showcaseAlert
      ? SHOWCASE_TARGET_COLOR
      : SHOWCASE_ACQUIRING_COLOR
    : selected
      ? "#8ecbff"
      : colorFor(ruleState);

/**
 * Overlay label.
 *
 * `CAR · ID 12` rather than `car #12`: a hash in front of a number reads as a
 * quantity, and operators reported exactly that confusion. Speed joins the
 * label only when the frame says the measurement is valid, so a handheld
 * session shows identity and nothing that could be mistaken for a road speed.
 */
export const overlayLabel = (
  className: string,
  trackId: number,
  speedMps: number | null,
  speedUnit: SpeedUnit,
  overBy: number | null = null,
  showcase = false,
  showcaseAlert = true,
  indianPlate?: string | null,
) =>
  `${showcase ? (showcaseAlert ? "TRAFFIC ALERT · " : "ACQUIRING · ") : ""}${className.toUpperCase()} · ID ${trackId}` +
  (indianPlate ? ` · 🇮🇳 ${indianPlate}` : "") +
  (speedMps !== null ? ` · ${displaySpeed(speedMps, speedUnit)}` : "") +
  (speedMps !== null && overBy !== null && overBy > 0
    ? ` · +${displaySpeed(overBy, speedUnit)}`
    : "");

export interface OverlayDrawBox {
  bbox: readonly [number, number, number, number];
  className: string;
  trackId: number;
  speedMps: number | null;
  ruleState: string;
  opacity?: number;
}

function drawBoxes(
  ctx: CanvasRenderingContext2D,
  rect: ContentRect,
  boxes: OverlayDrawBox[],
  speedUnit: SpeedUnit,
  selectedTrackId: number | null = null,
  showcaseTrackId: number | null = null,
  showcaseAlert = true,
  plateBox: readonly [number, number, number, number] | null = null,
  overBy: (box: OverlayDrawBox) => number | null = () => null,
  indianPlates?: Map<number, string> | null,
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
    const selected = box.trackId === selectedTrackId;
    const showcase = box.trackId === showcaseTrackId;
    const color = overlayColor(
      box.ruleState,
      selected,
      showcase,
      showcaseAlert,
    );
    ctx.globalAlpha = box.opacity ?? 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(
      showcase ? 4 : selected ? 3 : 1.5,
      rect.width / 450,
    );
    ctx.strokeRect(x, y, width, height);
    ctx.lineWidth = Math.max(1.5, rect.width / 450);
    const plateText = indianPlates?.get(box.trackId) ?? null;
    const label = overlayLabel(
      box.className,
      box.trackId,
      box.speedMps,
      speedUnit,
      overBy(box),
      showcase,
      showcaseAlert,
      plateText,
    );
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
    // Plate localisation, for the selected vehicle only. A small inner marker
    // showing where the reader looked - never the plate text itself, which
    // belongs to the selected card and to reports.
    if (selected && plateBox) {
      const plate = toContent(plateBox, rect);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#ffffff";
      ctx.globalAlpha = (box.opacity ?? 1) * 0.85;
      ctx.strokeRect(plate.x, plate.y, plate.width, plate.height);
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Which track a tap landed on, in normalised source coordinates. The smallest
 * containing box wins, so tapping a car inside a bus selects the car.
 */
export function hitTest(
  boxes: readonly OverlayDrawBox[],
  point: readonly [number, number],
): number | null {
  let best: { trackId: number; area: number } | null = null;
  for (const box of boxes) {
    const [x0, y0, x1, y1] = box.bbox;
    if (point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1)
      continue;
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { trackId: box.trackId, area };
  }
  return best?.trackId ?? null;
}
export function Stage({
  frame,
  status,
  speedUnit = "mph",
  videoRef,
  sourceTimeNow,
  smoothing = true,
  telemetry,
  selectedTrackId = null,
  showcaseTrackId = null,
  showcaseAlert = true,
  onSelect,
  plateBox = null,
  speedLimitMps = null,
  indianPlates = null,
}: {
  frame: DisplayFrame | null;
  status: string;
  speedUnit?: SpeedUnit;
  /** Present on the source device: the live element is composited natively. */
  videoRef?: RefObject<HTMLVideoElement | null>;
  sourceTimeNow?: () => number;
  smoothing?: boolean;
  telemetry?: RefObject<OverlayTelemetry>;
  selectedTrackId?: number | null;
  /** The one real track selected by Showcase; visually distinct from selection. */
  showcaseTrackId?: number | null;
  /** Red only after the event trigger; acquisition stays neutral amber. */
  showcaseAlert?: boolean;
  /** Tapping a box selects that vehicle; tapping empty space clears. */
  onSelect?: (trackId: number | null) => void;
  plateBox?: readonly [number, number, number, number] | null;
  speedLimitMps?: number | null;
  indianPlates?: Map<number, string> | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const model = useRef(new OverlayModel()).current;
  const live = !!videoRef;
  // The render loop reads these without being restarted by a selection change.
  const selection = useRef(selectedTrackId);
  selection.current = selectedTrackId;
  const showcase = useRef(showcaseTrackId);
  showcase.current = showcaseTrackId;
  const alert = useRef(showcaseAlert);
  alert.current = showcaseAlert;
  const plate = useRef(plateBox);
  plate.current = plateBox;
  const limit = useRef(speedLimitMps);
  limit.current = speedLimitMps;
  const platesMap = useRef(indianPlates);
  platesMap.current = indianPlates;
  const drawn = useRef<OverlayDrawBox[]>([]);
  const contentRef = useRef<ContentRect | null>(null);
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
      drawn.current = state.boxes;
      contentRef.current = rect;
      drawBoxes(
        ctx,
        rect,
        state.boxes,
        speedUnit,
        selection.current,
        showcase.current,
        alert.current,
        plate.current,
        (box) =>
          box.speedMps !== null && limit.current !== null
            ? box.speedMps - limit.current
            : null,
        platesMap.current,
      );
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
    try {
      ctx.drawImage(frame.image, 0, 0, c.width, c.height);
    } catch (error) {
      // A viewer disconnect can retire an ImageBitmap between React committing
      // this frame and running the passive draw effect. The transition to an
      // empty stage is already queued; a detached bitmap is not an app error.
      if (error instanceof DOMException && error.name === "InvalidStateError")
        return;
      throw error;
    }
    drawBoxes(
      ctx,
      { x: 0, y: 0, width: c.width, height: c.height },
      frame.result.tracks.filter((t) => t.observed),
      speedUnit,
      frame.result.selectedTrackId ?? null,
      null,
      true,
      null,
      () => null,
      platesMap.current,
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
            onClick={
              onSelect
                ? (event) => {
                    const rect = contentRef.current;
                    const element = event.currentTarget;
                    if (!rect || !rect.width || !rect.height) return;
                    const bounds = element.getBoundingClientRect();
                    // The canvas is laid out in CSS pixels and the content
                    // rectangle is measured in the same units, so the tap maps
                    // straight back to normalised source coordinates.
                    const x =
                      (event.clientX - bounds.left - rect.x) / rect.width;
                    const y =
                      (event.clientY - bounds.top - rect.y) / rect.height;
                    onSelect(
                      x < 0 || x > 1 || y < 0 || y > 1
                        ? null
                        : hitTest(drawn.current, [x, y]),
                    );
                  }
                : undefined
            }
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
