import { LIMITS } from "../../../shared/src/limits";
import type { FrameResult, TrackView } from "../../../shared/src/schemas";
import { SHOWCASE_TARGET_COLOR } from "../showcase/constants";

export type EvidenceStyle = "showcase" | "speed_candidate";

export interface EvidenceAnnotation {
  frameId: string;
  trackId: number;
  className: TrackView["className"];
  score: number;
  bbox: readonly [number, number, number, number];
  style: EvidenceStyle;
}

export interface EvidenceGeometry {
  target: { x: number; y: number; width: number; height: number };
  label: { x: number; y: number; width: number; height: number };
  inset: { x: number; y: number; width: number; height: number } | null;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

/**
 * Resolve the one report target from the immutable report-time frame.
 *
 * Returning null is deliberate: callers may retain no evidence, but they may
 * never substitute a different vehicle or a later live box.
 */
export function evidenceAnnotation(
  frame: FrameResult,
  trackId: number,
  style: EvidenceStyle = "showcase",
): EvidenceAnnotation | null {
  const track = frame.tracks.find(
    (candidate) => candidate.observed && candidate.trackId === trackId,
  );
  if (!track) return null;
  const [x0, y0, x1, y1] = track.bbox;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0)
    return null;
  return {
    frameId: frame.frameId,
    trackId,
    className: track.className,
    score: track.score,
    bbox: [...track.bbox],
    style,
  };
}

/** Pure, testable placement for an in-bounds box, label, and small-target inset. */
export function evidenceGeometry(
  imageWidth: number,
  imageHeight: number,
  bbox: readonly [number, number, number, number],
  labelWidth: number,
  labelHeight: number,
): EvidenceGeometry | null {
  if (
    ![imageWidth, imageHeight, labelWidth, labelHeight, ...bbox].every(
      Number.isFinite,
    ) ||
    imageWidth < 1 ||
    imageHeight < 1 ||
    bbox[2] <= bbox[0] ||
    bbox[3] <= bbox[1]
  )
    return null;
  const padding = Math.max(
    6,
    Math.round(Math.min(imageWidth, imageHeight) / 80),
  );
  const lineWidth = Math.max(
    4,
    Math.round(Math.min(imageWidth, imageHeight) / 150),
  );
  const strokeInset = lineWidth / 2 + 1;
  const x0 = clamp(bbox[0] * imageWidth, strokeInset, imageWidth - strokeInset);
  const y0 = clamp(
    bbox[1] * imageHeight,
    strokeInset,
    imageHeight - strokeInset,
  );
  const x1 = clamp(bbox[2] * imageWidth, x0 + 1, imageWidth - strokeInset);
  const y1 = clamp(bbox[3] * imageHeight, y0 + 1, imageHeight - strokeInset);
  const target = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const width = Math.min(labelWidth, imageWidth - padding * 2);
  const height = Math.min(labelHeight, imageHeight - padding * 2);
  const gap = Math.max(3, Math.round(lineWidth / 2));
  const above = y0 - height - gap;
  const below = y1 + gap;
  const labelY =
    above >= padding
      ? above
      : below + height <= imageHeight - padding
        ? below
        : clamp(y0 + lineWidth, padding, imageHeight - height - padding);
  const label = {
    x: clamp(x0, padding, imageWidth - width - padding),
    y: labelY,
    width,
    height,
  };

  const targetArea =
    (target.width * target.height) / (imageWidth * imageHeight);
  const targetLongEdge = Math.max(
    target.width / imageWidth,
    target.height / imageHeight,
  );
  let inset: EvidenceGeometry["inset"] = null;
  if (targetArea < 0.08 || targetLongEdge < 0.3) {
    const insetWidth = clamp(
      imageWidth * 0.32,
      112,
      Math.min(220, imageWidth * 0.42),
    );
    const insetHeight = clamp(
      imageHeight * 0.27,
      88,
      Math.min(180, imageHeight * 0.36),
    );
    const targetCenterX = target.x + target.width / 2;
    const targetCenterY = target.y + target.height / 2;
    inset = {
      x:
        targetCenterX < imageWidth / 2
          ? imageWidth - padding - insetWidth
          : padding,
      y:
        targetCenterY < imageHeight / 2
          ? imageHeight - padding - insetHeight
          : padding,
      width: insetWidth,
      height: insetHeight,
    };
  }
  return { target, label, inset };
}

