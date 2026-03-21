import { DeepgramClient } from '@deepgram/sdk';
import type {
  VoiceProvider,
  AudioFormat,
  TranscriptionResult,
  TtsStreamHandle,
  TtsOptions,
} from './voice.js';

const DEEPGRAM_TTS_WS_URL = 'wss://api.deepgram.com/v1/speak';

export class DeepgramVoiceProvider implements VoiceProvider {
  private client: DeepgramClient;
  private apiKey: string;
  private sttModel: string;

  constructor(apiKey: string, sttModel = 'nova-3') {
    this.client = new DeepgramClient({ apiKey });
    this.apiKey = apiKey;
    this.sttModel = sttModel;
  }

  async transcribe(
    audio: Buffer,
    format: AudioFormat,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const response = await this.client.listen.v1.media.transcribeFile(
      audio,
      {
        model: this.sttModel,
        smart_format: true,
        ...(format.mimeType ? { mimetype: format.mimeType } : {}),
        ...(format.sampleRate ? { sample_rate: format.sampleRate } : {}),
        ...(format.channels ? { channels: format.channels } : {}),
        ...(format.encoding ? { encoding: format.encoding } : {}),
      },
      signal ? { abortSignal: signal } : undefined,
    );

    // transcribeFile returns ListenV1Response | ListenV1AcceptedResponse
    // We need the synchronous response which has 'results'
    if (!('results' in response)) {
      throw new Error('Deepgram returned an async response — expected synchronous transcription');
    }

    const alternative = response.results?.channels?.[0]?.alternatives?.[0];
    return {
      transcript: alternative?.transcript ?? '',
      confidence: alternative?.confidence,
    };
  }

  createTtsStream(options: TtsOptions): TtsStreamHandle {
    return new DeepgramTtsStream(this.apiKey, options);
  }
}

/**
 * Deepgram TTS over native WebSocket.
 *
 * Uses Bun's native WebSocket directly instead of the Deepgram SDK, because
 * the SDK v5 V1Socket.handleMessage runs all frames through JSON.parse(),
 * silently dropping binary audio data.
 *
 * Protocol:
 * - Send: { type: "Speak", text }, { type: "Flush" }, { type: "Clear" }, { type: "Close" }
 * - Receive: binary frames (audio) + JSON frames (Metadata, Flushed, Cleared, Warning, etc.)
 *
 * This class owns protocol execution only — sendText, flush, finalize, clear, abort.
 * Flush scheduling policy (when and how often to flush) is owned by the caller
 * (e.g. GlassesStreamingResponder). Deepgram allows max 20 Flush per 60s.
 *
 * Clear semantics (per Deepgram docs):
 * - Use Clear for conversational barge-in / interruption.
 * - Clears internal text and audio buffers; stops audio generation immediately.
 * - Server responds with { type: "Cleared", sequence_id }.
 */
class DeepgramTtsStream implements TtsStreamHandle {
  private ws: WebSocket | null = null;
  private audioHandler: ((audio: Buffer) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closed = false;
  private finalizeResolve: (() => void) | null = null;
  private finalizing = false;
  private cleared = false;
  private pendingSends: string[] = [];
  private ready = false;
  private finalizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private clearTimeout: ReturnType<typeof setTimeout> | null = null;
  // Protocol-level coalescing: Deepgram does not ACK flushes 1:1 — rapid
  // flushes get coalesced server-side, so we keep at most one in-flight.
  private flushInFlight = false;
  private flushQueued = false;

  // Protocol telemetry
  private stats = { speakCount: 0, flushCount: 0, flushedCount: 0, clearedCount: 0 };

  constructor(apiKey: string, options: TtsOptions) {
    const params = new URLSearchParams({
      model: options.model,
      encoding: options.encoding,
      sample_rate: String(options.sampleRate),
    });
    const url = `${DEEPGRAM_TTS_WS_URL}?${params}`;

    // Bun's WebSocket takes headers in the 2nd arg (not 3rd like the `ws` library)
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    } as unknown as string[]);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      if (this.closed) {
        this.ws?.close();
        return;
      }
      this.ready = true;
      for (const msg of this.pendingSends) {
        this.ws?.send(msg);
      }
      this.pendingSends = [];
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (this.closed) return;

