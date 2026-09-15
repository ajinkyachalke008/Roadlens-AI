import { useState, useRef, useEffect } from "react";
import {
  type VehicleRecord,
  recordToObservation,
} from "../ai/trafficQueryEngine";
import type { ForensicSearchResponse, AmbiguityClarification } from "../../../shared/src/forensicTypes";
import { searchForensics, checkBackendHealth } from "../api/forensicsClient";

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  text: string;
  timestamp: string;
  queryResult?: ForensicSearchResponse;
  ambiguity?: AmbiguityClarification;
}

interface ForensicChatDrawerProps {
  records: VehicleRecord[];
  onClose: () => void;
  onSelectReport?: (reportId: string) => void;
  onViewDossier?: (vehicleId: string) => void;
}

const QUICK_PROMPT_CATEGORIES = [
  {
    label: "🎨 By Color",
    prompts: [
      "Find all red vehicles",
      "Show white cars",
      "Find black vehicles",
      "Show blue cars",
      "Find silver vehicles",
      "Show yellow vehicles",
      "Find green vehicles",
      "Show orange vehicles",
      "Find brown vehicles",
    ],
  },
  {
    label: "🚗 By Type",
    prompts: [
      "Show all cars",
      "Find all trucks",
      "Show all buses",
      "Find all two-wheelers",
      "Show all motorcycles",
    ],
  },
  {
    label: "⚡ Speed & Violations",
    prompts: [
      "Show all speeding vehicles",
      "Find vehicles over 60 km/h",
      "Find vehicles over 80 km/h",
      "Find two-wheelers with violations",
      "Show vehicles with helmet violations",
      "Find triple riding violations",
      "The fastest vehicles today",
    ],
  },
  {
    label: "🇮🇳 Plates & RTO",
    prompts: [
      "Find vehicles with scanned plates",
      "Show vehicles from Maharashtra (MH)",
      "Find plates from Delhi (DL)",
      "Show plates from Karnataka (KA)",
      "Find plates from Gujarat (GJ)",
      "Show all number plates",
    ],
  },
  {
    label: "🔍 Combined Search",
    prompts: [
      "Find red cars and their number plate",
      "Show speeding trucks",
      "Find white two-wheelers",
      "Show black cars with plates",
      "Find blue trucks",
      "Show all vehicles detected",
    ],
  },
];

