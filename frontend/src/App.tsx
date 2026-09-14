import { lazy, Suspense } from "react";
const Camera = lazy(() => import("./pages/Camera"));
const Viewer = lazy(() => import("./pages/Viewer"));
export default function App() {
  const route = location.pathname;
  return (
    <>
      <header className="header">
        <a className="wordmark" href="/" aria-label="RoadLens home">
          <span className="logo-mark" aria-hidden="true">
            R
          </span>
          RoadLens<span className="wordmark-suffix">/ BASIC</span>
        </a>
        <span className="header-note">On-device · Temporary</span>
      </header>
      <main>
        {route === "/camera" ? (
          <Suspense fallback={<p role="status">Preparing camera…</p>}>
            <Camera />
          </Suspense>
        ) : route === "/viewer" || route === "/admin" ? (
          <Suspense fallback={<p role="status">Preparing viewer…</p>}>
            <Viewer />
          </Suspense>
        ) : (
          <section className="entry">
            <div className="status-pill">
              <span className="live-pulse" aria-hidden="true"></span>
              <span>100% CLIENT-SIDE EDGE AI · ONNX WASM READY</span>
            </div>
            <span className="eyebrow">INTELLIGENT TRAFFIC OBSERVATIONS</span>
            <h1>
              Turn any device into
              <br />an AI traffic camera.
            </h1>
            <p className="entry-intro">
              Real-time vehicle classification, trajectory tracking, and speed estimation running directly inside your browser. No cloud servers. No subscriptions. 100% private.
            </p>

            <div className="impact-pills">
              <span className="impact-pill">🚗 6 Traffic Classes</span>
              <span className="impact-pill">⚡ YOLO26n Neural Net</span>
              <span className="impact-pill">🔒 RAM-Only Privacy</span>
              <span className="impact-pill">📐 Planar Speed Calibration</span>
              <span className="impact-pill">📊 Instant CSV/JSON Export</span>
            </div>

            <div className="entry-options">
              <a className="entry-card primary-card" href="/camera">
                <span className="card-index">01 / SOURCE</span>
                <h2>
                  Start camera <span aria-hidden="true">↗</span>
                </h2>
                <p>Run real-time vehicle detection using your webcam, phone camera, or replay video.</p>
                <span className="card-foot">
                  Rear camera · In-browser WASM · Instant inference
                </span>
              </a>
              <a className="entry-card" href="/viewer">
                <span className="card-index">02 / VIEWER</span>
                <h2>
                  Connect to camera <span aria-hidden="true">↗</span>
                </h2>
                <p>Pair another screen to monitor live traffic feeds and candidate speeds remotely.</p>
                <span className="card-foot">8-character pairing code · No permissions needed</span>
              </a>
            </div>

            <div className="capabilities-grid">
              <div className="capability-card">
                <div className="capability-icon">🧠</div>
                <h3>In-Browser Neural Vision</h3>
                <p>Runs YOLO26n locally on WebAssembly. Video never leaves your device and runs smoothly on both desktop and mobile browsers.</p>
              </div>
              <div className="capability-card">
                <div className="capability-icon">⚡</div>
                <h3>Speed & Trajectory Engine</h3>
                <p>Time-aware IoU tracking combined with planar calibration estimates vehicle speeds and flags candidates for review.</p>
              </div>
              <div className="capability-card">
                <div className="capability-icon">🛡️</div>
                <h3>Ephemeral & Zero-Storage</h3>
                <p>No databases, accounts, or telemetry. All session metrics live in RAM and disappear the moment you close the tab.</p>
              </div>
            </div>

            <div className="entry-note">
              <span>No accounts required. Zero telemetry.</span>
              <span>Review candidates for traffic studies, not legal citations.</span>
            </div>
          </section>
        )}
      </main>
      <footer className="app-footer">
        <span>RoadLens AI v2.0</span>
        <a
          href="https://github.com/ajinkyachalke008/Roadlens-AI"
          target="_blank"
          rel="noreferrer"
        >
          GitHub · Ajinkya Chalke
        </a>
        <span>In-Browser Edge AI / RAM-only sessions</span>
      </footer>
    </>
  );
}

