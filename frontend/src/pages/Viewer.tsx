import { useEffect, useRef, useState } from "react";
import {
  RelayClient,
  api,
  sharingAvailable,
  type Join,
  type ServerMessage,
} from "../transport/client";
import { SessionStore } from "../session/store";
import {
  ReportSchema,
  ControlSchema,
  type PacketHeader,
  type Report,
} from "../../../shared/src/schemas";
import { Stage, Metrics, type DisplayFrame } from "../components/Stage";
import { Reports } from "../components/Reports";
import {
  BoundedImageDecoder,
  DroppedImageError,
} from "../transport/imageDecoder";
import type { SpeedUnit } from "../components/speedUnits";
export default function Viewer() {
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>("mph");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("Enter camera code");
  const [connected, setConnected] = useState(false);
  const [sourceOnline, setSourceOnline] = useState(false);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [revision, setRevision] = useState(0);
  const [previewHz, setPreviewHz] = useState(0);
  const [age, setAge] = useState(0);
  const [pending, setPending] = useState<string>();
  const client = useRef<RelayClient | null>(null);
  const store = useRef(new SessionStore(false)).current;
  const bitmap = useRef<ImageBitmap | null>(null);
  const frameRef = useRef<DisplayFrame | null>(null);
  const decodeSeq = useRef(0);
  const epoch = useRef("");
  const lastSeq = useRef(-1);
  const retiredEpochs = useRef<string[]>([]);
  const arrivals = useRef<number[]>([]);
  const pendingRequests = useRef(
    new Map<
      string,
      {
        reportId: string;
        timer: ReturnType<typeof setTimeout>;
        evidenceId?: string;
      }
    >(),
  );
  const decoder = useRef(new BoundedImageDecoder()).current;
  const lifecycle = useRef(0);
  const mounted = useRef(true);
  const joinPending = useRef(false);
  const joinAbort = useRef<AbortController | null>(null);
  function clearPreview() {
    decodeSeq.current++;
    decoder.reset();
    bitmap.current?.close();
    bitmap.current = null;
    frameRef.current = null;
    setFrame(null);
    setSourceOnline(false);
    arrivals.current = [];
    setPreviewHz(0);
    setAge(0);
  }
  function clearRemote() {
    joinAbort.current?.abort();
    joinAbort.current = null;
    lifecycle.current++;
    joinPending.current = false;
    setJoining(false);
    clearPreview();
    store.clear();
    setConnected(false);
    setPending(undefined);
    for (const item of pendingRequests.current.values())
      clearTimeout(item.timer);
    pendingRequests.current.clear();
    epoch.current = "";
    lastSeq.current = -1;
    retiredEpochs.current = [];
  }
  function message(m: ServerMessage) {
    if (m.type === "hello.ok") {
      setConnected(true);
      setSourceOnline(m.sourceStatus === "live");
      setStatus(
        m.sourceStatus === "live" ? "Live sampled view" : "Waiting for camera",
      );
    }
    if (m.type === "camera.status") {
      const online = m.state === "live";
      setSourceOnline(online);
      setStatus(
        online
          ? "Live sampled view"
          : m.state === "paused"
            ? "Camera paused"
            : "Source unavailable",
      );
      if (!online) clearPreview();
    }
    if (m.type === "source.unavailable") {
      clearPreview();
      setStatus("Source offline · waiting for reconnect");
    }
    if (m.type === "report.upsert") {
      const parsed = ReportSchema.safeParse(m.report);
      if (parsed.success) store.upsert(parsed.data);
    }
    if (m.type === "state.snapshot") {
      const parsed = ControlSchema.safeParse(m);
      if (parsed.success && parsed.data.type === "state.snapshot")
        for (const report of parsed.data.reports) store.upsert(report);
    }
    if (m.type === "review.result") {
      const request = pendingRequests.current.get(String(m.requestId));
      if (request) {
        clearTimeout(request.timer);
        pendingRequests.current.delete(String(m.requestId));
        setPending(undefined);
        if (!m.accepted)
          setError(
            m.code === "revision_conflict"
              ? "Report changed. Review the latest revision and try again."
              : "Report is no longer retained by camera.",
          );
      }
    }
    if (m.type === "error") {
      setError(String(m.message));
      const request = pendingRequests.current.get(String(m.requestId));
      if (request) {
        clearTimeout(request.timer);
        pendingRequests.current.delete(String(m.requestId));
        setPending(undefined);
      }
    }
    if (m.type === "room.ended") {
      clearRemote();
      client.current?.close();
      client.current = null;
      setStatus("Sharing ended");
    }
  }
  async function packet(header: PacketHeader, jpeg: Uint8Array) {
    const generation = lifecycle.current;
    if (header.type === "evidence.frame") {
      const request = pendingRequests.current.get(header.requestId);
      if (!request || request.evidenceId !== header.evidenceId) return;
      const decoded = await decoder.decode(
        jpeg,
        header.imageWidth,
        header.imageHeight,
      );
      decoded.close();
      if (
        !mounted.current ||
        generation !== lifecycle.current ||
        pendingRequests.current.get(header.requestId) !== request
      )
        return;
      clearTimeout(request.timer);
      pendingRequests.current.delete(header.requestId);
      store.retain(
        header.evidenceId,
        new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }),
      );
      return;
    }
    if (retiredEpochs.current.includes(header.result.captureEpoch)) return;
    if (
      header.result.captureEpoch === epoch.current &&
      header.result.frameSeq <= lastSeq.current
    )
      return;
    if (header.result.captureEpoch !== epoch.current) {
      if (epoch.current)
        retiredEpochs.current = [...retiredEpochs.current, epoch.current].slice(
          -8,
        );
      epoch.current = header.result.captureEpoch;
      lastSeq.current = -1;
    }
    lastSeq.current = header.result.frameSeq;
    const ticket = ++decodeSeq.current;
    const image = await decoder.decode(
      jpeg,
      header.imageWidth,
      header.imageHeight,
    );
    if (
      !mounted.current ||
      generation !== lifecycle.current ||
      ticket !== decodeSeq.current
    ) {
      image.close();
      return;
    }
    const old = bitmap.current;
    bitmap.current = image;
    const next = {
      result: header.result,
      image,
      width: image.width,
      height: image.height,
      receivedAt: performance.now(),
    };
    frameRef.current = next;
    setFrame(next);
    setSourceOnline(true);
    setStatus("Live sampled view");
    old?.close();
    const now = performance.now();
    arrivals.current.push(now);
    arrivals.current = arrivals.current.filter((t) => now - t < 5000);
    setPreviewHz(
      arrivals.current.length > 1
        ? ((arrivals.current.length - 1) * 1000) / (now - arrivals.current[0])
        : 0,
    );
  }
  async function join() {
    if (joinPending.current) return;
    joinPending.current = true;
    setJoining(true);
    setError("");
    setStatus("Connecting to relay");
    const generation = lifecycle.current;
    const controller = new AbortController();
    joinAbort.current = controller;
    try {
      const data = await api<Join>(
        "/api/join",
        { v: 2, code },
        undefined,
        "POST",
        controller.signal,
      );
      if (!mounted.current || generation !== lifecycle.current) return;
      client.current?.close();
      clearRemote();
      const next = new RelayClient(
        data.roomId,
        "viewer",
        data.viewerToken,
        data.serverEpoch,
      );
      client.current = next;
      next.onMessage = (m) => {
        if (mounted.current && client.current === next) message(m);
      };
      next.onPacket = (h, j) => {
        if (!mounted.current || client.current !== next) return;
        const packetGeneration = lifecycle.current;
        void packet(h, j).catch((error) => {
          if (
            !(error instanceof DroppedImageError) &&
            mounted.current &&
            client.current === next &&
            packetGeneration === lifecycle.current
          )
            setError("Image could not be decoded safely");
        });
      };
      next.onState = (s) => {
        if (!mounted.current || client.current !== next) return;
        setStatus(s);
        if (s !== "Connected") clearPreview();
        if (
          s.includes("expired") ||
          s === "Sharing ended" ||
          s === "Invalid relay message"
        ) {
          clearRemote();
          client.current = null;
        }
      };
      next.connect();
      setCode("");
    } catch (e) {
      if (!mounted.current || generation !== lifecycle.current) return;
      setStatus("Enter camera code");
      setError(e instanceof Error ? e.message : "Pairing unavailable");
    } finally {
      if (mounted.current && generation === lifecycle.current) {
        joinPending.current = false;
        setJoining(false);
      }
    }
  }
  function requestReview(report: Report, review: Report["review"]) {
    if (
      !client.current?.connected ||
      !sourceOnline ||
      pendingRequests.current.size >= 16
    )
      return;
    const requestId = crypto.randomUUID();
    setPending(report.reportId);
    const timer = setTimeout(() => {
      pendingRequests.current.delete(requestId);
      setPending(undefined);
      setError("Camera did not confirm the review. Try again when connected.");
    }, 11000);
    pendingRequests.current.set(requestId, {
      reportId: report.reportId,
      timer,
    });
    if (
      !client.current.send({
        v: 2,
        type: "review.request",
        requestId,
        reportId: report.reportId,
        expectedRevision: report.revision,
        review,
      })
    ) {
      clearTimeout(timer);
      pendingRequests.current.delete(requestId);
      setPending(undefined);
      setError("Review was not sent. Reconnect to camera.");
    }
  }
  function requestEvidence(report: Report) {
    if (
      !client.current?.connected ||
      !report.evidenceId ||
      pendingRequests.current.size >= 16
    )
      return;
    const requestId = crypto.randomUUID();
    const timer = setTimeout(
      () => pendingRequests.current.delete(requestId),
      11000,
    );
    pendingRequests.current.set(requestId, {
      reportId: report.reportId,
      evidenceId: report.evidenceId,
      timer,
    });
    client.current.send({
      v: 2,
      type: "evidence.request",
      requestId,
      evidenceId: report.evidenceId,
    });
  }
  useEffect(() => {
    mounted.current = true;
    store.onChange = () => setRevision((v) => v + 1);
    const timer = setInterval(() => {
      const f = frameRef.current;
      if (f) {
        const elapsed = (performance.now() - f.receivedAt) / 1000;
        setAge(elapsed);
        if (elapsed > 5) {
          clearPreview();
          setStatus("Preview stale · waiting for camera");
        }
      }
    }, 1000);
    const hide = () => {
      client.current?.close();
      client.current = null;
      clearRemote();
      setStatus("Disconnected");
    };
    const show = (e: PageTransitionEvent) => {
      if (e.persisted) hide();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      mounted.current = false;
      joinAbort.current?.abort();
      joinAbort.current = null;
      lifecycle.current++;
      decodeSeq.current++;
      decoder.reset();
      clearInterval(timer);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      client.current?.close();
      client.current = null;
      bitmap.current?.close();
      bitmap.current = null;
      frameRef.current = null;
      store.onChange = () => {};
      store.clear();
      for (const p of pendingRequests.current.values()) clearTimeout(p.timer);
      pendingRequests.current.clear();
    };
  }, [store, decoder]);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONNECTED DEVICE</span>
          <h1>Camera viewer</h1>
        </div>
        <span className="badge">{status}</span>
      </div>
      {!connected ? (
        <section className="connect-panel">
          <span className="eyebrow">TEMPORARY INVITATION</span>
          <h2>Connect to camera</h2>
          {!sharingAvailable() && (
            <p role="status">
              Sharing awaits a hosted relay. Camera analysis and local reports
              are available on the camera page.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            <label>
              Camera code
              <input
                className="code-input"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={20}
                placeholder="XXXX-XXXX"
                value={code}
                disabled={!sharingAvailable()}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={joining || !code.trim() || !sharingAvailable()}
            >
              {joining ? "Connecting…" : "Connect"}
            </button>
          </form>
          <p>Enter the code shown on the camera device.</p>
        </section>
      ) : (
        <>
          <Stage frame={frame} status={status} speedUnit={speedUnit} />
          <Metrics frame={frame} previewHz={previewHz} speedUnit={speedUnit} />
          <div className="status-strip">
            <span>Sampled analyzed frames · camera computes detection</span>
            <span>
              {frame
                ? `Received ${age.toFixed(0)}s ago`
                : "Waiting for first analyzed frame"}
            </span>
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Reports
        store={store}
        revision={revision}
        speedUnit={speedUnit}
        onReview={requestReview}
        onEvidence={requestEvidence}
        reviewEnabled={sourceOnline && !!client.current?.connected}
        pending={pending}
      />
      {connected && (
        <div className="session-footer">
          <select
            aria-label="Speed unit"
            value={speedUnit}
            onChange={(e) => setSpeedUnit(e.target.value as SpeedUnit)}
          >
            <option value="mph">mph</option>
            <option value="km/h">km/h</option>
          </select>
          <button
            onClick={() => {
              client.current?.close();
              client.current = null;
              clearRemote();
              setStatus("Disconnected");
            }}
          >
            Disconnect and clear
          </button>
        </div>
      )}
    </>
  );
}
