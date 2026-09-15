import { useState, useRef, useEffect } from "react";
import {
  executeTrafficQuery,
  type VehicleRecord,
  type QueryResult,
} from "../ai/trafficQueryEngine";

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  text: string;
  timestamp: string;
  queryResult?: QueryResult;
}

interface ForensicChatDrawerProps {
  records: VehicleRecord[];
  onClose: () => void;
  onSelectReport?: (reportId: string) => void;
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
}: ForensicChatDrawerProps) {
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = (textToSend?: string) => {
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

    setTimeout(() => {
      const result = executeTrafficQuery(query, records);
      const assistantMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        sender: "assistant",
        text: result.summaryText,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        queryResult: result,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      setIsProcessing(false);
    }, 250);
  };

  return (
    <aside className="forensic-chat-drawer" aria-label="AI Forensic Traffic Assistant">
      <div className="forensic-chat-header">
        <div className="forensic-chat-title">
          <span className="forensic-avatar" aria-hidden="true">🤖</span>
          <div>
            <h3>RoadLens AI Forensic Assistant</h3>
            <p>
              Natural Language CCTV Search · <span className="live-dot" /> {records.length} vehicles indexed in RAM
            </p>
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
              </div>
              <p className="msg-text">{msg.text}</p>

              {msg.queryResult && msg.queryResult.matchedRecords.length > 0 && (
                <div className="matched-records-grid">
                  {msg.queryResult.matchedRecords.map((rec) => (
                    <VehicleCardItem
                      key={rec.id}
                      rec={rec}
                      onSelectReport={onSelectReport}
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
  rec,
  onSelectReport,
}: {
  rec: VehicleRecord;
  onSelectReport?: (reportId: string) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  useEffect(() => {
    if (rec.thumbnailBlob) {
      const url = URL.createObjectURL(rec.thumbnailBlob);
      setImgUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    if (rec.thumbnailUrl) {
      setImgUrl(rec.thumbnailUrl);
    }
  }, [rec.thumbnailBlob, rec.thumbnailUrl]);

  return (
    <div className="vehicle-match-card">
      <div className="match-card-head">
        <span className="vehicle-class-tag">
          {rec.className.toUpperCase()} {rec.trackId != null ? `· ID ${rec.trackId}` : ""}
        </span>
        <span
          className="vehicle-color-pill"
          style={{
            borderColor: rec.color.hex,
            backgroundColor: `${rec.color.hex}18`,
          }}
        >
          <i
            className="color-dot"
            style={{ backgroundColor: rec.color.hex }}
          />
          {rec.color.name}
        </span>
      </div>

      {imgUrl && (
        <div className="match-thumbnail-wrap">
          <img
            src={imgUrl}
            alt={`${rec.color.name} ${rec.className}`}
            className="match-thumbnail"
          />
        </div>
      )}

      <div className="match-details">
        {rec.plateText ? (
          <div className="match-plate">
            <span className="plate-badge-hsrp">
              <span className="ind-bar">IND</span>
              <strong>{rec.plateText}</strong>
            </span>
            {rec.rtoLocation && (
              <small className="rto-location-tag">
                📍 {rec.stateName ? `${rec.stateName} · ` : ""}{rec.rtoLocation}
              </small>
            )}
          </div>
        ) : (
          <span className="match-unscanned-plate">
            🔍 Plate unread / not captured
          </span>
        )}

        <div className="match-meta-row">
          {rec.speedKmh != null && (
            <span
              className={`speed-pill ${rec.isSpeeding ? "speeding" : ""}`}
            >
              ⚡ {rec.speedKmh} km/h
              {rec.isSpeeding ? " · OVER LIMIT" : ""}
            </span>
          )}

          {rec.violations && rec.violations.length > 0 && (
            <span className="violation-pill">
              ⚠️ {rec.violations[0]}
            </span>
          )}
        </div>
      </div>

      {rec.reportId && onSelectReport && (
        <button
          type="button"
          className="view-report-btn"
          onClick={() => onSelectReport(rec.reportId!)}
        >
          📄 View Official e-Challan / Report ↗
        </button>
      )}
    </div>
  );
}
