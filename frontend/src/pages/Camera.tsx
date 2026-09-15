import { useEffect, useMemo, useRef, useState } from "react";
import {
  CameraCapture,
  newPolicy,
  STALLED_STATUS,
  type CompletedFrame,
} from "../camera/capture";
import { SessionStore, type PlateFields } from "../session/store";
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
import { AnalyticsDrawer } from "../components/AnalyticsDrawer";
import { CalibrationDrawer } from "../components/CalibrationDrawer";
import { calibrationQuality } from "../geometry/calibration";
import { SpeedValidationDrawer } from "../components/SpeedValidationDrawer";
import { SpeedValidationSession } from "../validation/speedTrial";
import type { SpeedEstimate } from "../geometry/speed";
import { speedFactor, type SpeedUnit } from "../components/speedUnits";
import { RemoteDetector } from "../inference/remote";
import { PlateCapture, type PlateCaptureMode } from "../plates/capture";
import { plateFields } from "../plates/report";
import { SelectedVehicle } from "../components/SelectedVehicle";
import { legacyFrame } from "../transport/legacyFrame";
import { annotatedEvidence } from "../session/evidence";
import { reportForProtocol } from "../session/reportProtocol";
import { cropQuality, cropSharpness } from "../plates/quality";
import {
  ShowcaseController,
  showcaseLongEdge,
  showcaseStatusLabel,
  type ShowcaseQuality,
  type ShowcaseState,
} from "../showcase/controller";
import { scanIndianPlateFromCanvas } from "../plates/indianPlateScanner";
import {
  AutoPlateScanner,
  type AutoScanTriggerMode,
} from "../plates/autoScanner";
import { playPlateChime } from "../plates/audioChime";
import {
  getCurrentGeoLocation,
  type GeotaggedLocation,
} from "../geo/geolocationService";
import {
  analyzeTwoWheelerViolations,
  type TwoWheelerAnalysisResult,
} from "../violations/twoWheelerAnalyzer";
import {
  detectDominantColor,
  type VehicleColorResult,
} from "../vision/colorDetector";
import { ForensicChatDrawer } from "../components/ForensicChatDrawer";
import type { VehicleRecord } from "../ai/trafficQueryEngine";
import { parseIndianPlate } from "../../../shared/src/indianPlates";
import { ChallanModal } from "../components/ChallanModal";
import { createEChallanFromReport, type EChallanNotice } from "../challan/challanGenerator";

