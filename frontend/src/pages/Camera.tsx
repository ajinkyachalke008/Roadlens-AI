import { useEffect, useRef, useState } from "react";
import { CameraCapture, type CompletedFrame } from "../camera/capture";
import { SessionStore } from "../session/store";
import {
  RelayClient,
  api,
  sharingAvailable,
  type Room,
  type ServerMessage,
} from "../transport/client";
import {
  ControlSchema,
  PolicySchema,
  type Report,
} from "../../../shared/src/schemas";
import { Stage, Metrics, type DisplayFrame } from "../components/Stage";
import { Reports } from "../components/Reports";
import { Drawer } from "../components/Drawer";
import { CalibrationDrawer } from "../components/CalibrationDrawer";
import { speedFactor, type SpeedUnit } from "../components/speedUnits";
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
    "settings" | "calibration" | "end" | null
  >(null);
  const [evidence, setEvidence] = useState(false);
  const evidenceRef = useRef(false);
  const [profile, setProfile] = useState<416 | 320>(416);
  const [adaptiveNote, setAdaptiveNote] = useState("");
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>("mph");
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
          ? `${c.background === "verified" ? "Background checked" : "Background unverified"} · measured setup`
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
    await capture.current?.start(profile, file);
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
    status === "Live" || status === "Replay" || status === "Source stalled";
  const loading = status.startsWith("Loading") || status === "Preparing camera";
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SOURCE DEVICE</span>
          <h1>Camera</h1>
        </div>
        <span className="badge">{connection}</span>
      </div>
      <video ref={video} className="capture-source" aria-hidden="true" />
      <Stage frame={frame} status={status} speedUnit={speedUnit} />
      <div className="controls">
        <div className="actions">
          <button
            className="primary"
            onClick={() => (running ? capture.current?.pause() : void start())}
            disabled={loading}
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
            {sharing ? "Connecting…" : "Share camera"}
          </button>
          <button onClick={() => setDrawer("calibration")} disabled={!frame}>
            Calibrate
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
            <p>Anyone with this code can view this session.</p>
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
      <Metrics frame={frame} previewHz={previewHz} speedUnit={speedUnit} />
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
      {drawer === "end" && (
        <Drawer title="End this session?" onClose={() => setDrawer(null)}>
          <p>Unexported reports, images and calibration will be cleared.</p>
          <button
            className="primary"
            onClick={() => {
              capture.current?.end();
              store.clear();
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