      // Binary frame = audio chunk
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength > 0 && this.audioHandler && !this.cleared) {
          this.audioHandler(Buffer.from(event.data));
        }
        return;
      }

      // JSON control message
      try {
        const msg = JSON.parse(event.data as string) as { type?: string; sequence_id?: number };

        if (msg.type === 'Flushed') {
          this.stats.flushedCount++;
          this.flushInFlight = false;

          if (this.flushQueued && !this.closed && !this.cleared) {
            this.flushQueued = false;
            this.sendFlushNow();
          } else if (this.finalizing) {
            this.doClose();
          }
        } else if (msg.type === 'Cleared') {
          this.stats.clearedCount++;
          // Clear complete — safe to close or reuse
          if (this.cleared) {
            this.doClose();
          }
        } else if (msg.type === 'Warning') {
          console.warn('[deepgram-tts] Warning:', event.data);
        }
      } catch {
        // Ignore unparseable frames
      }
    };

    this.ws.onerror = (event: Event) => {
      const msg =
        (event as ErrorEvent).message ||
        ((event as ErrorEvent).error ? String((event as ErrorEvent).error) : 'WebSocket error');
      const error = new Error(msg);
      if (this.errorHandler) {
        this.errorHandler(error);
      }
      this.doClose();
    };

    this.ws.onclose = () => {
      if (!this.closed) {
        // Unexpected close — resolve any waiters
        this.doClose();
      }
    };
  }

  private wsSend(msg: string): void {
    if (this.ready && this.ws) {
      this.ws.send(msg);
    } else {
      this.pendingSends.push(msg);
    }
  }

  sendText(text: string): void {
    if (this.closed || this.cleared) return;
    this.stats.speakCount++;
    this.wsSend(JSON.stringify({ type: 'Speak', text }));
  }

  flush(): void {
    if (this.closed || this.cleared) return;
    if (this.flushInFlight) {
      // At most one queued — Deepgram coalesces rapid flushes server-side
      this.flushQueued = true;
      return;
    }
    this.sendFlushNow();
  }

  private sendFlushNow(): void {
    this.stats.flushCount++;
    this.flushInFlight = true;
    this.wsSend(JSON.stringify({ type: 'Flush' }));
  }

  /**
   * Wait for in-flight/queued flushes to complete, then close the connection.
   * The caller is responsible for sending any final flush() before calling this.
   */
  async finalize(): Promise<void> {
    if (this.closed || this.cleared) return;
    this.finalizing = true;

    // Nothing in-flight or queued — close immediately
    if (!this.flushInFlight && !this.flushQueued) {
      this.doClose();
      return;
    }

    // Wait for all Flushed ACKs
    return new Promise<void>((resolve) => {
      this.finalizeResolve = resolve;
      // Safety timeout — last-resort circuit breaker, not normal control flow.
      this.finalizeTimeout = setTimeout(() => {
        if (!this.closed) {
          console.warn(
            `[deepgram-tts] finalize() safety timeout (stats: ${JSON.stringify(this.stats)})`,
          );
          this.doClose();
        }
      }, 30_000);
    });
  }

  /**
   * Clear pending text/audio buffers (barge-in).
   * Sends Clear, stops forwarding audio, waits briefly for Cleared, then closes.
   */
  clear(): void {
    if (this.closed || this.cleared) return;
    this.cleared = true;
    // Stop forwarding audio immediately (checked in onmessage)
    this.wsSend(JSON.stringify({ type: 'Clear' }));
    // If we were finalizing, the Flushed event won't come — unblock the waiter
    if (this.finalizing) {
      this.doClose();
      return;
    }
    // Give Deepgram a moment to send Cleared, then close.
    // The onmessage handler calls doClose() when Cleared arrives.
    // This timeout is a fallback if Cleared never comes.
    this.clearTimeout = setTimeout(() => {
      if (!this.closed) {
        this.doClose();
      }
    }, 2_000);
  }

  abort(): void {
    if (this.closed) return;
    this.doClose();
  }

  onAudio(handler: (audio: Buffer) => void): void {
    this.audioHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private doClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingSends = [];
    if (this.finalizeTimeout) {
      clearTimeout(this.finalizeTimeout);
      this.finalizeTimeout = null;
    }
    if (this.clearTimeout) {
      clearTimeout(this.clearTimeout);
      this.clearTimeout = null;
    }
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'Close' }));
        this.ws.close();
      }
    } catch {
      // Connection may already be closed
    }
    this.ws = null;
    if (this.finalizeResolve) {
      this.finalizeResolve();
      this.finalizeResolve = null;
    }
    if (this.stats.speakCount > 0) {
      console.log(`[deepgram-tts] closed (${JSON.stringify(this.stats)})`);
    }
  }
}