export default function Camera() {
  const video = useRef<HTMLVideoElement>(null);
  const capture = useRef<CameraCapture | null>(null);
  const relay = useRef<RelayClient | null>(null);
  const roomRef = useRef<Room | null>(null);
  const store = useRef(new SessionStore()).current;
  const autoScanner = useRef(new AutoPlateScanner()).current;
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [autoScanTriggerMode, setAutoScanTriggerMode] =
    useState<AutoScanTriggerMode>("all");
  const [autoScanCount, setAutoScanCount] = useState(0);
  const [autoScanToast, setAutoScanToast] = useState<string | null>(null);
  const autoScanToastTimer = useRef<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [scanningIndianPlate, setScanningIndianPlate] = useState(false);
  const [indianPlateResults, setIndianPlateResults] = useState<
    Map<number, { text: string; detail: string; confidence: number }>
  >(new Map());
  const [indianPlateToast, setIndianPlateToast] = useState<string | null>(null);
  const [gpsLocation, setGpsLocation] = useState<GeotaggedLocation | null>(null);
  const twoWheelerResultsRef = useRef<Map<number, TwoWheelerAnalysisResult>>(new Map());
  const twoWheelerFlagsMap = useRef<Map<number, { isTripleRiding?: boolean; hasNoHelmet?: boolean }>>(new Map());
  const [twoWheelerTags, setTwoWheelerTags] = useState<Map<number, string>>(new Map());
  const [chatOpen, setChatOpen] = useState(false);
  const [selectedChallan, setSelectedChallan] = useState<EChallanNotice | null>(null);
  const vehicleColorsRef = useRef<Map<string | number, VehicleColorResult>>(new Map());
  const [vehicleColorsRev, setVehicleColorsRev] = useState(0);

  useEffect(() => {
    getCurrentGeoLocation().then((loc) => {
      setGpsLocation(loc);
    });
    (window as unknown as { __ROADLENS_STORE__?: SessionStore }).__ROADLENS_STORE__ = store;
    (window as unknown as { __ROADLENS_TWOWHEELER_FLAGS__?: Map<number, { isTripleRiding?: boolean; hasNoHelmet?: boolean }> }).__ROADLENS_TWOWHEELER_FLAGS__ = twoWheelerFlagsMap.current;
  }, [store]);
  const [status, setStatus] = useState("Idle");
  const [connection, setConnection] = useState("Local only");
  const [error, setError] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [viewers, setViewers] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<
    "settings" | "calibration" | "validation" | "end" | "analytics" | null
  >(null);
  // Session-scoped, RAM-only, cleared with everything else at End session.
  const validation = useRef(new SpeedValidationSession());
  /**
   * Plate crops, readings and consensus live only here, for this session. They
   * are never written to a report until consensus settles, never persisted and
   * never logged.
   */
  const plates = useRef(new PlateCapture()).current;
  const [plateMode, setPlateMode] = useState<PlateCaptureMode>("candidates");
  const [plateRevision, setPlateRevision] = useState(0);
  /**
   * The vehicle the operator tapped. Held in React state for the card and
   * mirrored onto the capture controller, which stamps it into each frame so a
   * viewer can highlight the same box.
   */
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [showcase] = useState(() => new ShowcaseController());
  const [showcaseState, setShowcaseState] = useState<ShowcaseState>(() =>
    showcase.snapshot(),
  );
  /** Reports whose plate consensus is still being followed, by track. */
  const plateReports = useRef(new Map<number, string>()).current;
  const showcaseQualities = useRef(
    new Map<
      number,
      ShowcaseQuality & { sampledAtMs: number; captureEpoch: string }
    >(),
  ).current;
  const [validationRevision, setValidationRevision] = useState(0);
  const estimates = useRef(new Map<number, SpeedEstimate>());
  const [evidence, setEvidence] = useState(true);
  const evidenceRef = useRef(true);
  const [capturedToast, setCapturedToast] = useState(false);
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

  useEffect(() => {
    autoScanner.enabled = autoScanEnabled;
    autoScanner.triggerMode = autoScanTriggerMode;
  }, [autoScanEnabled, autoScanTriggerMode, autoScanner]);

  useEffect(() => {
    autoScanner.onPlateDetected = (event) => {
      const { track, scanResult, completed } = event;
      if (!scanResult.plate) return;

      playPlateChime();

      setIndianPlateResults((prev) => {
        const next = new Map(prev);
        next.set(track.trackId, {
          text: scanResult.plate!.formatted,
          detail: `${scanResult.plate!.stateName} (${scanResult.plate!.rtoLocation})`,
          confidence: scanResult.confidence,
        });
        return next;
      });

      setAutoScanCount(autoScanner.scannedCount);

      const savedReport = store.save(
        completed.result,
        completed.policy,
        completed.jpeg,
        "observation",
        track.trackId,
        undefined,
        undefined,
        {
          plateStatus: "read",
          plateText: scanResult.plate.formatted,
          plateConfidence: scanResult.confidence,
          plateSupportingFrames: 1,
          plateDetectorConfidence: scanResult.confidence,
        },
      );
      if (savedReport) {
        const color = vehicleColorsRef.current.get(track.trackId) ?? detectDominantColor(completed.canvas, track.bbox);
        vehicleColorsRef.current.set(savedReport.reportId, color);
      }

      if (autoScanToastTimer.current) {
        window.clearTimeout(autoScanToastTimer.current);
      }
      setAutoScanToast(
        `⚡ Auto-Scanned: ${scanResult.plate.formatted} · ${scanResult.plate.stateName} (${scanResult.plate.rtoLocation})`,
      );
      autoScanToastTimer.current = window.setTimeout(() => {
        setAutoScanToast(null);
      }, 5000);
    };
  }, [autoScanner, store]);
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
        const client = relay.current;
        const reports = store
          .snapshot()
          .map((report) =>
            reportForProtocol(report, client?.reportProtocol ?? 1),
          );
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
    (window as any).__ROADLENS_STORE__ = store;
    store.onReport = (report) => {
      const client = relay.current;
      client?.send({
        v: 2,
        type: "report.upsert",
        report: reportForProtocol(report, client.reportProtocol),
      });
    };
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
    plates.onChange = () => {
      if (!mounted.current) return;
      // A consensus can settle after the last frame of a vehicle, so flushing
      // only from onFrame would leave the final reading stranded on a report
      // that stays "Analyzing…" forever.
      flushPlates();
      syncShowcasePlate();
      setPlateRevision((value) => value + 1);
    };
    plates.onArtifact = (trackId, kind, artifact) => {
      const reportId = plateReports.get(trackId);
      if (reportId) store.applyArtifact(reportId, kind, artifact);
    };
    c.onReset = () => {
      setFrame(null);
      settleInterruptedShowcasePlate();
      plates.reset();
      plateReports.clear();
      showcaseQualities.clear();
      setShowcaseState(showcase.resetContinuity());
      // Track identities do not survive an epoch, so a selection made in the
      // previous one cannot mean anything in this one.
      setSelectedTrackId(null);
      c.selectedTrackId = null;
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
      handleShowcaseFrame(completed);
      // Analyze two-wheeler violations on active tracks
      let tagsChanged = false;
      const currentTags = new Map(twoWheelerTags);
      for (const track of completed.result.tracks) {
        if (
          ["car", "truck", "bus", "motorcycle"].includes(track.className) &&
          !vehicleColorsRef.current.has(track.trackId)
        ) {
          const col = detectDominantColor(completed.canvas, track.bbox);
          vehicleColorsRef.current.set(track.trackId, col);
          tagsChanged = true;
        }
        if (track.className === "motorcycle") {
          const res = analyzeTwoWheelerViolations(track, completed.result.tracks);
          twoWheelerResultsRef.current.set(track.trackId, res);
          twoWheelerFlagsMap.current.set(track.trackId, {
            isTripleRiding: res.isTripleRiding,
            hasNoHelmet: res.hasNoHelmetViolation,
          });

          let tag: string | null = null;
          if (res.isTripleRiding && res.hasNoHelmetViolation) {
            tag = "🚨 TRIPLE + NO HELMET";
          } else if (res.isTripleRiding) {
            tag = "🚨 TRIPLE RIDING";
          } else if (res.hasNoHelmetViolation) {
            tag = "🪖 NO HELMET";
          }

          if (tag !== currentTags.get(track.trackId)) {
            if (tag) currentTags.set(track.trackId, tag);
            else currentTags.delete(track.trackId);
            tagsChanged = true;
          }
        }
      }
      if (tagsChanged) {
        setTwoWheelerTags(currentTags);
        setVehicleColorsRev((v) => v + 1);
      }
      plates.observe(completed.result, completed.canvas, c.remote);
      flushPlates();
      if (autoScanner.enabled) {
        void autoScanner.processFrame(completed);
      }
      for (const candidate of completed.candidates) {
        const activeShowcase = showcase.snapshot();
        const showcaseReportId =
          activeShowcase.targetTrackId === candidate.trackId
            ? activeShowcase.reportId
            : null;
        const id = store.episodeId(
          candidate.episodeKey,
          showcaseReportId ?? undefined,
        );
        if (!id) continue;
        // A speed candidate is exactly the qualified workflow plate reading is
        // for, so ask for this vehicle explicitly and follow its consensus.
        plates.request(candidate.trackId);
        if (plateReports.size < 32) plateReports.set(candidate.trackId, id);
        const plate = plateFields(plates.state(candidate.trackId)) ?? undefined;
        if (
          showcaseReportId === id &&
          store.reports.get(id)?.kind === "observation"
        ) {
          store.upgradeToSpeedCandidate(
            id,
            completed.result,
            completed.policy,
            candidate.trackId,
            {
              trajectory: candidate.estimate.trajectory.map((p) => [
                p.sourceTimeMs,
                ...p.point,
              ]),
              residualM: candidate.estimate.residualM,
              coverageMs: candidate.estimate.coverageMs,
            },
            undefined,
            plate,
          );
          continue;
        }
        if (store.reports.has(id)) continue;
        plates.beginReportRescue(
          completed.result,
          completed.canvas,
          c.remote,
          candidate.trackId,
        );
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
          plate,
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
          // A relay deployed before the vehicle-intelligence fields validates
          // the header with a strict schema and disconnects the camera when it
          // sees one it does not know, so those fields are dropped rather than
          // risking the session. The viewer simply loses mode and selection.
          const sent = client.sendPacket(
            {
              v: 2,
              type: "analysis.frame",
              frameId: completed.result.frameId,
              result:
                client.frameProtocol >= 2
                  ? completed.result
                  : legacyFrame(completed.result),
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
      plates.reset();
      plateReports.clear();
      showcaseQualities.clear();
      setShowcaseState(showcase.setEnabled(false));
      setFrame(null);
      setRoom(null);
      setStatus("Ended");
      statusRef.current = "Ended";
      setEvidence(true);
      evidenceRef.current = true;
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
      plates.reset();
      plateReports.clear();
      showcaseQualities.clear();
    };
  }, [store]);
  useEffect(() => {
    plates.mode = plateMode;
  }, [plateMode, plates]);
  /** Carry every settled plate consensus onto the report that is following it. */
  const flushPlates = useRef(() => {
    for (const [trackId, reportId] of plateReports) {
      const plate = plateFields(plates.state(trackId));
      if (plate) store.applyPlate(reportId, plate);
    }
  }).current;
  function settleInterruptedShowcasePlate() {
    const current = showcase.snapshot();
    if (current.reportId === null) return;
    const report = store.reports.get(current.reportId);
    if (report?.plateStatus !== "pending") return;
    store.applyPlate(current.reportId, {
      ...(plateFields(plates.state(current.targetTrackId ?? -1)) ?? {}),
      plateStatus: "unreadable",
      plateText: null,
      plateConfidence: null,
      plateSupportingFrames: report.plateSupportingFrames ?? 0,
      plateDetectorConfidence: report.plateDetectorConfidence ?? null,
    } as PlateFields);
  }
  function syncShowcasePlate() {
    const current = showcase.snapshot();
    if (current.targetTrackId === null || current.reportId === null) return;
    setShowcaseState(
      showcase.updatePlate(plates.state(current.targetTrackId).status),
    );
  }
  function handleShowcaseFrame(completed: CompletedFrame) {
    if (!showcase.acceptsFrames) return;
    const before = showcase.snapshot();
    const observedIds = new Set(
      completed.result.tracks
        .filter((track) => track.observed)
        .map((track) => track.trackId),
    );
    for (const [trackId, quality] of showcaseQualities)
      if (
        quality.captureEpoch !== completed.result.captureEpoch ||
        !observedIds.has(trackId)
      )
        showcaseQualities.delete(trackId);
    const ranked = completed.result.tracks
      .filter(
        (track) =>
          track.observed &&
          ["car", "motorcycle", "bus", "truck"].includes(track.className),
      )
      .sort(
        (a, b) =>
          showcaseLongEdge(b, completed.result) -
          showcaseLongEdge(a, completed.result),
      )
      .slice(0, 3);
    for (const track of ranked) {
      const previous = showcaseQualities.get(track.trackId);
      if (
        previous &&
        completed.result.sourceTimeMs - previous.sampledAtMs < 250
      )
        continue;
      const sharpness = cropSharpness(completed.canvas, track.bbox);
      showcaseQualities.set(track.trackId, {
        sharpness,
        quality: cropQuality({
          bbox: track.bbox,
          sourceWidth: completed.result.frameWidth,
          sourceHeight: completed.result.frameHeight,
          detectionScore: track.score,
          sharpness,
        }),
        sampledAtMs: completed.result.sourceTimeMs,
        captureEpoch: completed.result.captureEpoch,
      });
    }
    const plateReady = new Set<number>();
    for (const track of completed.result.tracks) {
      const plate = plates.state(track.trackId);
      if (
        (plate.localizedFrames ?? 0) > 0 &&
        (plate.bestPlateWidthPx ?? 0) >= 48 &&
        (plate.bestPlateHeightPx ?? 0) >= 14 &&
        (plate.detectorConfidence ?? 0) >= 0.5
      )
        plateReady.add(track.trackId);
    }
    const target = showcase.onFrame(
      completed.result,
      completed.ambiguousTrackIds,
      showcaseQualities,
      plateReady,
    );
    const after = showcase.snapshot();
    if (
      before.targetTrackId !== null &&
      before.reportId === null &&
      before.targetTrackId !== after.targetTrackId
    )
      plates.cancel(before.targetTrackId);
    if (
      after.targetTrackId !== null &&
      before.targetTrackId !== after.targetTrackId
    ) {
      setSelectedTrackId(after.targetTrackId);
      if (capture.current)
        capture.current.selectedTrackId = after.targetTrackId;
      if (
        plates.request(
          after.targetTrackId,
          !!capture.current?.remote?.plateAvailable,
        )
      )
        plates.beginAdaptiveCapture(
          completed.result,
          completed.canvas,
          capture.current?.remote,
          after.targetTrackId,
        );
    }
    if (!target) {
      setShowcaseState(after);
      return;
    }
    setSelectedTrackId(target.trackId);
    if (capture.current) capture.current.selectedTrackId = target.trackId;
    try {
      const plateAccepted = plates.request(
        target.trackId,
        !!capture.current?.remote?.plateAvailable,
      );
      if (plateAccepted)
        plates.beginAdaptiveCapture(
          completed.result,
          completed.canvas,
          capture.current?.remote,
          target.trackId,
        );
      const plate = plateAccepted
        ? (plateFields(plates.state(target.trackId)) ?? undefined)
        : {
            plateStatus: "unavailable" as const,
            plateText: null,
            plateConfidence: null,
            plateSupportingFrames: 0,
            plateDetectorConfidence: null,
          };
      const speedCandidate = completed.candidates.find(
        (candidate) => candidate.trackId === target.trackId,
      );
      const evidenceImage = annotatedEvidence(
        completed.canvas,
        completed.result,
        target.trackId,
        "showcase",
      );
      if (!evidenceImage)
        throw new Error("Showcase evidence could not mark the report target");
      const reportId = speedCandidate
        ? (store.episodeId(speedCandidate.episodeKey) ?? crypto.randomUUID())
        : crypto.randomUUID();
      if (plateReports.size < 32) plateReports.set(target.trackId, reportId);
      const report = store.save(
        completed.result,
        completed.policy,
        evidenceImage,
        speedCandidate ? "speed_candidate" : "observation",
        target.trackId,
        reportId,
        speedCandidate
          ? {
              trajectory: speedCandidate.estimate.trajectory.map((point) => [
                point.sourceTimeMs,
                ...point.point,
              ]),
              residualM: speedCandidate.estimate.residualM,
              coverageMs: speedCandidate.estimate.coverageMs,
            }
          : undefined,
        plate,
        speedCandidate ? undefined : "showcase",
      );
      const artifacts = plates.artifactsFor(target.trackId);
      if (artifacts.vehicle)
        store.applyArtifact(report.reportId, "vehicle", artifacts.vehicle);
      if (artifacts.plate)
        store.applyArtifact(report.reportId, "plate", artifacts.plate);
      setShowcaseState(
        showcase.markReportCreated(
          report.reportId,
          report.plateStatus ?? "unavailable",
        ),
      );
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Showcase report failed";
      setShowcaseState(showcase.fail(message));
      setError(message);
    }
  }
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
    await capture.current?.start(
      profile,
      file,
      remote,
      showcase.snapshot().enabled ? "showcase" : "standard",
    );
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
  /**
   * Operating mode, read from the analysed frame when there is one so the badge
   * describes the state that actually produced what is on screen.
   */
  const mode = frame?.result.mode ??
    capture.current?.operatingMode ?? {
      operating: "handheld" as const,
      speedActive: false,
      reason: "handheld",
    };
  const modeLabel = mode.speedActive
    ? "Mounted · speed active"
    : mode.operating === "mounted"
      ? "Mounted · speed unavailable"
      : "Handheld · speed unavailable";
  const selectedTrack =
    frame?.result.tracks.find(
      (t) => t.trackId === selectedTrackId && t.observed,
    ) ?? null;
  // `plateRevision` is read so a settled consensus re-renders this card.
  void plateRevision;
  const selectedPlate =
    selectedTrackId === null ? null : plates.state(selectedTrackId);
  const cameraSource = capture.current?.cameraSource ?? null;
  const select = (trackId: number | null) => {
    setSelectedTrackId(trackId);
    if (capture.current) capture.current.selectedTrackId = trackId;
  };

  const handleScanIndianPlate = async (targetId?: number | null) => {
    if (!running) {
      void start().then(() => {
        setIndianPlateToast("📹 Camera starting... Click 'Scan Indian Number Plate' once vehicles appear in view.");
      });
      return;
    }

    const latest = capture.current?.latest;
    if (!latest || !latest.canvas) {
      setError("No active video frame available to scan. Please ensure the camera is running.");
      return;
    }

    setScanningIndianPlate(true);
    setIndianPlateToast("🔍 Scanning vehicle for Indian number plate...");

    try {
      // 1. Check if an explicit or currently selected track is targeted
      let effectiveId = targetId !== undefined ? targetId : selectedTrackId;
      let targetTrack =
        effectiveId !== null
          ? latest.result.tracks.find((t) => t.trackId === effectiveId)
          : null;

      // 2. If no track was selected, find the most prominent vehicle track
      if (!targetTrack && latest.result.tracks.length > 0) {
        const vehicleTracks = latest.result.tracks.filter((t) =>
          ["car", "truck", "bus", "motorcycle"].includes(t.className),
        );
        if (vehicleTracks.length > 0) {
          vehicleTracks.sort((a, b) => {
            const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
            const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
            return areaB - areaA;
          });
          targetTrack = vehicleTracks[0];
          effectiveId = targetTrack.trackId;
          select(effectiveId);
        }
      }

      const res = await scanIndianPlateFromCanvas(
        latest.canvas,
        targetTrack?.bbox ?? null,
      );

      if (res.success && res.plate) {
        if (effectiveId !== null) {
          setIndianPlateResults((prev) => {
            const next = new Map(prev);
            next.set(effectiveId!, {
              text: res.plate!.formatted,
              detail: `${res.plate!.stateName} (${res.plate!.rtoLocation})`,
              confidence: res.confidence,
            });
            return next;
          });
        }

        const savedRep = store.save(
          latest.result,
          latest.policy,
          latest.jpeg,
          "observation",
          effectiveId ?? undefined,
          undefined,
          undefined,
          {
            plateStatus: "read",
            plateText: res.plate.formatted,
            plateConfidence: res.confidence,
            plateSupportingFrames: 1,
            plateDetectorConfidence: res.confidence,
          },
        );
        if (savedRep && targetTrack) {
          const col = vehicleColorsRef.current.get(effectiveId!) ?? detectDominantColor(latest.canvas, targetTrack.bbox);
          vehicleColorsRef.current.set(savedRep.reportId, col);
        }

        setIndianPlateToast(
          `🇮🇳 Plate Detected: ${res.plate.formatted} · ${res.plate.stateName} (${res.plate.rtoLocation})`,
        );
      } else {
        setIndianPlateToast(
          res.error ??
            "Could not clearly detect an Indian number plate in this crop.",
        );
      }
    } catch {
      setIndianPlateToast("Plate scanner encountered a temporary error.");
    } finally {
      setScanningIndianPlate(false);
      setTimeout(() => setIndianPlateToast(null), 6000);
    }
  };

  const queryRecords: VehicleRecord[] = useMemo(() => {
    const list: VehicleRecord[] = [];
    for (const r of store.reports.values()) {
      const col =
        vehicleColorsRef.current.get(r.reportId) ??
        (r.trackId !== null ? vehicleColorsRef.current.get(r.trackId) : null) ?? {
          name: "Silver",
          hex: "#94a3b8",
          emoji: "🔘",
          confidence: 0.7,
        };
      const indian = r.plateText ? parseIndianPlate(r.plateText) : null;
      const imageBlob = r.evidenceId ? store.image(r.evidenceId) : null;

      list.push({
        id: r.reportId,
        reportId: r.reportId,
        trackId: r.trackId,
        className: r.className ?? "vehicle",
        color: col,
        plateText: r.plateText ?? null,
        rtoLocation: indian?.rtoLocation ?? null,
        stateName: indian?.stateName ?? null,
        speedMps: r.speedMps,
        speedKmh: r.speedMps != null ? Math.round(r.speedMps * 3.6) : null,
        isSpeeding: r.kind === "speed_candidate",
        timestamp: r.capturedAtIso,
        sourceMode: r.sourceMode,
        thumbnailBlob: imageBlob,
      });
    }

    if (frame?.result?.tracks) {
      for (const track of frame.result.tracks) {
        if (!track.observed || list.some((item) => item.trackId === track.trackId)) continue;
        const col = vehicleColorsRef.current.get(track.trackId) ?? {
          name: "Silver",
          hex: "#94a3b8",
          emoji: "🔘",
          confidence: 0.7,
        };
        const plate = indianPlateResults.get(track.trackId);
        const twoWheeler = twoWheelerResultsRef.current.get(track.trackId);

        list.push({
          id: `live-${track.trackId}`,
          trackId: track.trackId,
          className: track.className,
          color: col,
          plateText: plate?.text ?? null,
          rtoLocation: plate?.detail ?? null,
          stateName: null,
          speedMps: track.speedMps,
          speedKmh: track.speedMps != null ? Math.round(track.speedMps * 3.6) : null,
          isSpeeding: track.speedMps != null && track.speedMps * 3.6 > 50,
          violations: twoWheeler?.violations?.map((v) => v.titleEn),
          timestamp: new Date().toISOString(),
        });
      }
    }

    return list;
  }, [store.reports, revision, frame, indianPlateResults, vehicleColorsRev]);

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
          <span
            className="badge"
            data-testid="mode-state"
            data-speed-active={mode.speedActive ? "true" : "false"}
            title={
              mode.speedActive
                ? "Calibrated and stationary: speed is measured."
                : "Absolute speed needs a mounted, calibrated, stationary camera."
            }
          >
            {modeLabel}
          </span>
          <button
            type="button"
            className={`badge auto-scan-badge ${autoScanEnabled ? "active auto-scan-active-badge" : ""}`}
            data-testid="auto-scan-badge"
            title="Click to toggle Automatic Indian Plate Scanning (Hands-Free Mode)"
            style={{ cursor: "pointer", border: "none", font: "inherit" }}
            onClick={() => {
              const next = !autoScanEnabled;
              setAutoScanEnabled(next);
              if (next) {
                setAutoScanToast(
                  "⚡ Hands-Free Auto-Scan activated! Indian plates will be scanned automatically as vehicles pass.",
                );
                if (autoScanToastTimer.current)
                  window.clearTimeout(autoScanToastTimer.current);
                autoScanToastTimer.current = window.setTimeout(
                  () => setAutoScanToast(null),
                  4000,
                );
              }
            }}
          >
            {autoScanEnabled
              ? `⚡ Auto-Scan: ON (${autoScanCount})`
              : "⚡ Auto-Scan: OFF"}
          </button>
          <button
            type="button"
            role="switch"
            aria-label="Showcase mode"
            aria-checked={showcaseState.enabled}
            className={`showcase-toggle${showcaseState.enabled ? " active" : ""}`}
            data-testid="showcase-toggle"
            data-phase={showcaseState.phase}
            title="Select one real confirmed vehicle and create one temporary traffic event"
            onClick={() => {
              const enabling = !showcaseState.enabled;
              const target = showcaseState.targetTrackId;
              setShowcaseState(showcase.setEnabled(enabling));
              showcaseQualities.clear();
              if (
                !enabling &&
                target !== null &&
                showcaseState.reportId === null
              )
                plates.cancel(target);
              if (!enabling && target === selectedTrackId) select(null);
              if (capture.current?.sourceMode === "live_camera" && running)
                void capture.current
                  .applySourceProfile(enabling ? "showcase" : "standard")
                  .then(({ fallback, status: source }) =>
                    setCameraNote(
                      `${source.note}${fallback ? " · Showcase preference unsupported; using camera fallback" : ""}`,
                    ),
                  );
            }}
          >
            <i aria-hidden="true" />
            <span>Showcase</span>
            <small>{showcaseStatusLabel(showcaseState)}</small>
          </button>
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
        selectedTrackId={selectedTrackId}
        showcaseTrackId={showcaseState.targetTrackId}
        showcaseAlert={
          showcaseState.phase === "target_ready" ||
          showcaseState.reportId !== null
        }
        onSelect={select}
        plateBox={selectedPlate?.plateBox ?? null}
        speedLimitMps={capture.current?.policy.speedLimitMps ?? null}
        indianPlates={new Map(Array.from(indianPlateResults.entries()).map(([id, r]) => [id, r.text]))}
        twoWheelerViolations={twoWheelerTags}
        gpsLocation={gpsLocation}
      />
      <SelectedVehicle
        track={selectedTrack}
        lost={selectedTrackId !== null && !selectedTrack}
        plate={selectedPlate}
        plateAvailable={!!capture.current?.remote?.plateAvailable}
        mode={mode}
        policy={capture.current?.policy ?? newPolicy()}
        speedUnit={speedUnit}
        twoWheelerResult={selectedTrackId !== null ? (twoWheelerResultsRef.current.get(selectedTrackId) ?? null) : null}
        onAnalyzePlate={() => {
          if (selectedTrackId === null) return;
          if (!plates.request(selectedTrackId))
            setError("Too many vehicles queued for plate reading.");
          setPlateRevision((value) => value + 1);
        }}
        onClear={() => select(null)}
        onSaveObservation={() => {
          const latest = capture.current?.latest;
          if (latest) {
            const savedRep = store.save(
              latest.result,
              latest.policy,
              latest.jpeg,
              "observation",
              selectedTrackId ?? undefined,
            );
            if (savedRep && selectedTrack) {
              const col = vehicleColorsRef.current.get(selectedTrack.trackId) ?? detectDominantColor(latest.canvas, selectedTrack.bbox);
              vehicleColorsRef.current.set(savedRep.reportId, col);
            }
            setCapturedToast(true);
            setTimeout(() => setCapturedToast(false), 3000);
          }
        }}
        onScanIndianPlate={() => void handleScanIndianPlate(selectedTrackId)}
        isScanningIndianPlate={scanningIndianPlate}
        indianPlateResult={selectedTrackId !== null ? (indianPlateResults.get(selectedTrackId)?.text ?? null) : null}
        indianPlateDetail={selectedTrackId !== null ? (indianPlateResults.get(selectedTrackId)?.detail ?? null) : null}
        colorResult={selectedTrackId !== null ? (vehicleColorsRef.current.get(selectedTrackId) ?? null) : null}
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
            type="button"
            className="indian-plate-main-btn"
            data-testid="main-scan-indian-plate-btn"
            onClick={() => void handleScanIndianPlate()}
            disabled={scanningIndianPlate}
            title="Scan Indian number plate from current vehicle or camera frame"
          >
            {scanningIndianPlate
              ? "🔍 Scanning Indian Plate..."
              : "🇮🇳 Scan Indian Number Plate"}
          </button>
          <button
            className={`auto-scan-toggle ${autoScanEnabled ? "active" : ""}`}
            onClick={() => {
              const next = !autoScanEnabled;
              setAutoScanEnabled(next);
              if (next) {
                setAutoScanToast(
                  "⚡ Hands-Free Auto-Scan activated! Indian plates will be scanned automatically as vehicles pass.",
                );
                if (autoScanToastTimer.current)
                  window.clearTimeout(autoScanToastTimer.current);
                autoScanToastTimer.current = window.setTimeout(
                  () => setAutoScanToast(null),
                  4000,
                );
              }
            }}
            title="Automatic Plate Scanning: Automatically crops and scans Indian number plates as vehicles pass or speed"
          >
            <i className="auto-scan-dot" />
            <span>
              {autoScanEnabled
                ? "⚡ Auto-Scan: ON"
                : "⚡ Hands-Free Auto-Scan"}
            </span>
            {autoScanCount > 0 && (
              <span className="auto-scan-pill">{autoScanCount}</span>
            )}
          </button>
          {autoScanEnabled && (
            <button
              className="trigger-mode-btn"
              onClick={() =>
                setAutoScanTriggerMode((m) =>
                  m === "all" ? "speed_only" : "all",
                )
              }
              title="Switch trigger mode: all passing vehicles vs speed violations only"
            >
              {autoScanTriggerMode === "all"
                ? "🎯 All Vehicles"
                : "🚨 Speeding Only"}
            </button>
          )}
          <button
            className="capture-btn"
            onClick={() => {
              const latest = capture.current?.latest;
              if (latest) {
                store.save(
                  latest.result,
                  latest.policy,
                  latest.jpeg,
                );
                setCapturedToast(true);
                setTimeout(() => setCapturedToast(false), 3000);
              }
            }}
            disabled={!frame || !running}
            title="Take a photo snapshot and save an observation report"
          >
            📸 {capturedToast ? "Captured! Check Reports ↓" : "Capture Snapshot & Report"}
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
            onClick={() => void share()}
            disabled={!!room || sharing || !sharingAvailable()}
          >
            {room ? "Sharing active" : sharing ? "Connecting…" : "Share camera"}
          </button>
          <button
            className="analytics-btn"
            data-testid="analytics-btn"
            onClick={() => setDrawer("analytics")}
            title="View Traffic Flow Analytics, Vehicle Composition, and Speed Compliance"
          >
            📊 Analytics
          </button>
          <button
            type="button"
            className="forensic-chat-btn"
            data-testid="open-forensic-chat-btn"
            onClick={() => setChatOpen(true)}
            title="AI Forensic Search: Search vehicles, colors, and number plates using plain English"
          >
            <span>🤖 AI Forensic Search</span>
            <span className="forensic-badge-pill">Natural Language</span>
          </button>
        </div>
        <button onClick={() => setDrawer("settings")}>Settings</button>
      </div>
      {autoScanToast && (
        <div className="plate-toast-banner auto-scan-toast" role="status">
          <span>{autoScanToast}</span>
        </div>
      )}
      {capturedToast && (
        <div className="capture-toast-banner" role="status">
          <span>📸 <strong>Snapshot & Report Saved!</strong> Image and detection saved to Reports below.</span>
        </div>
      )}
      {indianPlateToast && (
        <div className="plate-toast-banner" role="status">
          <span>{indianPlateToast}</span>
        </div>
      )}
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
        revision={revision + plateRevision}
        speedUnit={speedUnit}
        onReview={(r: Report, s) => store.review(r.reportId, r.revision, s)}
        gpsLocation={gpsLocation}
        twoWheelerFlagsMap={twoWheelerFlagsMap.current}
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
              <option value="640">640 · matches the model input</option>
              <option value="960">960 · sharper source, same 640 input</option>
            </select>
          </label>
          <p className="footnote">
            The GPU model runs at 640 either way; 960 only sends a less
            compressed source for it to letterbox, at roughly double the bytes.
          </p>
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
          <hr />
          <h3>Camera source</h3>
          <dl
            className="gpu-diagnostics"
            data-testid="camera-source-diagnostics"
          >
            <dt>Profile</dt>
            <dd>{cameraSource?.profile ?? "standard"}</dd>
            <dt>Requested</dt>
            <dd>
              {cameraSource
                ? `${cameraSource.requestedWidth} × ${cameraSource.requestedHeight}`
                : "Camera not started"}
            </dd>
            <dt>Actual</dt>
            <dd data-testid="camera-source-actual">
              {cameraSource?.actualWidth && cameraSource.actualHeight
                ? `${cameraSource.actualWidth} × ${cameraSource.actualHeight}${cameraSource.actualFrameRate ? ` · ${cameraSource.actualFrameRate.toFixed(0)} FPS` : ""}`
                : "Unavailable"}
            </dd>
            <dt>Focus</dt>
            <dd>
              {cameraSource?.focusMode ??
                (cameraSource?.continuousFocusAvailable === false
                  ? "Continuous focus unavailable"
                  : "Browser managed")}
            </dd>
          </dl>
          <p className="footnote">
            Showcase prefers a 1080p-class source. The browser may choose a
            supported fallback; analysis transport remains independently
            bounded.
          </p>
          <hr />
          <h3>Plate recognition</h3>
          <label>
            When to read plates
            <select
              aria-label="Plate capture mode"
              value={plateMode}
              onChange={(event) =>
                setPlateMode(event.target.value as PlateCaptureMode)
              }
            >
              <option value="candidates">Speed candidates only</option>
              <option value="off">Off</option>
              <option value="all">Every tracked vehicle (testing)</option>
            </select>
          </label>
          <dl
            className="gpu-diagnostics"
            data-testid="plate-diagnostics"
            data-rescue-crops={plates.diagnostics.rescueCrops}
            data-rescue-bytes={plates.diagnostics.rescueBytes}
          >
            <dt>Availability</dt>
            <dd>
              {capture.current?.remote
                ? plates.diagnostics.available
                  ? (capture.current.remote.plateDescriptor?.ocrEngine ??
                    "worker plate pipeline")
                  : "Plate unavailable on this worker"
                : "GPU worker not connected"}
            </dd>
            <dt>Reads</dt>
            <dd>
              {plates.diagnostics.completed} completed ·{" "}
              {plates.diagnostics.refused} refused ·{" "}
              {plates.diagnostics.medianMs.toFixed(0)} ms median
            </dd>
            <dt>Adaptive capture</dt>
            <dd>
              {plates.diagnostics.rescueCrops} temporary crops ·{" "}
              {(plates.diagnostics.rescueBytes / 1024).toFixed(0)} KiB RAM
            </dd>
            <dt>Last vehicle crop</dt>
            <dd>
              {plates.diagnostics.lastCrop.vehicleWidth ||
              plates.diagnostics.lastCrop.vehicleHeight
                ? `${plates.diagnostics.lastCrop.vehicleWidth} × ${plates.diagnostics.lastCrop.vehicleHeight} px · quality ${plates.diagnostics.lastCrop.quality.toFixed(2)} · sharpness ${plates.diagnostics.lastCrop.sharpness.toFixed(1)}`
                : "No crop measured"}
            </dd>
            <dt>Last plate region</dt>
            <dd>
              {plates.diagnostics.lastCrop.plateWidth &&
              plates.diagnostics.lastCrop.plateHeight
                ? `${plates.diagnostics.lastCrop.plateWidth} × ${plates.diagnostics.lastCrop.plateHeight} source px`
                : "Not located"}
            </dd>
          </dl>
          <p className="footnote">
            Plate work runs only on your GPU worker, only for qualified
            vehicles, and never on the phone. Readings live in memory for this
            session and are cleared by End session. “Every tracked vehicle” is
            for your own permitted testing, not normal monitoring.
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
          <hr />
          <h3>🇮🇳 Hands-Free Indian Plate Auto-Scanner</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={autoScanEnabled}
              onChange={(e) => setAutoScanEnabled(e.target.checked)}
            />
            Enable Automatic Plate Scanning (Hands-Free)
          </label>
          <label>
            Auto-scan trigger criteria
            <select
              value={autoScanTriggerMode}
              disabled={!autoScanEnabled}
              onChange={(e) =>
                setAutoScanTriggerMode(
                  e.target.value as AutoScanTriggerMode,
                )
              }
            >
              <option value="all">All passing vehicles</option>
              <option value="speed_only">Speed limit violations only</option>
            </select>
          </label>
          <p className="footnote">
            Automatically isolates vehicle bumper crops, enhances plate contrast, and recognizes Indian registration numbers (including BH series) in the background with position-aware RTO verification.
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
          calibrationVersion={capture.current?.calibration?.version ?? null}
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
              setShowcaseState(showcase.setEnabled(false));
              store.clear();
              plates.reset();
              plateReports.clear();
              autoScanner.reset();
              setIndianPlateResults(new Map());
              twoWheelerResultsRef.current.clear();
              twoWheelerFlagsMap.current.clear();
              setTwoWheelerTags(new Map());
              setAutoScanCount(0);
              validation.current.clear();
              estimates.current = new Map();
              setValidationRevision(0);
              setFrame(null);
              setStatus("Ended");
              statusRef.current = "Ended";
              setEvidence(true);
              evidenceRef.current = true;
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
      {drawer === "analytics" && (
        <AnalyticsDrawer
          reports={Array.from(store.reports.values())}
          onClose={() => setDrawer(null)}
        />
      )}
      {chatOpen && (
        <ForensicChatDrawer
          records={queryRecords}
          onClose={() => setChatOpen(false)}
          onSelectReport={(reportId) => {
            const rep = store.reports.get(reportId);
            if (rep) {
              const blob = rep.evidenceId ? store.image(rep.evidenceId) : null;
              const imgUrl = blob ? URL.createObjectURL(blob) : undefined;
              const flags = rep.trackId !== null ? twoWheelerFlagsMap.current.get(rep.trackId) : undefined;
              const geoObj = gpsLocation
                ? {
                    latitude: gpsLocation.coordinates.latitude,
                    longitude: gpsLocation.coordinates.longitude,
                    accuracyM: gpsLocation.coordinates.accuracyM,
                    formattedDms: gpsLocation.formattedDms,
                    mapUrl: gpsLocation.mapUrl,
                    landmark: gpsLocation.landmark,
                  }
                : undefined;
              const notice = createEChallanFromReport(
                rep,
                { event: imgUrl },
                gpsLocation?.landmark ?? "National Highway / Urban Corridor · Sector 4",
                geoObj,
                flags,
              );
              setSelectedChallan(notice);
            }
          }}
        />
      )}
      {selectedChallan && (
        <ChallanModal
          challan={selectedChallan}
          onClose={() => setSelectedChallan(null)}
        />
      )}
    </>
  );
}
