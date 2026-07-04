import type { ServerWebSocket } from 'bun';
import type {
  ChannelResponder,
  IStreamingResponder,
  StreamOutcome,
  ToolEventPayload,
} from '../../core/interfaces.js';
import { ProseChunker, type Chunk } from '../../core/prose-chunker.js';
import type { VoiceProvider, TtsStreamHandle, TtsOptions } from '../../core/voice.js';
import { serializeServerMessage, type VoiceServerMessage } from './protocol.js';
import type { WsData } from './index.js';

function send(ws: ServerWebSocket<WsData>, msg: VoiceServerMessage): void {
  try {
    ws.send(serializeServerMessage(msg));
  } catch {
    // Connection may have closed
  }
}

class VoiceStreamingResponder implements IStreamingResponder {
  private ws: ServerWebSocket<WsData>;
  private requestId: string;
  private fullText = '';
  private voiceProvider: VoiceProvider | undefined;
  private ttsOptions: TtsOptions | undefined;
  private ttsStream: TtsStreamHandle | null = null;
  private chunker: ProseChunker | null = null;
  private aborted = false;
  private ttsFailed = false;
  private killProcess: (() => void) | null = null;
  private flushTimestamps: number[] = [];

  /**
   * Flush rate limiter using a sliding window.
   * Deepgram allows max 20 flushes per 60s; we cap at 16 to leave headroom.
   * Turn-end flush always goes through regardless.
   */
  private static readonly MAX_FLUSHES_PER_WINDOW = 16;
  private static readonly FLUSH_WINDOW_MS = 60_000;
  private static readonly SENTENCE_FLUSH_MIN_CHARS = 140;
  private static readonly SENTENCE_FLUSH_MIN_MS = 2_000;

  constructor(
    ws: ServerWebSocket<WsData>,
    requestId: string,
    voiceProvider?: VoiceProvider,
    ttsOptions?: TtsOptions,
  ) {
    this.ws = ws;
    this.requestId = requestId;
    this.voiceProvider = voiceProvider;
    this.ttsOptions = ttsOptions;

    if (voiceProvider && ttsOptions) {
      this.chunker = new ProseChunker((chunk) => {
        this.handleChunk(chunk);
      });
    }
  }

  onTextDelta(text: string): void {
    if (this.aborted) return;
    this.fullText += text;
    send(this.ws, { type: 'response_text', requestId: this.requestId, text, final: false });

    if (this.chunker) {
      this.chunker.push(text);
    }
  }

  onToolEvent(event: ToolEventPayload): void {
    if (this.aborted) return;
    if (event.phase === 'subagent_progress' || event.phase === 'subagent_completed') {
      const usage = event.phase === 'subagent_completed' ? event.usage : undefined;
      send(this.ws, {
        type: 'status',
        requestId: this.requestId,
        status: 'tool',
        toolName: event.toolName,
        phase: event.phase,
        description: event.description,
        ...(usage ? { usage } : {}),
      });
      return;
    }
    const keyArg = event.phase === 'complete' ? (event.keyArg ?? undefined) : undefined;
    send(this.ws, {
      type: 'status',
      requestId: this.requestId,
      status: 'tool',
      toolName: event.toolName,
      phase: event.phase,
      ...(keyArg ? { keyArg } : {}),
    });
  }

  onProcessSpawned(kill: () => void): void {
    this.killProcess = kill;
  }

  async finish(outcome?: StreamOutcome): Promise<void> {
    // A failed turn (engine cleanup after a mid-turn crash) already sent an
    // `{type:'error'}` — do not speak the partial buffered text or send a
    // `response_audio_end` that the client would read as success. Just mark the
    // text stream final and stop.
    if (outcome?.ok === false) {
      send(this.ws, { type: 'response_text', requestId: this.requestId, text: '', final: true });
      return;
    }

    send(this.ws, { type: 'response_text', requestId: this.requestId, text: '', final: true });

    if (this.aborted || this.ttsFailed) return;

    // Send any remaining buffered text to TTS (handles short responses that
    // never hit a boundary during streaming, e.g. "OK.")
    if (this.chunker) {
      const trailing = this.chunker.drain();
      if (trailing) {
        this.ensureTtsStream();
        if (this.ttsStream) {
          this.ttsStream.sendText(trailing);
        }
      }
    }

    if (this.ttsStream && !this.ttsFailed) {
      // One explicit final flush, then wait for drain
      this.ttsStream.flush();
      await this.ttsStream.finalize();
      if (!this.aborted) {
        send(this.ws, { type: 'response_audio_end', requestId: this.requestId });
      }
    }
  }

  getFullText(): string {
    return this.fullText;
  }

  /** Cancel this request — clear TTS buffers, kill Claude process if running */
  cancel(): void {
    this.aborted = true;
    if (this.ttsStream) {
      // Use Clear to stop audio generation immediately (Deepgram barge-in primitive).
      // clear() handles its own teardown — sends Clear, waits for Cleared, then closes.
      this.ttsStream.clear();
      send(this.ws, { type: 'response_audio_end', requestId: this.requestId });
    }
    if (this.killProcess) {
      this.killProcess();
    }
  }

  /** Check if we're under the flush rate limit (sliding window) */
  private canFlush(): boolean {
    const now = Date.now();
    const windowStart = now - VoiceStreamingResponder.FLUSH_WINDOW_MS;
    // Prune old timestamps
    while (this.flushTimestamps.length > 0 && this.flushTimestamps[0] < windowStart) {
      this.flushTimestamps.shift();
    }
    return this.flushTimestamps.length < VoiceStreamingResponder.MAX_FLUSHES_PER_WINDOW;
  }

