import { describe, it, expect } from 'bun:test';
import {
  parseClientMessage,
  serializeServerMessage,
  type GlassesServerMessage,
} from '../adapters/glasses/protocol.js';

describe('parseClientMessage', () => {
  it('parses a valid text message', () => {
    const msg = parseClientMessage('{"type":"text","requestId":"r1","text":"hello"}');
    expect(msg).toEqual({ type: 'text', requestId: 'r1', text: 'hello' });
  });

  it('parses a valid cancel message', () => {
    const msg = parseClientMessage('{"type":"cancel","requestId":"r2"}');
    expect(msg).toEqual({ type: 'cancel', requestId: 'r2' });
  });

  it('parses a valid ping message', () => {
    const msg = parseClientMessage('{"type":"ping"}');
    expect(msg).toEqual({ type: 'ping' });
  });

  it('rejects invalid JSON', () => {
    expect(() => parseClientMessage('not json')).toThrow('Invalid JSON');
  });

  it('rejects non-object JSON', () => {
    expect(() => parseClientMessage('"hello"')).toThrow('must be a JSON object');
  });

  it('rejects missing type', () => {
    expect(() => parseClientMessage('{"requestId":"r1"}')).toThrow(
      'Unknown or missing message type',
    );
  });

  it('rejects unknown type', () => {
    expect(() => parseClientMessage('{"type":"audio","requestId":"r1"}')).toThrow(
      'Unknown or missing message type',
    );
  });

  it('rejects text message without requestId', () => {
    expect(() => parseClientMessage('{"type":"text","text":"hi"}')).toThrow(
      'Missing or empty requestId',
    );
  });

  it('rejects text message with empty requestId', () => {
    expect(() => parseClientMessage('{"type":"text","requestId":"","text":"hi"}')).toThrow(
      'Missing or empty requestId',
    );
  });

  it('rejects text message without text field', () => {
    expect(() => parseClientMessage('{"type":"text","requestId":"r1"}')).toThrow(
      'Missing text field',
    );
  });

  it('rejects cancel message without requestId', () => {
    expect(() => parseClientMessage('{"type":"cancel"}')).toThrow('Missing or empty requestId');
  });
});

describe('serializeServerMessage', () => {
  it('serializes a status message', () => {
    const msg: GlassesServerMessage = { type: 'status', requestId: 'r1', status: 'thinking' };
    const json = JSON.parse(serializeServerMessage(msg));
    expect(json).toEqual({ type: 'status', requestId: 'r1', status: 'thinking' });
  });

  it('serializes a response_text message', () => {
    const msg: GlassesServerMessage = {
      type: 'response_text',
      requestId: 'r1',
      text: 'hello',
      final: true,
    };
    const json = JSON.parse(serializeServerMessage(msg));
    expect(json).toEqual({ type: 'response_text', requestId: 'r1', text: 'hello', final: true });
  });

  it('serializes a transcript message', () => {
    const msg: GlassesServerMessage = {
      type: 'transcript',
      requestId: 'r1',
      text: 'spoken text',
      final: false,
    };
    const json = JSON.parse(serializeServerMessage(msg));
    expect(json).toEqual({
      type: 'transcript',
      requestId: 'r1',
      text: 'spoken text',
      final: false,
    });
  });

  it('serializes an error message with requestId', () => {
    const msg: GlassesServerMessage = { type: 'error', requestId: 'r1', message: 'oops' };
    const json = JSON.parse(serializeServerMessage(msg));
    expect(json).toEqual({ type: 'error', requestId: 'r1', message: 'oops' });
  });

  it('serializes an error message with null requestId', () => {
    const msg: GlassesServerMessage = { type: 'error', requestId: null, message: 'bad' };
    const json = JSON.parse(serializeServerMessage(msg));
    expect(json).toEqual({ type: 'error', requestId: null, message: 'bad' });
  });

  it('serializes a pong message', () => {
    const msg: GlassesServerMessage = { type: 'pong' };
    const json = JSON.parse(serializeServerMessage(msg));
    expect(json).toEqual({ type: 'pong' });
  });
});
