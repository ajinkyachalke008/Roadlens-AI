import { useEffect, useRef, useState } from "react";
import {
  CameraCapture,
  STALLED_STATUS,
  type CompletedFrame,
} from "../camera/capture";
import { SessionStore } from "../session/store";
import {
  RelayClient,
  api,
  apiBase,
  sharingAvailable,
  type Room,
  type ServerMessage,
} from "../transport/client";
import {
  ControlSchema,
  PolicySchema,
  type Report,
} from "../../../shared/src/schemas";
import {
  Stage,
  Metrics,
  type DisplayFrame,
  type OverlayTelemetry,
} from "../components/Stage";
import { OVERLAY_LIMITS } from "../camera/overlay";
import type { FrameRateChoice } from "../camera/frameRate";
import { Reports } from "../components/Reports";
import { Drawer } from "../components/Drawer";
import { CalibrationDrawer } from "../components/CalibrationDrawer";
import { calibrationQuality } from "../geometry/calibration";
import { SpeedValidationDrawer } from "../components/SpeedValidationDrawer";
import { SpeedValidationSession } from "../validation/speedTrial";
import type { SpeedEstimate } from "../geometry/speed";
import { speedFactor, type SpeedUnit } from "../components/speedUnits";
import { RemoteDetector } from "../inference/remote";
export default function Camera() {
  const video = useRef<HTMLVideoElement>(null);
  const capture = useRef<CameraCapture | null>(null);
  const relay = useRef<RelayClient | null>(null);
  const roomRef = useRef<Room | null>(null);
  const store = useRef(new SessionStore()).current;
  const [revision, setRevision] = useState(0);
  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [status, setStatus] = useState("Idle");
  const [connection, setConnection] = useState("Local only");
  const [error, setError] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [viewers, setViewers] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<
    "settings" | "calibration" | "validation" | "end" | null
  >(null);
  // Session-scoped, RAM-only, cleared with everything else at End session.
  const validation = useRef(new SpeedValidationSession());
  const [validationRevision, setValidationRevision] = useState(0);
  const estimates = useRef(new Map<number, SpeedEstimate>());
  const [evidence, setEvidence] = useState(false);
  const evidenceRef = useRef(false);
  const [profile, setProfile] = useState<416 | 320>(416);
  const [adaptiveNote, setAdaptiveNote] = useState("");
  const [inferenceMode, setInferenceMode] = useState("Browser AI");
  const [preferGpu, setPreferGpu] = useState(true);
  const [gpuConnecting, setGpuConnecting] = useState(false);
  const [analysisEdge, setAnalysisEdge] = useState<640 | 960>(640);
  const gpuAttempt = useRef(0);
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>("mph");
  const [frameRate, setFrameRate] = useState<FrameRateChoice>("auto");
  const [analysisRate, setAnalysisRate] = useState<"auto" | number>("auto");
  const [smoothing, setSmoothing] = useState(true);
  const [cameraNote, setCameraNote] = useState("");
  const [cameraTrack, setCameraTrack] = useState<{
    actual: number | null;
    options: number[];
    supported: boolean;
    note: string;
  } | null>(null);
  const overlay = useRef<OverlayTelemetry>({
    ageMs: 0,
    holdMs: 0,
    health: "healthy",
    displayHz: 0,
    boxes: 0,
    extrapolatedMs: 0,
  });
  // Stable identity: the render loop must not be torn down by a re-render.
  const sourceTimeNow = useRef(
    () => capture.current?.sourceTimeNow() ?? 0,
  ).current;
  const [previewHz, setPreviewHz] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [sharing, setSharing] = useState(false);
  const [calibrationStatus, setCalibrationStatus] = useState(
    "Handheld · detection only",
  );
  const [limit, setLimit] = useState("");
  const [margin, setMargin] = useState("0");
  const [road, setRoad] = useState("");
  const shareAbort = useRef<AbortController | null>(null);
  const lifecycle = useRef(0);
  const mounted = useRef(true);
  const lastPreview = useRef(0);
  const lastCameraStatus = useRef("");
  const uploads = useRef<number[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  function cameraStatus(state: string) {
    const c = capture.current;
    const key = state.startsWith("Loading") ? "Loading" : state;
    if (key === lastCameraStatus.current) return;
    lastCameraStatus.current = key;
    relay.current?.send({
      v: 2,
      type: "camera.status",
      state:
        state === "Live" || state === "Replay"
          ? "live"
          : state === "Paused"
            ? "paused"
            : state.startsWith("Loading")
              ? "model-loading"
              : "offline",
      captureEpoch: c?.captureEpoch ?? null,
      sourceMode: c?.sourceMode ?? "live_camera",
      analysisHz: c?.latest?.result.analysisHz ?? 0,
    });
  }
  function handleMessage(m: ServerMessage) {
    if (m.type === "hello.ok") {
      setViewers(Number(m.viewerCount) || 0);
      lastCameraStatus.current = "";
      cameraStatus(statusRef.current);
    }
    if (m.type === "viewers.changed") setViewers(Number(m.viewerCount) || 0);
    if (m.type === "sharing.budget" || m.type === "hello.ok")
      setRemaining(Number(m.roomBytesRemaining));
    if (m.type === "room.ended") {
      if (capture.current?.remote)
        void capture.current.useBrowser("Sharing ended · Browser fallback");
      if (m.reason === "sharing_budget_exhausted")
        setError(
          "Sharing stopped: relay byte allowance exhausted. Local analysis continues.",
        );
      roomRef.current = null;
      setRoom(null);
      setViewers(0);
      setConnection("Sharing ended");
    }
    if (m.type === "error") setError(String(m.message));
    if (
      ["state.request", "review.request", "evidence.request"].includes(
        String(m.type),
      )
    ) {
      const { requesterId: _requesterId, ...raw } = m;
      const parsed = ControlSchema.safeParse(raw);
      if (!parsed.success) return;
      const request = parsed.data;
      if (request.type === "state.request") {
        const reports = store.snapshot();
        if (!reports.length)
          relay.current?.send({
            v: 2,
            type: "state.snapshot",
            requestId: request.requestId,
            reports: [],
            done: true,
          });
        for (let i = 0; i < reports.length; i += 10)
          relay.current?.send({
            v: 2,
            type: "state.snapshot",
            requestId: request.requestId,
            reports: reports.slice(i, i + 10),
            done: i + 10 >= reports.length,
          });
      }
      if (request.type === "review.request") {
        const code = store.review(
          request.reportId,
          request.expectedRevision,
          request.review,
        );
        relay.current?.send({
          v: 2,
          type: "review.result",
          requestId: request.requestId,
          accepted: code === "ok",
          code,
        });
      }
      if (request.type === "evidence.request") {
        const blob = store.image(request.evidenceId);
        const client = relay.current;
        if (!blob) {
          client?.send({
            v: 2,
            type: "error",
            code: "evidence_unavailable",
            message: "Image no longer retained by camera",
            requestId: request.requestId,
          });
          return;
        }
        void (async () => {
          const image = await createImageBitmap(blob);
          const width = image.width,
            height = image.height;
          image.close();
          if (client !== relay.current) return;
          client?.sendPacket(
            {
              v: 2,
              type: "evidence.frame",
              requestId: request.requestId,
              evidenceId: request.evidenceId,
              imageWidth: width,
              imageHeight: height,
              imageLength: blob.size,
            },
            new Uint8Array(await blob.arrayBuffer()),
          );
        })().catch(() => setError("Evidence image unavailable"));
      }
    }
  }
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const c = new CameraCapture(video.current!);
    capture.current = c;
    store.onChange = () => setRevision((v) => v + 1);
    store.onReport = (report) =>
      relay.current?.send({ v: 2, type: "report.upsert", report });
    c.onError = setError;
    c.onInferenceMode = setInferenceMode;
    c.onProfile = (next, automatic) => {
      setProfile(next);
      setAdaptiveNote(
        automatic
          ? "Switched to 320 after sustained slow analysis; measurement reset."
          : "",
      );
    };
    c.onReset = () => {
      setFrame(null);
      setCalibrationStatus("Source changed · measurement reset");
      setDrawer((current) => (current === "calibration" ? null : current));
      lastCameraStatus.current = "";
      relay.current?.send({
        v: 2,
        type: "camera.status",
        state: "offline",
        captureEpoch: c.captureEpoch,
        sourceMode: c.sourceMode,
        analysisHz: 0,
      });
    };
    c.onStatus = (s) => {
      setStatus(s);
      statusRef.current = s;
      cameraStatus(s);
      if (s === "Paused") {
        setFrame(null);
        setCalibrationStatus("Paused · measurement reset");
      }
    };
    c.onFrame = (completed: CompletedFrame) => {
      estimates.current = completed.estimates;
      setFrame({
        result: completed.result,
        image: completed.canvas,
        width: completed.canvas.width,
        height: completed.canvas.height,
        receivedAt: performance.now(),
        processingMs: completed.processingMs,
      });
      setCalibrationStatus(
        c.calibration
          ? `${c.background === "verified" ? "Background checked" : "Background unverified"} · ${
              calibrationQuality(c.calibration).grade === "valid"
                ? "measured setup"
                : "weak calibration · re-measure"
            }`
          : c.background === "camera_moved"
            ? "Camera moved · recalibrate"
            : "Handheld / uncalibrated · detection only",
      );
      for (const candidate of completed.candidates) {
        const id = store.episodeId(candidate.episodeKey);
        if (!id || store.reports.has(id)) continue;
        store.save(
          completed.result,
          completed.policy,
          evidenceRef.current ? completed.jpeg : undefined,
          "speed_candidate",
          candidate.trackId,
          id,
          {
            trajectory: candidate.estimate.trajectory.map((p) => [
              p.sourceTimeMs,
              ...p.point,
            ]),
            residualM: candidate.estimate.residualM,
            coverageMs: candidate.estimate.coverageMs,
          },
        );
      }
      const client = relay.current;
      const now = performance.now();
      if (
        client?.connected &&
        client.viewerCount > 0 &&
        now - lastPreview.current >= 1000
      ) {
        lastPreview.current = now;
        void completed.jpeg.arrayBuffer().then((buffer) => {
          if (client !== relay.current || c.latest !== completed) return;
          const sent = client.sendPacket(
            {
              v: 2,
              type: "analysis.frame",
              frameId: completed.result.frameId,
              result: completed.result,
              imageWidth: completed.jpegWidth,
              imageHeight: completed.jpegHeight,
              imageLength: buffer.byteLength,
            },
            new Uint8Array(buffer),
          );
          if (sent) {
            uploads.current.push(performance.now());
            uploads.current = uploads.current.filter(
              (t) => performance.now() - t < 5000,
            );
            setPreviewHz(
              uploads.current.length > 1
                ? ((uploads.current.length - 1) * 1000) /
                    (uploads.current.at(-1)! - uploads.current[0])
                : 0,
            );
          }
        });
      }
    };
    const hide = () => {
      c.pause();
      setFrame(null);
    };
    const pagehide = () => {
      shareAbort.current?.abort();
      lifecycle.current++;
      gpuAttempt.current++;
      setGpuConnecting(false);
      setPreferGpu(true);
      setAnalysisEdge(640);
      setInferenceMode("Browser AI");
      setFrameRate("auto");
      setAnalysisRate("auto");
      setSmoothing(true);
      setCameraNote("");
      setCameraTrack(null);
      setSharing(false);
      c.end();
      relay.current?.close();
      relay.current = null;
      roomRef.current = null;
      store.clear();
      setFrame(null);
      setRoom(null);
      setStatus("Ended");
      statusRef.current = "Ended";
      setEvidence(false);
      evidenceRef.current = false;
      setLimit("");
      setMargin("0");
      setRoad("");
      setSpeedUnit("mph");
      setProfile(416);
      setAdaptiveNote("");
      setPreviewHz(0);
      uploads.current = [];
      lastPreview.current = 0;
      setViewers(0);
      setRemaining(null);
      setConnection("Local only");
      setDrawer(null);
    };
    const visibility = () => {
      if (document.hidden) hide();
    };
    const rotation = () => {
      if (c.latest) {
        c.pause();
        setError("Orientation changed. Resume and recalibrate.");
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pagehideGuard);
    function pagehideGuard(e: PageTransitionEvent) {
      if (e.persisted) pagehide();
    }
    screen.orientation?.addEventListener("change", rotation);
    const timer = setInterval(() => {
      setClock(Date.now());
      // Capability reads stay at 1 Hz: never in the render or overlay loop.
      setCameraTrack(c.cameraFrameRate);
      c.checkSourceHealth();
      if (!relay.current?.viewerCount) {
        uploads.current = [];
        setPreviewHz(0);
      }
    }, 1000);
    return () => {
      shareAbort.current?.abort();
      lifecycle.current++;
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", pagehideGuard);
      screen.orientation?.removeEventListener("change", rotation);
      c.end();
      relay.current?.close();
      store.clear();
    };
  }, [store]);
  async function start(file?: File | null) {
    setError("");
    const life = lifecycle.current;
    capture.current?.pause(false);
    const version = capture.current?.operationVersion;
    const current = () =>
      life === lifecycle.current &&
      version === capture.current?.operationVersion &&
      mounted.current &&
      !document.hidden;
    let remote: RemoteDetector | undefined;
    if (preferGpu && sharingAvailable()) {
      // One bounded read on a user action; no idle polling or anti-sleep traffic.
      try {
        const response = await fetch(apiBase() + "/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ v: 2 }),
          cache: "no-store",
          signal: AbortSignal.timeout(1500),
        });
        const config = response.ok ? await response.json() : null;
        if (!current()) return;
        if (config?.gpu?.state === "ready") remote = await prepareGpu(current);
        else
          setInferenceMode(
            config?.gpu?.state === "busy"
              ? "GPU busy · Browser fallback"
              : "Browser AI",
          );
      } catch {
        setInferenceMode("Browser AI");
      }
    }
    if (!current()) {
      remote?.close();
      return;
    }
    await capture.current?.start(profile, file, remote);
  }
  async function prepareGpu(current: () => boolean) {
    if (!sharingAvailable()) return;
    const attempt = ++gpuAttempt.current;
    const life = lifecycle.current;
    setGpuConnecting(true);
    let remote: RemoteDetector | undefined;
    try {
      if (!roomRef.current) await share();
      const deadline = performance.now() + 5000;
      while (
        !relay.current?.connected &&
        performance.now() < deadline &&
        life === lifecycle.current &&
        attempt === gpuAttempt.current &&
        current()
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (
        !roomRef.current ||
        !relay.current?.connected ||
        life !== lifecycle.current ||
        attempt !== gpuAttempt.current ||
        !current()
      )
        throw new Error("Relay unavailable");
      remote = new RemoteDetector(roomRef.current, analysisEdge);
      await remote.connect();
      if (
        life !== lifecycle.current ||
        attempt !== gpuAttempt.current ||
        !mounted.current ||
        !current()
      ) {
        remote.close();
        return;
      }
      return remote;
    } catch {
      remote?.close();
      if (life === lifecycle.current)
        setInferenceMode("GPU unavailable · Browser fallback");
    } finally {
      if (attempt === gpuAttempt.current) setGpuConnecting(false);
    }
  }
  async function activateGpu() {
    setPreferGpu(true);
    const version = capture.current?.operationVersion;
    const current = () =>
      version === capture.current?.operationVersion &&
      mounted.current &&
      !document.hidden;
    const remote = await prepareGpu(current);
    if (remote && current()) capture.current?.useGpu(remote);
    else remote?.close();
  }
  async function share() {
    if (sharing || roomRef.current) return;
    const life = lifecycle.current;
    const controller = new AbortController();
    shareAbort.current = controller;
    setSharing(true);
    setError("");
    setConnection("Waking relay");
    try {
      const r = await api<Room>(
        "/api/rooms",
        { v: 2, name: "RoadLens camera" },
        undefined,
        "POST",
        controller.signal,
      );
      if (life !== lifecycle.current || !mounted.current) {
        void api(
          `/api/rooms/${r.roomId}`,
          undefined,
          r.ownerToken,
          "DELETE",
        ).catch(() => {});
        return;
      }
      roomRef.current = r;
      setRoom(r);
      const client = new RelayClient(
        r.roomId,
        "camera",
        r.ownerToken,
        r.serverEpoch,
      );
      relay.current?.close();
      relay.current = client;
      client.onState = (s) => {
        if (relay.current !== client) return;
        setConnection(s);
        if (s.includes("expired") || s === "Sharing ended") {
          roomRef.current = null;
          setRoom(null);
          setViewers(0);
        }
      };
      client.onMessage = (message) => {
        if (relay.current === client) handleMessage(message);
      };
      client.connect();
    } catch (e) {
      if (life === lifecycle.current && mounted.current) {
        setError(e instanceof Error ? e.message : "Sharing unavailable");
        setConnection("Local only");
      }
    } finally {
      if (life === lifecycle.current && mounted.current) setSharing(false);
    }
  }
  async function stopSharing() {
    shareAbort.current?.abort();
    lifecycle.current++;
    gpuAttempt.current++;
    setGpuConnecting(false);
    if (capture.current?.remote)
      void capture.current.useBrowser("Sharing stopped · Browser fallback");
    setSharing(false);
    const r = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    setViewers(0);
    relay.current?.close();
    relay.current = null;
    setConnection("Local only");
    if (r)
      try {
        await api(`/api/rooms/${r.roomId}`, undefined, r.ownerToken, "DELETE");
      } catch {
        if (mounted.current)
          setError(
            "Relay unreachable. Viewers clear after the connection deadline.",
          );
      }
  }
  async function roomAction(action: "code" | "revoke-viewers") {
    const r = roomRef.current;
    if (!r) return;
    try {
      const next = await api<Partial<Room>>(
        `/api/rooms/${r.roomId}/${action}`,
        { v: 2 },
        r.ownerToken,
      );
      if (roomRef.current !== r || !mounted.current) return;
      const updated = { ...r, ...next };
      roomRef.current = updated;
      setRoom(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Room update failed");
    }
  }
  const running =
    status === "Live" || status === "Replay" || status === STALLED_STATUS;
  // GPU mode owns a relay room before any viewer joins, so name the three
  // states separately instead of leaving a disabled Share button unexplained.
  const shareState = room
    ? viewers > 0
      ? `Shared · ${viewers}/2 viewers`
      : "Shared · code ready"
    : "Share · off";
  const loading = status.startsWith("Loading") || status === "Preparing camera";
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SOURCE DEVICE</span>
          <h1>Camera</h1>
        </div>
        <div className="actions">
          <span className="badge" data-testid="inference-mode">
            {gpuConnecting ? "GPU AI · Connecting" : inferenceMode}
          </span>
          <span className="badge">
            Relay · <span data-testid="connection-state">{connection}</span>
          </span>
          <span className="badge" data-testid="share-state">
            {shareState}
          </span>
        </div>
      </div>
      <Stage
        frame={frame}
        status={status}
        speedUnit={speedUnit}
        videoRef={video}
        sourceTimeNow={sourceTimeNow}
        smoothing={smoothing}
        telemetry={overlay}
      />
      <div className="controls">
        <div className="actions">
          <button
            className="primary"
            onClick={() => (running ? capture.current?.pause() : void start())}
            disabled={loading || gpuConnecting}
          >
            {running
              ? "Pause camera"
              : status === "Paused"
                ? "Resume camera"
                : "Start camera"}
          </button>
          <button
            onClick={() => void share()}
            disabled={!!room || sharing || !sharingAvailable()}
          >
            {room ? "Sharing active" : sharing ? "Connecting…" : "Share camera"}
          </button>
          <button onClick={() => setDrawer("calibration")} disabled={!frame}>
            Calibrate
          </button>
          <button
            onClick={() => setDrawer("validation")}
            disabled={!frame}
            title="Record measured speed against an independent reference"
          >
            Validate speed
          </button>
          <button
            onClick={() => {
              const latest = capture.current?.latest;
              if (latest)
                store.save(
                  latest.result,
                  latest.policy,
                  evidence ? latest.jpeg : undefined,
                );
            }}
            disabled={!frame || !running}
          >
            Save observation
          </button>
        </div>
        <button onClick={() => setDrawer("settings")}>Settings</button>
      </div>
      {!sharingAvailable() && (
        <p className="footnote" role="status">
          Camera analysis is available. Sharing awaits a hosted relay.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </p>
      )}
      {room && (
        <section className="pairing-panel">
          <div>
            <span className="eyebrow">CAMERA CODE</span>
            <strong className="pair-code" data-testid="pairing-code">
              {room.pairingCode}
            </strong>
            <small>
              {Math.max(
                0,
                Math.ceil((Number(room.codeExpiresAt) - clock) / 1000),
              )}{" "}
              seconds to join · {viewers}/2 viewers
            </small>
          </div>
          <div>
            <p>
              Anyone with this code can view this session.
              {inferenceMode.startsWith("GPU")
                ? " GPU analysis already uses this relay room; viewers are separate."
                : ""}
            </p>
            <div className="actions">
              <button
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(room.pairingCode)
                    .catch(() =>
                      setError("Copy unavailable. Select the displayed code."),
                    )
                }
              >
                Copy code
              </button>
              <button onClick={() => void roomAction("code")}>
                Rotate code
              </button>
              <button onClick={() => void roomAction("revoke-viewers")}>
                Revoke viewers
              </button>
              <button onClick={() => void stopSharing()}>Stop sharing</button>
            </div>
            {remaining !== null && (
              <small>
                {(remaining / 1048576).toFixed(1)} MiB room allowance remaining
              </small>
            )}
          </div>
        </section>
      )}
      <Metrics
        frame={frame}
        previewHz={previewHz}
        speedUnit={speedUnit}
        cameraHz={capture.current?.frameDiagnostics.sourceHz ?? 0}
      />
      <div className="status-strip">
        <span>{calibrationStatus}</span>
        <span>
          {frame
            ? `${frame.result.inferenceMs.toFixed(0)} ms inference · ${frame.processingMs?.toFixed(0)} ms processing`
            : "No speed measurement"}
        </span>
      </div>
      {adaptiveNote && (
        <p className="footnote" role="status">
          {adaptiveNote}
        </p>
      )}
      <Reports
        store={store}
        revision={revision}
        speedUnit={speedUnit}
        onReview={(r: Report, s) => store.review(r.reportId, r.revision, s)}
      />
      <div className="session-footer">
        <button onClick={() => setDrawer("end")}>End session</button>
        <span>Reports stay in this page’s memory.</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        className="visually-hidden"
        aria-label="Choose replay video"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void start(f);
          e.target.value = "";
        }}
      />
      {drawer === "calibration" && capture.current?.latest && (
        <CalibrationDrawer
          frame={capture.current.latest}
          onClose={() => setDrawer(null)}
          onSave={(c, frozen) => {
            capture.current!.calibrate(c, frozen);
            setCalibrationStatus("Calibration checked · verifying background");
          }}
        />
      )}
      {drawer === "settings" && (
        <Drawer title="Camera settings" onClose={() => setDrawer(null)}>
          <h3>Performance</h3>
          <label>
            Camera frame rate
            <select
              value={String(frameRate)}
              onChange={(e) => {
                const value =
                  e.target.value === "auto"
                    ? "auto"
                    : (Number(e.target.value) as FrameRateChoice);
                setFrameRate(value);
                void (async () => {
                  const c = capture.current;
                  if (!c) return;
                  const result = await c.applyFrameRate(value);
                  setCameraTrack(result.status);
                  setCameraNote(
                    result.applied
                      ? ""
                      : "Camera kept its current frame rate; it did not accept that request.",
                  );
                })();
              }}
            >
              <option value="auto">Auto</option>
              {(cameraTrack?.options ?? []).map((value: number) => (
                <option key={value} value={String(value)}>
                  {value} FPS
                </option>
              ))}
            </select>
          </label>
          <label>
            AI analysis rate
            <select
              value={String(analysisRate)}
              onChange={(e) => {
                const value =
                  e.target.value === "auto" ? "auto" : Number(e.target.value);
                setAnalysisRate(value);
                if (capture.current) capture.current.analysisRate = value;
              }}
            >
              <option value="auto">Auto · measured</option>
              <option value="10">10 FPS</option>
              <option value="15">15 FPS</option>
              <option value="20">20 FPS</option>
              <option value="30">30 FPS</option>
            </select>
          </label>
          <label>
            GPU analysis image
            <select
              value={analysisEdge}
              disabled={running || loading}
              onChange={(e) =>
                setAnalysisEdge(Number(e.target.value) as 640 | 960)
              }
            >
              <option value="640">640 · lower bandwidth</option>
              <option value="960">960 · more detail</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={smoothing}
              onChange={(e) => setSmoothing(e.target.checked)}
            />
            Smooth overlay between analysed frames
          </label>
          <dl
            className="gpu-diagnostics"
            data-testid="performance-summary"
            data-camera-hz={capture.current?.frameDiagnostics.sourceHz ?? 0}
            data-analysis-hz={capture.current?.frameDiagnostics.analysisHz ?? 0}
            data-display-hz={overlay.current.displayHz}
            data-overlay-age-ms={overlay.current.ageMs}
            data-overlay-health={overlay.current.health}
            data-overlay-hold-ms={overlay.current.holdMs}
          >
            <dt>Camera frames</dt>
            <dd>
              {(capture.current?.frameDiagnostics.sourceHz ?? 0).toFixed(1)} FPS
              measured · {cameraTrack?.note ?? "camera idle"}
            </dd>
            <dt>AI analysis</dt>
            <dd>
              {(capture.current?.frameDiagnostics.analysisHz ?? 0).toFixed(1)}{" "}
              Hz completed ·{" "}
              {analysisRate === "auto" ? "auto" : `${analysisRate} FPS target`}
            </dd>
            <dt>Analysis model</dt>
            <dd>
              {capture.current?.remote?.descriptor
                ? `${capture.current.remote.descriptor.modelId} · ${capture.current.remote.descriptor.runtime} · ${capture.current.remote.descriptor.inputSize}`
                : `browser ${profile}`}{" "}
              · selected at worker start
            </dd>
            <dt>Display / overlay age</dt>
            <dd>
              {overlay.current.displayHz.toFixed(0)} Hz ·{" "}
              {overlay.current.ageMs.toFixed(0)} ms ({overlay.current.health})
            </dd>
          </dl>
          {cameraNote && <p className="footnote">{cameraNote}</p>}
          <p className="footnote">
            Overlay motion between analysed frames is display only, capped at{" "}
            {OVERLAY_LIMITS.extrapolationMs} ms and frozen past{" "}
            {OVERLAY_LIMITS.staleMs} ms. Speed, rules, counts and evidence use
            analysed frames only.
          </p>
          <hr />
          <h3>Inference</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={preferGpu}
              onChange={(e) => setPreferGpu(e.target.checked)}
            />
            Prefer available GPU on start
          </label>
          <div className="actions">
            <button
              disabled={
                !running ||
                gpuConnecting ||
                !!capture.current?.remote ||
                !sharingAvailable()
              }
              onClick={() => void activateGpu()}
            >
              Use GPU worker
            </button>
            <button
              disabled={!capture.current?.remote}
              onClick={() => {
                setPreferGpu(false);
                void capture.current?.useBrowser();
              }}
            >
              Use browser AI
            </button>
          </div>
          <p className="footnote">
            GPU mode sends bounded analysis images to your connected worker,
            even without viewers. Switching clears tracking and calibration.
            Browser fallback stays available.
          </p>
          <details className="diagnostics">
            <summary>Advanced diagnostics</summary>
            {capture.current?.gpuDiagnostics &&
              (() => {
                const d = capture.current.gpuDiagnostics!;
                return (
                  <dl
                    className="gpu-diagnostics"
                    data-testid="gpu-diagnostics"
                    data-source-hz={d.sourceHz}
                    data-submitted-hz={d.submittedHz}
                    data-result-hz={d.resultHz}
                    data-result-age-ms={d.resultAgeMs}
                    data-processing-ms={
                      capture.current?.latest?.processingMs ?? 0
                    }
                    data-tracking-ms={d.trackingMs}
                    data-rtt-ms={d.rttMs ?? ""}
                    data-encode-ms={d.encodeMs}
                    data-bytes={d.bytes}
                    data-submitted={d.submitted}
                    data-completed={d.completed}
                    data-dropped={d.dropped + d.skippedFrames}
                    data-interval-ms={d.intervalMs}
                    data-backoff-ms={d.backoffMs}
                    data-worker-total-ms={d.worker?.totalMs ?? ""}
                    data-worker-decode-ms={d.worker?.decodeMs ?? ""}
                    data-gpu-inference-ms={d.worker?.inferenceMs ?? ""}
                    data-in-flight={d.inFlight}
                    data-max-in-flight={d.maxInFlight}
                    data-superseded={
                      capture.current?.frameDiagnostics.supersededResults ?? 0
                    }
                    data-stale={
                      capture.current?.frameDiagnostics.staleResults ?? 0
                    }
                  >
                    <dt>Model / runtime</dt>
                    <dd>
                      {capture.current.remote?.descriptor?.modelId} /{" "}
                      {capture.current.remote?.descriptor?.runtime}
                    </dd>
                    <dt>Frames submitted / completed / skipped</dt>
                    <dd>
                      {d.submitted} / {d.completed} /{" "}
                      {d.skippedFrames + d.dropped}
                    </dd>
                    <dt>Encoding / same-clock result age</dt>
                    <dd>
                      {d.encodeMs.toFixed(1)} / {d.resultAgeMs.toFixed(1)} ms
                    </dd>
                    <dt>Source / submitted / completed</dt>
                    <dd>
                      {d.sourceHz.toFixed(1)} / {d.submittedHz.toFixed(1)} /{" "}
                      {d.resultHz.toFixed(1)} Hz
                    </dd>
                    <dt>Relay round trip</dt>
                    <dd>{d.rttMs?.toFixed(1) ?? "—"} ms</dd>
                    <dt>Decode / preprocess / inference / postprocess</dt>
                    <dd>
                      {d.worker
                        ? [
                            d.worker.decodeMs,
                            d.worker.preprocessMs,
                            d.worker.inferenceMs,
                            d.worker.postprocessMs,
                          ]
                            .map((n) => n.toFixed(1))
                            .join(" / ")
                        : "—"}{" "}
                      ms
                    </dd>
                    <dt>Worker total / target submission</dt>
                    <dd>
                      {d.worker?.totalMs.toFixed(1) ?? "—"} ms /{" "}
                      {(1000 / d.intervalMs).toFixed(1)} Hz
                    </dd>
                    <dt>Camera tracking</dt>
                    <dd>{d.trackingMs.toFixed(2)} ms</dd>
                    <dt>Analysis sent / in flight</dt>
                    <dd>
                      {(d.bytes / 1048576).toFixed(2)} MiB / {d.inFlight} of{" "}
                      {d.maxInFlight}
                    </dd>
                    <dt>Superseded / stale results</dt>
                    <dd>
                      {capture.current?.frameDiagnostics.supersededResults ?? 0}{" "}
                      / {capture.current?.frameDiagnostics.staleResults ?? 0}
                    </dd>
                  </dl>
                );
              })()}
            {capture.current &&
              (() => {
                const d = capture.current.frameDiagnostics;
                return (
                  <dl
                    className="gpu-diagnostics"
                    data-testid="capture-diagnostics"
                    data-scheduler={d.scheduler}
                    data-timing-source={d.timingSource ?? ""}
                    data-presented-frames={d.presentedFrames ?? ""}
                    data-source-time-ms={d.sourceTimeMs}
                    data-frame-seq={d.frameSeq}
                    data-accepted-frames={d.acceptedFrames}
                    data-source-hz={d.sourceHz}
                    data-accepted-hz={d.acceptedHz}
                    data-analysis-hz={d.analysisHz}
                    data-in-flight={d.inFlight}
                    data-max-in-flight={d.maxInFlight}
                    data-superseded={d.supersededResults}
                    data-stale={d.staleResults}
                  >
                    <dt>Source mode / scheduler</dt>
                    <dd>
                      {d.sourceMode} / {d.scheduler}
                    </dd>
                    <dt>Timing source / presented frames</dt>
                    <dd>
                      {d.timingSource ?? "—"} / {d.presentedFrames ?? "—"}
                    </dd>
                    <dt>Latest source time / frame</dt>
                    <dd>
                      {d.sourceTimeMs.toFixed(0)} ms / {d.frameSeq}
                    </dd>
                    <dt>Callback / accepted / analysed</dt>
                    <dd>
                      {d.sourceHz.toFixed(1)} / {d.acceptedHz.toFixed(1)} /{" "}
                      {d.analysisHz.toFixed(1)} Hz
                    </dd>
                    <dt>Callbacks / accepted / duplicate / busy</dt>
                    <dd>
                      {d.sourceFrames} / {d.acceptedFrames} /{" "}
                      {d.duplicateFrames} / {d.skippedFrames}
                    </dd>
                    <dt>Overlay age / hold / display</dt>
                    <dd>
                      {overlay.current.ageMs.toFixed(0)} ms ·{" "}
                      {overlay.current.health} ·{" "}
                      {overlay.current.displayHz.toFixed(0)} Hz ·{" "}
                      {overlay.current.boxes} boxes ·{" "}
                      {overlay.current.extrapolatedMs.toFixed(0)} ms advanced
                    </dd>
                    <dt>Camera rate requested / actual</dt>
                    <dd>
                      {String(frameRate)} /{" "}
                      {cameraTrack?.actual?.toFixed(1) ?? "—"} FPS
                    </dd>
                    <dt>Analysis target / submission interval</dt>
                    <dd>
                      {analysisRate === "auto" ? "auto" : `${analysisRate} FPS`}{" "}
                      / {(capture.current?.targetIntervalMs() ?? 0).toFixed(0)}{" "}
                      ms
                    </dd>
                    <dt>Build</dt>
                    <dd data-testid="build-id">{__BUILD_ID__}</dd>
                  </dl>
                );
              })()}
          </details>
          <hr />
          <label>
            Detector profile
            <select
              value={profile}
              disabled={running || loading}
              onChange={(e) => setProfile(Number(e.target.value) as 416 | 320)}
            >
              <option value="416">416 · standard</option>
              <option value="320">320 · smaller input</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={evidence}
              onChange={(e) => {
                setEvidence(e.target.checked);
                evidenceRef.current = e.target.checked;
              }}
            />
            Retain exact event images in memory
          </label>
          <p className="footnote">
            Off by default. Up to 20 images and 8 MiB; older images are evicted.
            Shared frames pass through the relay.
          </p>
          <button
            onClick={() => {
              setDrawer(null);
              fileRef.current?.click();
            }}
          >
            Use replay video
          </button>
          <button
            onClick={() => {
              setDrawer(null);
              void start(null);
            }}
            disabled={loading}
          >
            Use device camera
          </button>
          <hr />
          <h3>Entered demo policy</h3>
          <label>
            Speed unit
            <select
              value={speedUnit}
              onChange={(e) => {
                const next = e.target.value as SpeedUnit;
                const ratio = speedFactor(next) / speedFactor(speedUnit);
                if (limit.trim() && Number.isFinite(Number(limit)))
                  setLimit(String(Number((Number(limit) * ratio).toFixed(3))));
                if (margin.trim() && Number.isFinite(Number(margin)))
                  setMargin(
                    String(Number((Number(margin) * ratio).toFixed(3))),
                  );
                setSpeedUnit(next);
              }}
            >
              <option value="mph">mph</option>
              <option value="km/h">km/h</option>
            </select>
          </label>
          <label>
            Road label
            <input
              maxLength={80}
              value={road}
              onChange={(e) => setRoad(e.target.value)}
            />
          </label>
          <div className="two-column">
            <label>
              Speed limit ({speedUnit})
              <input
                type="number"
                min="0"
                max={100 * speedFactor(speedUnit)}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
            <label>
              Candidate margin ({speedUnit})
              <input
                type="number"
                min="0"
                max={50 * speedFactor(speedUnit)}
                value={margin}
                onChange={(e) => setMargin(e.target.value)}
              />
            </label>
          </div>
          <button
            onClick={() => {
              const c = capture.current;
              if (!c) return;
              const lim = limit.trim()
                ? Number(limit) / speedFactor(speedUnit)
                : null;
              const mar = Number(margin) / speedFactor(speedUnit);
              if (
                (lim !== null &&
                  (!Number.isFinite(lim) || lim < 0 || lim > 100)) ||
                !Number.isFinite(mar) ||
                mar < 0 ||
                mar > 50
              ) {
                setError("Enter a valid demo limit and margin");
                return;
              }
              const parsed = PolicySchema.safeParse({
                version: crypto.randomUUID(),
                roadLabel: road,
                speedLimitMps: lim,
                demoMarginMps: mar,
                limitSource: "operator_entered_demo",
              });
              if (!parsed.success) {
                setError("Enter a valid road label, limit and margin");
                return;
              }
              c.policy = parsed.data;
              relay.current?.send({
                v: 2,
                type: "session.update",
                policy: c.policy,
                calibrationStatus,
              });
              setDrawer(null);
            }}
          >
            Apply policy
          </button>
          <p className="footnote">
            These are entered demo settings. Candidates require validated
            geometry, background and source-time samples.
          </p>
        </Drawer>
      )}
      {drawer === "validation" && (
        <SpeedValidationDrawer
          session={validation.current}
          revision={validationRevision}
          frame={frame?.result ?? null}
          estimates={estimates.current}
          calibrationVersion={
            capture.current?.calibration?.version ?? null
          }
          speedUnit={speedUnit}
          onChange={() => setValidationRevision((n) => n + 1)}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer === "end" && (
        <Drawer title="End this session?" onClose={() => setDrawer(null)}>
          <p>
            Unexported reports, images, calibration and speed-validation trials
            will be cleared.
          </p>
          <button
            className="primary"
            onClick={() => {
              capture.current?.end();
              store.clear();
              validation.current.clear();
              estimates.current = new Map();
              setValidationRevision(0);
              setFrame(null);
              setStatus("Ended");
              statusRef.current = "Ended";
              setEvidence(false);
              evidenceRef.current = false;
              setLimit("");
              setMargin("0");
              setRoad("");
              setSpeedUnit("mph");
              setProfile(416);
              setAdaptiveNote("");
              setPreferGpu(true);
              setAnalysisEdge(640);
              setInferenceMode("Browser AI");
              setFrameRate("auto");
              setAnalysisRate("auto");
              setSmoothing(true);
              setCameraNote("");
              setCameraTrack(null);
              setPreviewHz(0);
              uploads.current = [];
              lastPreview.current = 0;
              setDrawer(null);
              void stopSharing();
            }}
          >
            End and clear session
          </button>
        </Drawer>
      )}
    </>
  );
}
