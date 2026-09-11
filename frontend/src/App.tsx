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
            <span className="eyebrow">TRAFFIC OBSERVATIONS</span>
            <h1>
              A camera.
              <br />A second perspective.
            </h1>
            <p className="entry-intro">
              Analyze on your phone. Connect another screen.
            </p>
            <div className="entry-options">
              <a className="entry-card primary-card" href="/camera">
                <span className="card-index">01 / SOURCE</span>
                <h2>
                  Start camera <span aria-hidden="true">↗</span>
                </h2>
                <p>Run traffic detection on this device.</p>
                <span className="card-foot">
                  Rear camera · Browser inference
                </span>
              </a>
              <a className="entry-card" href="/viewer">
                <span className="card-index">02 / VIEWER</span>
                <h2>
                  Connect to camera <span aria-hidden="true">↗</span>
                </h2>
                <p>Enter a code to see sampled analysis.</p>
                <span className="card-foot">No camera permission needed</span>
              </a>
            </div>
            <div className="entry-note">
              <span>No accounts. No saved history.</span>
              <span>Review candidates, not legal citations.</span>
            </div>
          </section>
        )}
      </main>
      <footer className="app-footer">
        <span>RoadLens Basic v2</span>
        <a
          href="https://github.com/kokoc30/roadlens-ai"
          target="_blank"
          rel="noreferrer"
        >
          Source · AGPL-3.0
        </a>
        <span>Camera-side analysis / RAM-only sessions</span>
      </footer>
    </>
  );
}
