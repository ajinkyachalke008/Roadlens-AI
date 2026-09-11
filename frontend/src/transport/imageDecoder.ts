import { LIMITS } from "../../../shared/src/limits";
/** Inspect JPEG frame dimensions before the browser allocates decoded pixels. */
export function jpegDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (
    bytes.length < 4 ||
    bytes.length > LIMITS.jpegBytes ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    throw new Error("Invalid JPEG");
  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) throw new Error("Invalid JPEG marker");
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 216 ||
      marker === 217
    )
      throw new Error("Invalid JPEG structure");
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > bytes.length) throw new Error("Truncated JPEG");
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length)
      throw new Error("Truncated JPEG segment");
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    ) {
      if (dimensions || length < 8 || bytes[offset + 2] !== 8)
        throw new Error("Unsupported JPEG frame");
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const components = bytes[offset + 7]!;
      if (
        length !== 8 + components * 3 ||
        components < 1 ||
        components > 4 ||
        width < 1 ||
        height < 1 ||
        width > LIMITS.imageEdge ||
        height > LIMITS.imageEdge
      )
        throw new Error("JPEG decoded dimensions exceed preview limits");
      dimensions = { width, height };
    }
    if (marker === 218) {
      if (!dimensions) throw new Error("JPEG has no dimensions");
      return dimensions;
    }
    offset += length;
  }
  throw new Error("JPEG has no image scan");
}
export class DroppedImageError extends Error {
  constructor() {
    super("Image superseded or session cleared");
    this.name = "DroppedImageError";
  }
}
interface Job {
  bytes: Uint8Array;
  width: number;
  height: number;
  generation: number;
  resolve: (image: ImageBitmap) => void;
  reject: (error: Error) => void;
}
export class BoundedImageDecoder {
  private active: Job | null = null;
  private pending: Job | null = null;
  private generation = 0;
  constructor(
    private readonly create: (blob: Blob) => Promise<ImageBitmap> = (blob) =>
      createImageBitmap(blob, { imageOrientation: "none" }),
  ) {}
  decode(
    bytes: Uint8Array,
    width: number,
    height: number,
  ): Promise<ImageBitmap> {
    let dimensions: { width: number; height: number };
    try {
      dimensions = jpegDimensions(bytes);
    } catch (error) {
      return Promise.reject(error);
    }
    if (dimensions.width !== width || dimensions.height !== height)
      return Promise.reject(new Error("JPEG dimensions do not match metadata"));
    return new Promise((resolve, reject) => {
      const job = {
        bytes,
        width,
        height,
        generation: this.generation,
        resolve,
        reject,
      };
      if (this.active) {
        this.pending?.reject(new DroppedImageError());
        this.pending = job;
      } else this.start(job);
    });
  }
  private start(job: Job) {
    this.active = job;
    void Promise.resolve()
      .then(() =>
        this.create(
          new Blob([new Uint8Array(job.bytes)], { type: "image/jpeg" }),
        ),
      )
      .then(
        (image) => {
          if (job.generation !== this.generation) {
            image.close();
            job.reject(new DroppedImageError());
          } else if (image.width !== job.width || image.height !== job.height) {
            image.close();
            job.reject(new Error("Decoded image dimensions do not match"));
          } else job.resolve(image);
        },
        (error) =>
          job.reject(
            error instanceof Error ? error : new Error("JPEG decode failed"),
          ),
      )
      .finally(() => {
        this.active = null;
        if (this.pending) {
          const next = this.pending;
          this.pending = null;
          this.start(next);
        }
      });
  }
  reset() {
    this.generation++;
    this.active?.reject(new DroppedImageError());
    this.pending?.reject(new DroppedImageError());
    this.pending = null;
  }
}
