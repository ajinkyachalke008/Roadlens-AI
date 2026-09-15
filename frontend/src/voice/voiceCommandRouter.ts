/**
 * Classifies spoken natural language into either a direct camera control command
 * or a natural language forensic traffic query.
 */

export type VoiceAction =
  | "scan_plate"
  | "toggle_autoscan"
  | "open_hotlist"
  | "open_diagnostics"
  | "open_forensics"
  | "close_drawer";

export interface VoiceParseResult {
  type: "command" | "query";
  action?: VoiceAction;
  query?: string;
  rawTranscript: string;
}

export function routeVoiceTranscript(rawText: string): VoiceParseResult {
  const clean = rawText.trim().toLowerCase();

  // 1. Check for operational camera commands
  if (
    clean === "scan plate" ||
    clean === "scan" ||
    clean === "scan now" ||
    clean === "capture plate" ||
    clean === "read plate" ||
    clean === "scan number plate"
  ) {
    return { type: "command", action: "scan_plate", rawTranscript: rawText };
  }

  if (
    clean.includes("auto scan") ||
    clean.includes("toggle auto") ||
    clean.includes("hands free") ||
    clean === "start auto scan" ||
    clean === "stop auto scan"
  ) {
    return { type: "command", action: "toggle_autoscan", rawTranscript: rawText };
  }

  if (
    clean.includes("hotlist") ||
    clean.includes("bolo") ||
    clean.includes("wanted") ||
    clean.includes("watchlist") ||
    clean.includes("show alert") ||
    clean.includes("show alerts")
  ) {
    return { type: "command", action: "open_hotlist", rawTranscript: rawText };
  }

  if (
    clean.includes("diagnostics") ||
    clean.includes("system health") ||
    clean.includes("health hud") ||
    clean.includes("check health") ||
    clean.includes("system status")
  ) {
    return { type: "command", action: "open_diagnostics", rawTranscript: rawText };
  }

  if (
    clean === "open forensics" ||
    clean === "open chat" ||
    clean === "search traffic" ||
    clean === "ai assistant"
  ) {
    return { type: "command", action: "open_forensics", rawTranscript: rawText };
  }

  if (
    clean === "close" ||
    clean === "close drawer" ||
    clean === "dismiss" ||
    clean === "cancel" ||
    clean === "hide" ||
    clean === "back"
  ) {
    return { type: "command", action: "close_drawer", rawTranscript: rawText };
  }

  // 2. Otherwise, treat as a forensic search query
  return {
    type: "query",
    query: rawText.trim(),
    rawTranscript: rawText,
  };
}
