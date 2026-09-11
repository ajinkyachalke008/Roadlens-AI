import { PacketHeaderSchema, type PacketHeader } from "./schemas.js";
import { LIMITS } from "./limits.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function encodePacket(
  header: PacketHeader,
  jpeg: Uint8Array,
): Uint8Array {
  const h = PacketHeaderSchema.parse(header);
  const json = encoder.encode(JSON.stringify(h));
  if (
    json.length > LIMITS.headerBytes ||
    jpeg.length !== h.imageLength ||
    jpeg.length > LIMITS.jpegBytes ||
    jpeg[0] !== 255 ||
    jpeg[1] !== 216 ||
    jpeg[jpeg.length - 2] !== 255 ||
    jpeg[jpeg.length - 1] !== 217
  )
    throw new Error("invalid_packet");
  const out = new Uint8Array(8 + json.length + jpeg.length);
  if (out.length > LIMITS.messageBytes) throw new Error("invalid_packet");
  out.set([82, 76, 78, 50]);
  new DataView(out.buffer).setUint32(4, json.length);
  out.set(json, 8);
  out.set(jpeg, 8 + json.length);
  return out;
}
export function decodePacket(bytes: Uint8Array): {
  header: PacketHeader;
  jpeg: Uint8Array;
} {
  if (
    bytes.byteLength < 12 ||
    bytes.byteLength > LIMITS.messageBytes ||
    bytes[0] !== 82 ||
    bytes[1] !== 76 ||
    bytes[2] !== 78 ||
    bytes[3] !== 50
  )
    throw new Error("invalid_packet");
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(4);
  if (length < 2 || length > LIMITS.headerBytes || 8 + length >= bytes.length)
    throw new Error("invalid_packet");
  const header = PacketHeaderSchema.parse(
    JSON.parse(decoder.decode(bytes.subarray(8, 8 + length))),
  );
  const jpeg = bytes.subarray(8 + length);
  if (
    jpeg.length !== header.imageLength ||
    jpeg.length > LIMITS.jpegBytes ||
    jpeg[0] !== 255 ||
    jpeg[1] !== 216 ||
    jpeg[jpeg.length - 2] !== 255 ||
    jpeg[jpeg.length - 1] !== 217
  )
    throw new Error("invalid_packet");
  return { header, jpeg };
}
