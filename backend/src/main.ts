import { createRelay } from "./relay.js";
import { LIMITS } from "../../shared/src/limits.js";

const production = process.env.NODE_ENV === "production";
const origins = (
  process.env.ALLOWED_ORIGINS ?? (production ? "" : "http://127.0.0.1:5173")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!origins.length)
  throw new Error("ALLOWED_ORIGINS must list exact frontend origins");
const port = Number(process.env.PORT ?? 10000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
function cap(name: string, max: number, scale = 1) {
  const raw = process.env[name];
  if (raw === undefined) return max;
  const value = Number(raw) * scale;
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value))
    throw new Error(`Invalid ${name}`);
  return Math.min(value, max);
}
const limits = {
  rooms: cap("ROOM_LIMIT", LIMITS.rooms),
  viewers: cap("VIEWERS_PER_ROOM", LIMITS.viewers),
  roomTtlMs: cap("ROOM_TTL_SECONDS", LIMITS.roomTtlMs, 1000),
  codeTtlMs: cap("PAIR_CODE_TTL_SECONDS", LIMITS.codeTtlMs, 1000),
  ownerGraceMs: cap("OWNER_GRACE_SECONDS", LIMITS.ownerGraceMs, 1000),
  jpegBytes: cap("MAX_FRAME_BYTES", LIMITS.jpegBytes),
  previewHz: cap("PREVIEW_MAX_HZ", LIMITS.previewHz),
  roomBytes: cap("ROOM_EGRESS_BYTES", LIMITS.roomBytes),
  processBytes: cap("PROCESS_EGRESS_BYTES", LIMITS.processBytes),
};
const staticDir =
  process.env.STATIC_DIR ??
  (process.env.SERVE_WEB === "true" ? "frontend/dist" : undefined);
const relay = createRelay({
  origins,
  limits,
  ...(process.env.ROADLENS_WORKER_SECRET
    ? { workerSecret: process.env.ROADLENS_WORKER_SECRET }
    : {}),
  ...(staticDir ? { staticDir } : {}),
});
relay.server.listen(port, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
