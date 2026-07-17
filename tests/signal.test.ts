import { describe, it, expect } from 'vitest';
import { encodeSignal, decodeSignal } from '../src/signal';

describe('encodeSignal', () => {
  it('encodes to URL fragment', () => {
    const data = { type: 'offer' as const, sdp: 'v=0\r\no=test...' };
    const result = encodeSignal(data);
    expect(result.url).toMatch(/^#sdp=/);
    expect(result.sizeKB).toBeGreaterThan(0);
  });

  it('appends to baseUrl', () => {
    const { url } = encodeSignal({ sdp: 'x' }, 'http://localhost:8080');
    expect(url).toMatch(/^http:\/\/localhost:8080\/?#sdp=/);
  });

  it('strips existing fragments from baseUrl', () => {
    const { url } = encodeSignal({ sdp: 'x' }, 'http://x.com#old');
    expect(url).not.toContain('#old');
  });
});

describe('decodeSignal', () => {
  it('roundtrips', () => {
    const original = { type: 'offer' as const, sdp: 'v=0\r\no=test...' };
    const { url } = encodeSignal(original);
    expect(decodeSignal(url)).toEqual(original);
  });

  it('decodes raw base64 (no #sdp=)', () => {
    const original = { type: 'answer' as const, sdp: 'test' };
    const b64 = btoa(JSON.stringify(original));
    expect(decodeSignal(b64)).toEqual(original);
  });

  it('returns null for invalid input', () => {
    expect(decodeSignal('')).toBeNull();
    expect(decodeSignal('not-sdp')).toBeNull();
  });
});