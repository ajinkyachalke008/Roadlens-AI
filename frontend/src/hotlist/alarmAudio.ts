/**
 * Pure Web Audio API synthesized enforcement alarm siren for RoadLens Hotlist & BOLO hits.
 * Zero external audio files or network requests.
 */

let alarmAudioCtx: AudioContext | null = null;
let activeSirenGain: GainNode | null = null;
let sirenTimer: number | null = null;

function getOrCreateAudioContext(): AudioContext | null {
  if (!alarmAudioCtx) {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (AudioContextClass) {
      alarmAudioCtx = new AudioContextClass();
    }
  }
  return alarmAudioCtx;
}

/**
 * Plays an authoritative alternating two-tone emergency enforcement siren (880 Hz / 660 Hz).
 * Duration default: 1.6 seconds.
 */
export function playEmergencySiren(durationSeconds = 1.6): void {
  try {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    // Stop any existing siren
    stopEmergencySiren();

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    activeSirenGain = masterGain;

    masterGain.gain.setValueAtTime(0.01, now);
    masterGain.gain.linearRampToValueAtTime(0.25, now + 0.05);
    masterGain.gain.setValueAtTime(0.25, now + durationSeconds - 0.1);
    masterGain.gain.exponentialRampToValueAtTime(0.001, now + durationSeconds);
    masterGain.connect(ctx.destination);

    // Two oscillators for alternating high/low dual tone
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";

    // Alternate every 160ms between 880Hz (A5) and 659.25Hz (E5)
    const stepDuration = 0.16;
    const steps = Math.ceil(durationSeconds / stepDuration);
    for (let i = 0; i < steps; i++) {
      const stepTime = now + i * stepDuration;
      const freq = i % 2 === 0 ? 880 : 659.25;
      osc.frequency.setValueAtTime(freq, stepTime);
    }

    osc.connect(masterGain);
    osc.start(now);
    osc.stop(now + durationSeconds);

    sirenTimer = window.setTimeout(() => {
      activeSirenGain = null;
    }, durationSeconds * 1000);
  } catch {
    // Safely ignore if user has not interacted with page audio yet
  }
}

/**
 * Stops any currently active siren immediately.
 */
export function stopEmergencySiren(): void {
  if (activeSirenGain && alarmAudioCtx) {
    try {
      activeSirenGain.gain.setValueAtTime(0.001, alarmAudioCtx.currentTime);
      activeSirenGain.disconnect();
    } catch {
      // Ignore
    }
    activeSirenGain = null;
  }
  if (sirenTimer != null) {
    window.clearTimeout(sirenTimer);
    sirenTimer = null;
  }
}