export function ForensicChatDrawer({
  records,
  onClose,
  onSelectReport,
  onViewDossier,
}: ForensicChatDrawerProps) {
  const [isEnterpriseOnline, setIsEnterpriseOnline] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: "msg-welcome",
      sender: "assistant",
      text: `Hello! I am your AI Traffic Forensic Assistant. You can ask me to find any vehicle by color, type, speed, or license plate in plain English.`,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const [inputText, setInputText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    checkBackendHealth().then((online) => setIsEnterpriseOnline(online));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async (textToSend?: string) => {
    const query = (textToSend ?? inputText).trim();
    if (!query || isProcessing) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setIsProcessing(true);

    try {
      const liveObservations = records.map((r) => recordToObservation(r));
      const result = await searchForensics(query, liveObservations);

      const assistantMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        sender: "assistant",
        text: result.summary,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        queryResult: result,
        ambiguity: result.ambiguity,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      const errorMsg: ChatMessage = {
        id: `ai-err-${Date.now()}`,
        sender: "assistant",
        text: "Error searching vehicle observations. Please try a different query.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <aside className="forensic-chat-drawer" aria-label="AI Forensic Traffic Assistant">
      <div className="forensic-chat-header">
        <div className="forensic-chat-title">
          <span className="forensic-avatar" aria-hidden="true">🤖</span>
          <div>
            <h3>RoadLens AI Forensic Assistant</h3>
            <div className="forensic-status-line">
              <span className={`engine-badge ${isEnterpriseOnline ? "enterprise" : "client"}`}>
                {isEnterpriseOnline ? "● Enterprise PostGIS Cluster" : "● Live Camera Stream Search"}
              </span>
              <span className="indexed-count">
                · {records.length} vehicles indexed in RAM
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          className="forensic-close-btn"
          aria-label="Close AI Assistant"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="forensic-prompts-bar">
        <span className="prompts-label">Quick Prompts — tap any to search instantly:</span>
        {QUICK_PROMPT_CATEGORIES.map((cat) => (
          <div key={cat.label} className="prompt-category">
            <span className="prompt-category-label">{cat.label}</span>
            <div className="prompts-scroll">
              {cat.prompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="prompt-pill"
                  onClick={() => handleSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="forensic-messages-container">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`forensic-message ${msg.sender === "user" ? "user-msg" : "assistant-msg"}`}
          >
            <div className="msg-bubble">
              <div className="msg-header">
                <span className="msg-sender">
                  {msg.sender === "user" ? "You" : "RoadLens AI"}
                </span>
                <span className="msg-time">{msg.timestamp}</span>
                {msg.queryResult && (
                  <span className="latency-badge">
                    {msg.queryResult.executionTimeMs}ms
                  </span>
                )}
              </div>
              <p className="msg-text">{msg.text}</p>

              {/* Ambiguity clarification buttons */}
              {msg.ambiguity?.isAmbiguous && (
                <div className="ambiguity-box">
                  <span className="ambiguity-title">💡 {msg.ambiguity.reason}</span>
                  <div className="ambiguity-chips">
                    {msg.ambiguity.options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        className="ambiguity-chip-btn"
                        onClick={() => handleSend(opt.query)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {msg.queryResult && msg.queryResult.matchedObservations.length > 0 && (
                <div className="matched-records-grid">
                  {msg.queryResult.matchedObservations.map((obs) => (
                    <VehicleCardItem
                      key={obs.id}
                      obs={obs}
                      onSelectReport={onSelectReport}
                      onViewDossier={onViewDossier}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {isProcessing && (
          <div className="forensic-message assistant-msg">
            <div className="msg-bubble processing-bubble">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span>Analyzing CCTV vehicle records…</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form
        className="forensic-chat-input-bar"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Ask RoadLens AI (e.g. 'Find all red cars and their number plate')..."
          aria-label="Query traffic records"
          disabled={isProcessing}
        />
        <button
          type="submit"
          className="send-btn"
          disabled={!inputText.trim() || isProcessing}
          aria-label="Send Query"
        >
          Send ➔
        </button>
      </form>
    </aside>
  );
}

function VehicleCardItem({
  obs,
  onSelectReport,
  onViewDossier,
}: {
  obs: {
    id: string;
    reportId?: string;
    trackId: number | null;
    vehicleClass: string;
    color: { name: string; hex: string; confidence: number };
    plate: { text: string | null; stateCode: string | null; rtoLocation?: string | null; confidence: number };
    speed: { kmh: number | null; isSpeeding: boolean };
    violations: string[];
    snapshotDataUrl?: string | null;
  };
  onSelectReport?: (reportId: string) => void;
  onViewDossier?: (vehicleId: string) => void;
}) {
  return (
    <div className="vehicle-match-card">
      <div className="match-card-head">
        <span className="vehicle-class-tag">
          {obs.vehicleClass.toUpperCase()} {obs.trackId != null ? `· ID ${obs.trackId}` : ""}
        </span>
        <span
          className="vehicle-color-pill"
          style={{
            borderColor: obs.color.hex,
            backgroundColor: `${obs.color.hex}18`,
          }}
        >
          <i
            className="color-dot"
            style={{ backgroundColor: obs.color.hex }}
          />
          {obs.color.name}
          <small className="color-conf-sub">
            ({Math.round(obs.color.confidence * 100)}%)
          </small>
        </span>
      </div>

      {obs.snapshotDataUrl && (
        <div className="match-thumbnail-wrap">
          <img
            src={obs.snapshotDataUrl}
            alt={`${obs.color.name} ${obs.vehicleClass}`}
            className="match-thumbnail"
          />
        </div>
      )}

      <div className="match-details">
        {obs.plate.text ? (
          <div className="match-plate">
            <span className="plate-badge-hsrp">
              <span className="ind-bar">IND</span>
              <strong>{obs.plate.text}</strong>
            </span>
            {obs.plate.rtoLocation && (
              <small className="rto-location-tag">
                📍 {obs.plate.rtoLocation}
              </small>
            )}
          </div>
        ) : (
          <span className="match-unscanned-plate">
            🔍 Plate unread / not captured
          </span>
        )}

        <div className="match-meta-row">
          {obs.speed.kmh != null && (
            <span
              className={`speed-pill ${obs.speed.isSpeeding ? "speeding" : ""}`}
            >
              ⚡ {obs.speed.kmh} km/h
              {obs.speed.isSpeeding ? " · OVER LIMIT" : ""}
            </span>
          )}

          {obs.violations && obs.violations.length > 0 && (
            <span className="violation-pill">
              ⚠️ {obs.violations[0]}
            </span>
          )}
        </div>
      </div>

      <div className="match-card-actions">
        {onViewDossier && (
          <button
            type="button"
            className="view-dossier-btn"
            onClick={() => onViewDossier(obs.plate.text || obs.id)}
          >
            🗺️ Dossier & Route Map ➔
          </button>
        )}

        {obs.reportId && onSelectReport && (
          <button
            type="button"
            className="view-report-btn"
            onClick={() => onSelectReport(obs.reportId!)}
          >
            📄 Issue e-Challan Notice ↗
          </button>
        )}
      </div>
    </div>
  );
}
