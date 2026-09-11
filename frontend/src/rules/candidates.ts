export interface DemoPolicy {
  version: string;
  speedLimitMps: number | null;
  demoMarginMps: number;
  persistenceMs?: number;
  minimumEstimates?: number;
  hysteresisMps?: number;
  cooldownMs?: number;
}
export interface RuleResult {
  ruleState: "unmeasured" | "normal" | "above_limit" | "candidate";
  episodeKey: string | null;
}
interface Episode {
  first: number | null;
  count: number;
  lastTime: number;
  emitted: boolean;
  index: number;
  belowSince: number | null;
}
export class CandidateRules {
  private episodes = new Map<string, Episode>();
  reset(): void {
    this.episodes.clear();
  }
  /** Preserve event deduplication when calibration/background continuity is invalidated. */
  invalidateContinuity(): void {
    for (const episode of this.episodes.values()) {
      episode.first = null;
      episode.count = 0;
      episode.belowSince = null;
    }
  }
  update(
    trackId: number,
    captureEpoch: string,
    sourceTimeMs: number,
    speedMps: number | null,
    policy: DemoPolicy,
  ): RuleResult {
    const key = `${captureEpoch}:${trackId}:speed_candidate:${policy.version}`;
    if (
      !Number.isFinite(sourceTimeMs) ||
      policy.speedLimitMps === null ||
      !Number.isFinite(policy.speedLimitMps) ||
      policy.speedLimitMps < 0 ||
      !Number.isFinite(policy.demoMarginMps) ||
      policy.demoMarginMps < 0
    ) {
      const old = this.episodes.get(key);
      if (old) {
        old.first = null;
        old.count = 0;
        old.belowSince = null;
      }
      return { ruleState: "unmeasured", episodeKey: null };
    }
    let episode = this.episodes.get(key);
    if (!episode) {
      // Fail closed instead of forgetting old emitted episodes and allowing duplicate reports.
      if (this.episodes.size >= 1000)
        return { ruleState: "unmeasured", episodeKey: null };
      episode = {
        first: null,
        count: 0,
        lastTime: sourceTimeMs,
        emitted: false,
        index: 0,
        belowSince: null,
      };
      this.episodes.set(key, episode);
    }
    const discontinuity =
      sourceTimeMs - episode.lastTime > 350 || sourceTimeMs < episode.lastTime;
    const duplicate =
      sourceTimeMs === episode.lastTime &&
      (episode.count > 0 || episode.emitted);
    if (
      discontinuity ||
      speedMps === null ||
      !Number.isFinite(speedMps) ||
      speedMps < 0
    ) {
      episode.first = null;
      episode.count = 0;
      episode.belowSince = null;
      episode.lastTime = sourceTimeMs;
      return { ruleState: "unmeasured", episodeKey: null };
    }
    const limit = policy.speedLimitMps,
      threshold = limit + policy.demoMarginMps;
    const hysteresis = Math.max(0.1, policy.hysteresisMps ?? 1);
    const cooldown = Math.max(1000, policy.cooldownMs ?? 2000);
    episode.lastTime = sourceTimeMs;
    if (speedMps <= Math.max(0, threshold - hysteresis)) {
      episode.belowSince ??= sourceTimeMs;
      if (episode.emitted && sourceTimeMs - episode.belowSince >= cooldown) {
        episode.emitted = false;
        episode.index++;
      }
    } else episode.belowSince = null;
    if (speedMps <= threshold) {
      episode.first = null;
      episode.count = 0;
      return {
        ruleState: speedMps > limit ? "above_limit" : "normal",
        episodeKey: null,
      };
    }
    if (duplicate)
      return {
        ruleState: episode.emitted ? "candidate" : "above_limit",
        episodeKey: null,
      };
    episode.first ??= sourceTimeMs;
    episode.count++;
    const persistent =
      episode.count >= Math.max(3, policy.minimumEstimates ?? 3) &&
      sourceTimeMs - episode.first >=
        Math.max(1000, policy.persistenceMs ?? 1000);
    if (persistent && !episode.emitted) {
      episode.emitted = true;
      return { ruleState: "candidate", episodeKey: `${key}:${episode.index}` };
    }
    return {
      ruleState: episode.emitted ? "candidate" : "above_limit",
      episodeKey: null,
    };
  }
}
