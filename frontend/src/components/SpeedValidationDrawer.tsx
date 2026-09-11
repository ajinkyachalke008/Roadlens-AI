import { useState } from "react";
import { Drawer } from "./Drawer";
import { speedFactor, type SpeedUnit } from "./speedUnits";
import {
  P95_MINIMUM_TRIALS,
  type ReferenceMethod,
  type SpeedValidationSession,
} from "../validation/speedTrial";
import {
  download,
  speedValidationCsv,
  speedValidationJson,
} from "../session/export";
import type { FrameResult } from "../../../shared/src/schemas";
import type { SpeedEstimate } from "../geometry/speed";

const methods: { value: ReferenceMethod; label: string }[] = [
  { value: "timing_gate", label: "Timing gate (measured distance)" },
  { value: "gps_speedometer", label: "GPS speedometer (passenger read)" },
  { value: "radar_gun", label: "Radar gun" },
  { value: "vehicle_speedometer", label: "Vehicle speedometer" },
  { value: "other", label: "Other (describe in notes)" },
];

/**
 * Records validation trials against the tracks currently carrying a valid
 * measured speed. Only a measurable pass can become a trial; an unmeasurable
 * one is refused rather than recorded as agreement.
 */
export function SpeedValidationDrawer({
  session,
  revision,
  frame,
  estimates,
  calibrationVersion,
  speedUnit,
  onChange,
  onClose,
}: {
  session: SpeedValidationSession;
  /** Bumped by the owner whenever the mutable session changes. */
  revision: number;
  frame: FrameResult | null;
  /** Live estimate per track id, from the most recent completed frame. */
  estimates: Map<number, SpeedEstimate>;
  calibrationVersion: string | null;
  speedUnit: SpeedUnit;
  onChange: () => void;
  onClose: () => void;
}) {
  const [trackId, setTrackId] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState<ReferenceMethod>("timing_gate");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const factor = speedFactor(speedUnit);
  const measurable = (frame?.tracks ?? []).filter(
    (track) => estimates.get(track.trackId)?.speedMps != null,
  );
  const summary = session.summary;
  const show = (mps: number | null) =>
    mps === null ? "—" : `${(mps * factor).toFixed(1)} ${speedUnit}`;

  function record() {
    setError("");
    const track = measurable.find((t) => t.trackId === trackId);
    const estimate = trackId === null ? undefined : estimates.get(trackId);
    if (!track || !estimate) {
      setError("Select a vehicle that currently has a valid measured speed.");
      return;
    }
    try {
      session.record({
        captureEpoch: frame!.captureEpoch,
        calibrationVersion: calibrationVersion ?? "",
        trackId: track.trackId,
        className: track.className,
        estimate,
        // The operator enters the reference in the displayed unit.
        referenceMps: Number(reference) / factor,
        referenceMethod: method,
        notes,
      });
      setReference("");
      setNotes("");
      setTrackId(null);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trial rejected");
    }
  }

  return (
    <Drawer title="Speed validation" onClose={onClose}>
      <p>
        Record one trial per pass: the speed RoadLens measured, and the speed you
        measured independently. A pass without a valid measured speed cannot be
        recorded. Trials are cleared when the session ends — export first.
      </p>
      {!calibrationVersion && (
        <p className="error" role="alert">
          Calibrate before validating. Without a measured calibration there is no
          speed to compare.
        </p>
      )}
      <fieldset>
        <legend>New trial</legend>
        <label>
          Vehicle with a valid measured speed
          <select
            aria-label="Vehicle with a valid measured speed"
            value={trackId ?? ""}
            onChange={(e) =>
              setTrackId(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">
              {measurable.length
                ? "Select a vehicle"
                : "No vehicle currently measurable"}
            </option>
            {measurable.map((track) => (
              <option key={track.trackId} value={track.trackId}>
                #{track.trackId} {track.className} ·{" "}
                {show(estimates.get(track.trackId)?.speedMps ?? null)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Independently measured speed ({speedUnit})
          <input
            type="number"
            step="any"
            min="0"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <label>
          Reference method
          <select
            aria-label="Reference method"
            value={method}
            onChange={(e) => setMethod(e.target.value as ReferenceMethod)}
          >
            {methods.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <input
            type="text"
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Conditions, lane, calibration grade"
          />
        </label>
        <button onClick={record} disabled={!calibrationVersion}>
          Record trial
        </button>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <dl
        className="gpu-diagnostics"
        data-testid="validation-summary"
        data-revision={revision}
        data-trials={summary.trials}
      >
        <dt>Trials</dt>
        <dd>{summary.trials}</dd>
        <dt>Mean absolute error</dt>
        <dd>
          {show(summary.maeMps)}
          {summary.maePercent === null
            ? ""
            : ` (${summary.maePercent.toFixed(1)}%)`}
        </dd>
        <dt>Median absolute error</dt>
        <dd>{show(summary.medianAbsMps)}</dd>
        <dt>95th percentile</dt>
        <dd>
          {summary.p95AbsMps === null
            ? `— (needs ${P95_MINIMUM_TRIALS} trials)`
            : show(summary.p95AbsMps)}
        </dd>
        <dt>Maximum</dt>
        <dd>{show(summary.maxAbsMps)}</dd>
        <dt>Signed bias</dt>
        <dd>{show(summary.biasMps)}</dd>
      </dl>
      <ol className="trial-list">
        {session.trials.map((trial) => (
          <li key={trial.trialId}>
            #{trial.passIndex} {trial.className} · measured{" "}
            {show(trial.estimatedMps)} · reference {show(trial.referenceMps)} ·
            error {show(trial.estimatedMps - trial.referenceMps)}
            <button
              aria-label={`Remove trial ${trial.passIndex}`}
              onClick={() => {
                session.remove(trial.trialId);
                onChange();
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button
          disabled={!session.trials.length}
          onClick={() =>
            download(
              speedValidationJson(session.trials),
              "roadlens-speed-validation.json",
            )
          }
        >
          Export JSON
        </button>
        <button
          disabled={!session.trials.length}
          onClick={() =>
            download(
              speedValidationCsv(session.trials),
              "roadlens-speed-validation.csv",
              "text/csv",
            )
          }
        >
          Export CSV
        </button>
      </div>
    </Drawer>
  );
}