function dataUrlBlob(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

function drawInset(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  bbox: EvidenceAnnotation["bbox"],
  inset: NonNullable<EvidenceGeometry["inset"]>,
  color: string,
) {
  const headerHeight = Math.max(18, Math.round(inset.height * 0.18));
  const border = Math.max(3, Math.round(inset.width / 70));
  const target = {
    x: bbox[0] * source.width,
    y: bbox[1] * source.height,
    width: (bbox[2] - bbox[0]) * source.width,
    height: (bbox[3] - bbox[1]) * source.height,
  };
  const cropPadding = Math.max(
    4,
    Math.round(Math.max(target.width, target.height) * 0.1),
  );
  const sx = clamp(target.x - cropPadding, 0, source.width - 1);
  const sy = clamp(target.y - cropPadding, 0, source.height - 1);
  const sw = clamp(target.width + cropPadding * 2, 1, source.width - sx);
  const sh = clamp(target.height + cropPadding * 2, 1, source.height - sy);
  const destination = {
    x: inset.x + border,
    y: inset.y + headerHeight,
    width: inset.width - border * 2,
    height: inset.height - headerHeight - border,
  };
  context.save();
  context.fillStyle = "#0e1812";
  context.fillRect(inset.x, inset.y, inset.width, inset.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const scale = Math.min(destination.width / sw, destination.height / sh);
  const width = sw * scale;
  const height = sh * scale;
  context.drawImage(
    source,
    sx,
    sy,
    sw,
    sh,
    destination.x + (destination.width - width) / 2,
    destination.y + (destination.height - height) / 2,
    width,
    height,
  );
  context.strokeStyle = color;
  context.lineWidth = border;
  context.strokeRect(
    inset.x + border / 2,
    inset.y + border / 2,
    inset.width - border,
    inset.height - border,
  );
  context.fillStyle = color;
  context.font = `700 ${Math.max(10, Math.round(headerHeight * 0.48))}px system-ui`;
  context.textBaseline = "middle";
  context.fillText(
    "TARGET DETAIL",
    inset.x + border * 2,
    inset.y + headerHeight / 2,
  );
  context.restore();
}

/**
 * Bake one truthful report annotation into a bounded JPEG.
 *
 * The source canvas and target both belong to the same completed analysis
 * callback. Encoding happens only for a report, never in the live frame loop.
 */
export function annotatedEvidence(
  source: HTMLCanvasElement,
  frame: FrameResult,
  trackId: number,
  style: EvidenceStyle = "showcase",
) {
  const annotation = evidenceAnnotation(frame, trackId, style);
  if (!annotation || source.width < 1 || source.height < 1) return null;
  const scale = Math.min(
    1,
    LIMITS.imageEdge / Math.max(source.width, source.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const alert = annotation.style === "showcase";
  const color = alert ? SHOWCASE_TARGET_COLOR : "#ffbf69";
  const heading = alert ? "TRAFFIC ALERT" : "SPEED REVIEW";
  const detail = `${annotation.className.toUpperCase()} · ID ${annotation.trackId} · ${(annotation.score * 100).toFixed(0)}%`;
  let headingSize = Math.max(
    13,
    Math.round(Math.min(canvas.width, canvas.height) / 34),
  );
  let detailSize = Math.max(11, Math.round(headingSize * 0.76));
  const horizontalPadding = Math.max(10, Math.round(headingSize * 0.72));
  const verticalPadding = Math.max(6, Math.round(headingSize * 0.38));
  let textWidth = 0;
  while (headingSize >= 11) {
    context.font = `800 ${headingSize}px system-ui`;
    const headingWidth = context.measureText(heading).width;
    context.font = `700 ${detailSize}px system-ui`;
    const detailWidth = context.measureText(detail).width;
    textWidth = Math.max(headingWidth, detailWidth);
    if (textWidth + horizontalPadding * 2 <= canvas.width - 12) break;
    headingSize -= 1;
    detailSize = Math.max(10, Math.round(headingSize * 0.76));
  }
  const labelWidth = textWidth + horizontalPadding * 2;
  const labelHeight = headingSize + detailSize + verticalPadding * 3;
  const geometry = evidenceGeometry(
    canvas.width,
    canvas.height,
    annotation.bbox,
    labelWidth,
    labelHeight,
  );
  if (!geometry) return null;

  const lineWidth = Math.max(
    4,
    Math.round(Math.min(canvas.width, canvas.height) / 150),
  );
  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.strokeRect(
    geometry.target.x,
    geometry.target.y,
    geometry.target.width,
    geometry.target.height,
  );
  context.fillStyle = color;
  context.fillRect(
    geometry.label.x,
    geometry.label.y,
    geometry.label.width,
    geometry.label.height,
  );
  context.fillStyle = "#0e1812";
  context.textBaseline = "top";
  context.font = `800 ${headingSize}px system-ui`;
  context.fillText(
    heading,
    geometry.label.x + horizontalPadding,
    geometry.label.y + verticalPadding,
    geometry.label.width - horizontalPadding * 2,
  );
  context.font = `700 ${detailSize}px system-ui`;
  context.fillText(
    detail,
    geometry.label.x + horizontalPadding,
    geometry.label.y + verticalPadding * 2 + headingSize,
    geometry.label.width - horizontalPadding * 2,
  );
  context.restore();
  if (geometry.inset)
    drawInset(context, source, annotation.bbox, geometry.inset, color);

  let last: Blob | null = null;
  for (const quality of [0.75, 0.6, 0.45, 0.3]) {
    last = dataUrlBlob(canvas.toDataURL("image/jpeg", quality));
    if (last && last.size <= LIMITS.jpegTarget) return last;
  }
  return last && last.size <= LIMITS.jpegBytes ? last : null;
}
