import { describe, it, expect, beforeEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { GlassesChannelResponder } from '../adapters/glasses/responder.js';
import type { WsData } from '../adapters/glasses/index.js';

// Mock ServerWebSocket — only the subset we use
interface MockWs {
  data: WsData;
  send(data: string): void;
}

function makeMockWs(): { ws: MockWs; sent: string[] } {
  const sent: string[] = [];
  const ws: MockWs = {
    data: { userId: 'U001', defaultChannel: 'C001' },
    send(data: string) {
      sent.push(data);
    },
  };
  return { ws, sent };
}

function parse(s: string) {
  return JSON.parse(s);
}

describe('GlassesChannelResponder', () => {
  let ws: MockWs;
  let sent: string[];
  let responder: GlassesChannelResponder;

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
    responder = new GlassesChannelResponder(ws as unknown as ServerWebSocket<WsData>, 'req-1');
  });

  it('onProcessing sends status: thinking', async () => {
    await responder.onProcessing();
    expect(sent).toHaveLength(1);
    expect(parse(sent[0])).toEqual({ type: 'status', requestId: 'req-1', status: 'thinking' });
  });

  it('sendResponse sends response_text with final: true', async () => {
    await responder.sendResponse('Hello world');
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('response_text');
    expect(msg.text).toBe('Hello world');
    expect(msg.final).toBe(true);
  });

  it('onError sends error message', async () => {
    await responder.onError('something broke');
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toBe('something broke');
    expect(msg.requestId).toBe('req-1');
  });

  it('onComplete sends no messages but calls onDone callback', async () => {
    let doneCallCount = 0;
    responder.onDone(() => doneCallCount++);
    await responder.onComplete();
    expect(sent).toHaveLength(0);
    expect(doneCallCount).toBe(1);
  });

  it('uploadFile sends a text note with filename', async () => {
    await responder.uploadFile('/path/to/report.pdf');
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('response_text');
    expect(msg.text).toBe('[File: report.pdf]');
    expect(msg.final).toBe(false);
  });

  it('warn sends error message', async () => {
    await responder.warn('heads up');
    expect(sent).toHaveLength(1);
    const msg = parse(sent[0]);
    expect(msg.type).toBe('error');
    expect(msg.message).toBe('heads up');
  });
});

describe('GlassesStreamingResponder', () => {
  let ws: MockWs;
  let sent: string[];
  let responder: GlassesChannelResponder;

  beforeEach(() => {
    ({ ws, sent } = makeMockWs());
    responder = new GlassesChannelResponder(ws as unknown as ServerWebSocket<WsData>, 'req-2');
  });

  it('onTextDelta sends chunks with final: false', () => {
    const sr = responder.createStreamingResponder();
    sr.onTextDelta('Hello ');
    sr.onTextDelta('world');
    expect(sent).toHaveLength(2);
    expect(parse(sent[0])).toMatchObject({ type: 'response_text', text: 'Hello ', final: false });
    expect(parse(sent[1])).toMatchObject({ type: 'response_text', text: 'world', final: false });
  });

  it('finish sends empty text with final: true', async () => {
    const sr = responder.createStreamingResponder();
    sr.onTextDelta('hi');
    await sr.finish();
    expect(sent).toHaveLength(2);
    expect(parse(sent[1])).toMatchObject({ type: 'response_text', text: '', final: true });
  });

  it('getFullText returns accumulated text', () => {
    const sr = responder.createStreamingResponder();
    sr.onTextDelta('a');
    sr.onTextDelta('b');
    expect(sr.getFullText()).toBe('ab');
  });

  it('onToolEvent sends tool status with name', () => {
    const sr = responder.createStreamingResponder();
    sr.onToolEvent({ toolName: 'Read', phase: 'start' });
    expect(sent).toHaveLength(1);
    expect(parse(sent[0])).toMatchObject({
      type: 'status',
      status: 'tool',
      toolName: 'Read',
      phase: 'start',
    });
  });

  it('onToolEvent sends tool status with keyArg on complete', () => {
    const sr = responder.createStreamingResponder();
    sr.onToolEvent({ toolName: 'Read', phase: 'complete', keyArg: 'src/index.ts' });
    expect(sent).toHaveLength(1);
    expect(parse(sent[0])).toMatchObject({
      type: 'status',
      status: 'tool',
      toolName: 'Read',
      phase: 'complete',
      keyArg: 'src/index.ts',
    });
  });
});