  /** Send a flush and record the timestamp */
  private doFlush(): void {
    if (!this.ttsStream) return;
    this.ttsStream.flush();
    this.flushTimestamps.push(Date.now());
  }

  /** Lazily create TTS stream on first use */
  private ensureTtsStream(): void {
    if (this.ttsStream || !this.voiceProvider || !this.ttsOptions) return;
    this.ttsStream = this.voiceProvider.createTtsStream(this.ttsOptions);
    this.ttsStream.onAudio((audio) => {
      if (this.aborted) return;
      send(this.ws, {
        type: 'response_audio',
        requestId: this.requestId,
        data: audio.toString('base64'),
        encoding: this.ttsOptions!.encoding,
        sampleRate: this.ttsOptions!.sampleRate,
      });
    });
    this.ttsStream.onError((err) => {
      console.error(`[voice] TTS error for ${this.requestId}:`, err.message);
      if (!this.ttsFailed) {
        this.ttsFailed = true;
        send(this.ws, {
          type: 'error',
          requestId: this.requestId,
          message: `TTS failed: ${err.message}`,
        });
      }
    });
    send(this.ws, { type: 'status', requestId: this.requestId, status: 'speaking' });
  }

  /**
   * Handle a chunk from the prose chunker.
   * Flush policy is owned here — rate-limited via sliding window to stay
   * under the provider's 20/60s limit.
   */
  private handleChunk(chunk: Chunk): void {
    if (this.aborted || this.ttsFailed || !this.voiceProvider || !this.ttsOptions) return;

    this.ensureTtsStream();
    if (!this.ttsStream) return;

    this.ttsStream.sendText(chunk.text);

    let shouldFlush = false;
    switch (chunk.boundary) {
      case 'newline':
      case 'hard_cap':
      case 'code_block':
        // Strong boundaries: flush if rate allows
        shouldFlush = true;
        break;
      case 'sentence': {
        // Normal boundary: flush if chunk is large or it's been a while
        const lastFlush =
          this.flushTimestamps.length > 0
            ? this.flushTimestamps[this.flushTimestamps.length - 1]
            : 0;
        shouldFlush =
          chunk.text.length >= VoiceStreamingResponder.SENTENCE_FLUSH_MIN_CHARS ||
          Date.now() - lastFlush >= VoiceStreamingResponder.SENTENCE_FLUSH_MIN_MS;
        break;
      }
      case 'flush':
        // SentenceBuffer compat path — should not happen in normal responder flow
        shouldFlush = true;
        break;
    }

    if (shouldFlush && this.canFlush()) {
      this.doFlush();
    }
  }
}

export class VoiceChannelResponder implements ChannelResponder {
  private ws: ServerWebSocket<WsData>;
  private requestId: string;
  private voiceProvider: VoiceProvider | undefined;
  private ttsOptions: TtsOptions | undefined;
  private streamingResponder: VoiceStreamingResponder | null = null;
  private onDoneCallback: (() => void) | null = null;
  private _cancelled = false;

  constructor(
    ws: ServerWebSocket<WsData>,
    requestId: string,
    voiceProvider?: VoiceProvider,
    ttsOptions?: TtsOptions,
  ) {
    this.ws = ws;
    this.requestId = requestId;
    this.voiceProvider = voiceProvider;
    this.ttsOptions = ttsOptions;
  }

  /** Register callback for when this responder is done (success or error) */
  onDone(callback: () => void): void {
    this.onDoneCallback = callback;
  }

  /** Whether this responder was cancelled (e.g. barge-in) */
  get cancelled(): boolean {
    return this._cancelled;
  }

  async onProcessing(): Promise<void> {
    send(this.ws, { type: 'status', requestId: this.requestId, status: 'thinking' });
  }

  async onComplete(): Promise<void> {
    this.onDoneCallback?.();
  }

  async onError(message: string): Promise<void> {
    // Don't emit error to client if already cancelled — cancel handler already sent terminal signal
    if (this._cancelled) {
      this.onDoneCallback?.();
      return;
    }
    send(this.ws, { type: 'error', requestId: this.requestId, message });
    this.onDoneCallback?.();
  }

  async sendResponse(text: string): Promise<void> {
    send(this.ws, { type: 'response_text', requestId: this.requestId, text, final: true });
  }

  createStreamingResponder(): IStreamingResponder {
    this.streamingResponder = new VoiceStreamingResponder(
      this.ws,
      this.requestId,
      this.voiceProvider,
      this.ttsOptions,
    );
    return this.streamingResponder;
  }

  async onStreamComplete(): Promise<void> {
    // No-op — streaming responder handles final message
  }

  async uploadFile(filePath: string): Promise<void> {
    const { basename } = await import('path');
    send(this.ws, {
      type: 'response_text',
      requestId: this.requestId,
      text: `[File: ${basename(filePath)}]`,
      final: false,
    });
  }

  async warn(message: string): Promise<void> {
    send(this.ws, { type: 'error', requestId: this.requestId, message });
  }

  /** Cancel active streaming responder */
  cancel(): void {
    this._cancelled = true;
    if (this.streamingResponder) {
      this.streamingResponder.cancel();
    }
  }
}
