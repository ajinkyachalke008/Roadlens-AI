/**
 * In-browser Speech-to-Text service utilizing native Web Speech API.
 * 100% Client-Side with zero external cloud dependencies.
 */

// Types for Web Speech API
interface SpeechRecognitionEventLike extends Event {
  results: {
    length: number;
    [index: number]: {
      [index: number]: {
        transcript: string;
        confidence: number;
      };
      isFinal: boolean;
    };
  };
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

export interface SpeechListenOptions {
  onInterim?: (transcript: string) => void;
  onFinal?: (transcript: string) => void;
  onError?: (error: string) => void;
  onEnd?: () => void;
  lang?: string;
}

export class SpeechService {
  private recognition: SpeechRecognitionInstance | null = null;
  private activeListening = false;

  public isSupported(): boolean {
    if (typeof window === "undefined") return false;
    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition);
  }

  public isListening(): boolean {
    return this.activeListening;
  }

  public startListening(options: SpeechListenOptions): void {
    if (this.activeListening) {
      this.stopListening();
    }

    if (typeof window === "undefined") {
      options.onError?.("Speech recognition is unavailable in this environment.");
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };

    const SpeechRecClass = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRecClass) {
      options.onError?.("Web Speech API is not supported in this browser.");
      return;
    }

    try {
      this.recognition = new SpeechRecClass();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = options.lang || "en-IN";

      let finalTranscript = "";

      this.recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let interimTranscript = "";
        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalTranscript += res[0].transcript;
          } else {
            interimTranscript += res[0].transcript;
          }
        }

        if (interimTranscript) {
          options.onInterim?.(interimTranscript);
        }
        if (finalTranscript) {
          options.onFinal?.(finalTranscript);
        }
      };

      this.recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        this.activeListening = false;
        options.onError?.(event.error || "Speech recognition error");
      };

      this.recognition.onend = () => {
        this.activeListening = false;
        options.onEnd?.();
      };

      this.recognition.start();
      this.activeListening = true;
    } catch (err) {
      this.activeListening = false;
      options.onError?.(String(err));
    }
  }

  public stopListening(): void {
    if (this.recognition && this.activeListening) {
      try {
        this.recognition.stop();
      } catch {
        // Safe ignore
      }
    }
    this.activeListening = false;
  }
}

export const speech = new SpeechService();
