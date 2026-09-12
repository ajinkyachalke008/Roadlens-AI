import { describe, it } from "vitest";
import { suite } from "./suite";
import { evaluate, total, type TrackerOutput } from "./metrics";
import { TimeAwareTracker } from "../../frontend/src/tracking/tracker";
import { DiagnosticRecorder } from "../../frontend/src/tracking/diagnostics";

describe("baseline evidence", () => {
  it("measures and explains time_aware_iou_v1 across the evaluation set", () => {
    const causes: Record<string, number> = {};
    const rows = suite().map((s) =>
      evaluate(s.name, s, (scenario) => {
        const tracker = new TimeAwareTracker();
        const recorder = new DiagnosticRecorder(200000);
        tracker.diagnostics = recorder.sink;
        const out = scenario.frames.map((frame) =>
          tracker
            .update(frame.detections, frame.sourceTimeMs, "eval", false)
            .map<TrackerOutput>((t) => ({
              trackId: t.trackId,
              bbox: t.bbox,
              observed: t.observed,
            })),
        );
        for (const [key, value] of Object.entries(
          recorder.fragmentationCauses(),
        ))
          causes[key] = (causes[key] ?? 0) + value;
        return out;
      }),
    );
    const t = total(rows);
    const line = (m: (typeof rows)[number]) =>
      `${m.name.padEnd(24)} ids/gt=${m.idsPerGroundTruth.toFixed(2)} worst=${String(m.worstIdsForOneObject).padStart(3)} idsw=${String(m.idSwitches).padStart(3)} frag=${String(m.fragmentations).padStart(3)} merge=${String(m.falseMerges).padStart(2)} idf1=${m.idf1.toFixed(3)} mota=${m.mota.toFixed(3)}`;
    console.log("\n" + rows.map(line).join("\n") + "\n" + line(t));
    console.log(
      "\nNEW-IDENTITY CAUSES\n" +
        Object.entries(causes)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k.padEnd(24)} ${v}`)
          .join("\n"),
    );
  });
});
