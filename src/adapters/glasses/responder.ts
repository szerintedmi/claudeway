import type { ServerWebSocket } from 'bun';
import type {
  ChannelResponder,
  IStreamingResponder,
  ToolEventPayload,
} from '../../core/interfaces.js';
import { serializeServerMessage, type GlassesServerMessage } from './protocol.js';
import type { WsData } from './index.js';

function send(ws: ServerWebSocket<WsData>, msg: GlassesServerMessage): void {
  try {
    ws.send(serializeServerMessage(msg));
  } catch {
    // Connection may have closed
  }
}

class GlassesStreamingResponder implements IStreamingResponder {
  private ws: ServerWebSocket<WsData>;
  private requestId: string;
  private fullText = '';

  constructor(ws: ServerWebSocket<WsData>, requestId: string) {
    this.ws = ws;
    this.requestId = requestId;
  }

  onTextDelta(text: string): void {
    this.fullText += text;
    send(this.ws, { type: 'response_text', requestId: this.requestId, text, final: false });
  }

  onToolEvent(event: ToolEventPayload): void {
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

  async finish(): Promise<void> {
    send(this.ws, { type: 'response_text', requestId: this.requestId, text: '', final: true });
  }

  getFullText(): string {
    return this.fullText;
  }
}

export class GlassesChannelResponder implements ChannelResponder {
  private ws: ServerWebSocket<WsData>;
  private requestId: string;

  constructor(ws: ServerWebSocket<WsData>, requestId: string) {
    this.ws = ws;
    this.requestId = requestId;
  }

  async onProcessing(): Promise<void> {
    send(this.ws, { type: 'status', requestId: this.requestId, status: 'thinking' });
  }

  async onComplete(): Promise<void> {
    // No-op — WS doesn't need completion signals
  }

  async onError(message: string): Promise<void> {
    send(this.ws, { type: 'error', requestId: this.requestId, message });
  }

  async sendResponse(text: string): Promise<void> {
    send(this.ws, { type: 'response_text', requestId: this.requestId, text, final: true });
  }

  createStreamingResponder(): IStreamingResponder {
    return new GlassesStreamingResponder(this.ws, this.requestId);
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
}
