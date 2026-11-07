import WebSocket from "ws";
import { config } from "./config.js";
import type { CaptionEvent, EventLog } from "./events.js";

const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen?" +
  new URLSearchParams({
    model: config.deepgramModel,
    language: "en",
    smart_format: "true", // punctuation, capitals, numbers
    interim_results: "true", // words appear while the teacher is still speaking
    endpointing: "300", // a 300 ms pause marks the end of a phrase
    utterance_end_ms: "1000", // backup end-of-phrase signal when background noise hides pauses
  });

const MAX_CAPTION_CHARS = 220;

/**
 * Turns Deepgram's stream of word guesses into captions of about one sentence.
 * While the teacher is talking, the same caption id is re-sent with more words (final: false);
 * it is sent one last time with final: true when the sentence ends, and only then is it
 * handed to the AI pipelines.
 */
export class CaptionAssembler {
  private id: string | null = null;
  private startT = 0;
  private committed = "";
  private discarded = false;

  constructor(
    private log: EventLog,
    private onFinal: (caption: CaptionEvent) => void,
  ) {}

  /** isFinal: Deepgram won't revise these words again. speechFinal: the speaker paused. */
  result(transcript: string, isFinal: boolean, speechFinal: boolean): void {
    if (this.discarded) return;
    if (isFinal) {
      this.committed = join(this.committed, transcript);
      const sentenceDone = /[.?!]$/.test(this.committed) || this.committed.length > MAX_CAPTION_CHARS;
      if (speechFinal || sentenceDone) this.close();
      else if (this.committed) this.emit(this.committed, false);
    } else if (transcript) {
      this.emit(join(this.committed, transcript), false);
    }
  }

  close(): void {
    if (this.discarded || !this.committed) return;
    const caption = this.emit(this.committed, true);
    this.id = null;
    this.committed = "";
    this.onFinal(caption);
  }

  /** Drops the caption in progress and ignores anything later (used when the lecture is reset). */
  discard(): void {
    this.discarded = true;
    this.committed = "";
  }

  private emit(text: string, final: boolean): CaptionEvent {
    if (!this.id) {
      this.id = this.log.nextId("c");
      this.startT = this.log.now();
    }
    const caption: CaptionEvent = { type: "caption", id: this.id, t: this.startT, text, final };
    this.log.push(caption);
    return caption;
  }
}

function join(a: string, b: string): string {
  return [a, b.trim()].filter(Boolean).join(" ");
}

export type SttStatus = { state: "connecting" | "open" | "closed" | "error"; message?: string };

/**
 * One live Deepgram connection per teacher microphone. The browser sends WebM/Opus chunks;
 * the first chunk carries the file header, so chunks that arrive before Deepgram is ready are
 * queued, never dropped.
 */
export class DeepgramStream {
  private ws: WebSocket;
  private backlog: Buffer[] = [];
  private lastAudioAt = Date.now();
  private keepAlive: NodeJS.Timeout;

  constructor(
    private assembler: CaptionAssembler,
    onStatus: (status: SttStatus) => void,
  ) {
    onStatus({ state: "connecting" });
    this.ws = new WebSocket(DEEPGRAM_URL, { headers: { Authorization: `Token ${config.deepgramKey}` } });

    this.ws.on("open", () => {
      for (const chunk of this.backlog) this.ws.send(chunk);
      this.backlog = [];
      onStatus({ state: "open" });
    });

    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "Results") {
        const transcript: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
        this.assembler.result(transcript, Boolean(msg.is_final), Boolean(msg.speech_final));
      } else if (msg.type === "UtteranceEnd") {
        this.assembler.close();
      }
    });

    this.ws.on("unexpected-response", (_req, res) => {
      onStatus({ state: "error", message: `Deepgram refused the connection (HTTP ${res.statusCode})` });
    });
    this.ws.on("error", (error) => onStatus({ state: "error", message: error.message }));
    this.ws.on("close", (code, reason) => {
      clearInterval(this.keepAlive);
      this.assembler.close();
      onStatus({ state: "closed", message: `${code} ${reason.toString()}`.trim() });
    });

    // Deepgram hangs up after ~10 s without audio; keep it open while the mic is paused.
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastAudioAt > 3000) {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 3000);
  }

  send(chunk: Buffer): void {
    this.lastAudioAt = Date.now();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.backlog.push(chunk);
  }

  close(): void {
    clearInterval(this.keepAlive);
    if (this.ws.readyState === WebSocket.OPEN) {
      // Ask Deepgram to flush its last words before hanging up.
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      setTimeout(() => this.ws.close(), 1500);
    } else {
      this.ws.terminate();
    }
  }
}
