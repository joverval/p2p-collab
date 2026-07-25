import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock simple-peer ----

const mockPeers: any[] = [];

vi.mock('simple-peer', () => ({
  default: vi.fn().mockImplementation(function (this: any, opts: any) {
    const events = new Map();
    this._opts = opts;
    this._pc = { connectionState: 'new', iceConnectionState: 'new', getStats: vi.fn().mockResolvedValue(new Map()) };
    this.on = vi.fn((event: string, fn: any) => { events.set(event, fn); });
    this.signal = vi.fn();
    this.send = vi.fn();
    this.write = vi.fn().mockReturnValue(true);
    this.destroy = vi.fn(function (this: any) { events.get('close')?.(); });
    this.removeAllListeners = vi.fn();
    this.connected = false;
    this._events = events;
    mockPeers.push(this);
    return this;
  }),
}));

import { P2PRoom } from '../../src/room';

beforeEach(() => {
  mockPeers.length = 0;
});

function emitSignal(idx: number, data: any) {
  mockPeers[idx]._events.get('signal')?.(data);
}

// ═══════════════════════════════════════════════════════════
// 1. Default ICE config
// ═══════════════════════════════════════════════════════════

describe('default ICE config', () => {
  it('is STUN-only with no TURN servers', () => {
    const room = new P2PRoom(true, '');
    const rtc = (room as any)._rtcConfig;
    for (const s of rtc.iceServers ?? []) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      for (const u of urls) {
        expect(String(u)).toMatch(/^stun:/);
        expect(String(u)).not.toMatch(/^turn/);
      }
    }
  });

  it('does not mutate DEFAULT_ICE_CONFIG across instances', () => {
    // Create room with TURN config
    new P2PRoom(true, '', {
      rtcConfig: {
        iceServers: [{ urls: 'turn:custom.example.com:3478', username: 'u', credential: 'p' }],
      },
    });
    // Second room with defaults: should still be STUN-only
    const room2 = new P2PRoom(true, '');
    const rtc2 = (room2 as any)._rtcConfig;
    const urls = rtc2.iceServers?.flatMap((s: any) =>
      Array.isArray(s.urls) ? s.urls : [s.urls]) ?? [];
    expect(urls).toHaveLength(2);
    for (const u of urls) {
      expect(String(u)).not.toMatch(/^turn/);
    }
  });

  it('does not set relay transport policy by default', () => {
    const room = new P2PRoom(true, '');
    const rtc = (room as any)._rtcConfig;
    expect(rtc.iceTransportPolicy).toBe('all');
  });

  it('has no hardcoded TURN URLs in default', () => {
    const room = new P2PRoom(true, '');
    const rtc = (room as any)._rtcConfig;
    const allUrls = rtc.iceServers?.flatMap((s: any) =>
      Array.isArray(s.urls) ? s.urls : [s.urls]) ?? [];
    for (const u of allUrls) {
      expect(String(u)).not.toMatch(/^turn:/);
      expect(String(u)).not.toMatch(/^turns:/);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 2. IceMode
// ═══════════════════════════════════════════════════════════

describe('IceMode', () => {
  describe('all', () => {
    it('preserves TURN servers from rtcConfig', () => {
      const room = new P2PRoom(true, '', {
        iceMode: 'all',
        rtcConfig: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'turn:custom-turn:3478', username: 'u', credential: 'p' },
          ],
        },
      });
      const rtc = (room as any)._rtcConfig;
      const turnServers = (rtc.iceServers ?? []).filter((s: any) => {
        const u = Array.isArray(s.urls) ? s.urls[0] : s.urls;
        return String(u).startsWith('turn:');
      });
      expect(turnServers).toHaveLength(1);
      expect(turnServers[0].username).toBe('u');
    });

    it('sets transportPolicy to all', () => {
      const room = new P2PRoom(true, '', { iceMode: 'all' });
      expect((room as any)._rtcConfig.iceTransportPolicy).toBe('all');
    });
  });

  describe('stun-only', () => {
    it('strips TURN servers from rtcConfig', () => {
      const room = new P2PRoom(true, '', {
        iceMode: 'stun-only',
        rtcConfig: {
          iceServers: [
            { urls: 'stun:stun.example.com:3478' },
            { urls: 'turn:custom-turn:3478', username: 'u', credential: 'p' },
          ],
        },
      });
      const rtc = (room as any)._rtcConfig;
      expect(rtc.iceServers).toHaveLength(1);
      expect(rtc.iceServers[0].urls).toBe('stun:stun.example.com:3478');
    });

    it('strips turns: (TLS) servers too', () => {
      const room = new P2PRoom(true, '', {
        iceMode: 'stun-only',
        rtcConfig: {
          iceServers: [
            { urls: 'stun:stun.example.com:3478' },
            { urls: 'turns:secure-turn:5349', username: 'u', credential: 'p' },
          ],
        },
      });
      const rtc = (room as any)._rtcConfig;
      expect(rtc.iceServers).toHaveLength(1);
      expect(rtc.iceServers[0].urls).toBe('stun:stun.example.com:3478');
    });

    it('strips credentials from STUN servers', () => {
      const room = new P2PRoom(true, '', {
        iceMode: 'stun-only',
        rtcConfig: {
          iceServers: [{
            urls: 'stun:stun.example.com:3478',
            username: 'bad',
            credential: 'bad',
          }],
        },
      });
      const rtc = (room as any)._rtcConfig;
      const s = rtc.iceServers[0];
      expect(s.username).toBeUndefined();
      expect(s.credential).toBeUndefined();
    });

    it('sets transportPolicy to all', () => {
      const room = new P2PRoom(true, '', { iceMode: 'stun-only' });
      expect((room as any)._rtcConfig.iceTransportPolicy).toBe('all');
    });
  });

  describe('turn-only', () => {
    it('sets transportPolicy to relay', () => {
      const room = new P2PRoom(true, '', {
        iceMode: 'turn-only',
        rtcConfig: {
          iceServers: [{ urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' }],
        },
      });
      expect((room as any)._rtcConfig.iceTransportPolicy).toBe('relay');
    });

    it('throws TURN_REQUIRED without TURN', () => {
      expect(() => new P2PRoom(true, '', { iceMode: 'turn-only' })).toThrow('TURN_REQUIRED');
    });

    it('throws TURN_REQUIRED with only STUN', () => {
      expect(() => new P2PRoom(true, '', {
        iceMode: 'turn-only',
        rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      })).toThrow('TURN_REQUIRED');
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Offer lifecycle
// ═══════════════════════════════════════════════════════════

describe('offer lifecycle', () => {
  it('offerUrl generates unique random IDs', async () => {
    const room = new P2PRoom(true, 'http://localhost');
    const p1 = room.offerUrl();
    const p2 = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'a' });
    emitSignal(1, { type: 'offer', sdp: 'b' });
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.offerId).not.toBe(o2.offerId);
    expect(o1.offerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('acceptAnswer sets state to answered', async () => {
    const room = new P2PRoom(true, 'http://localhost');
    const p = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'x' });
    const { offerId } = await p;

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' }));
    room.acceptAnswer(offerId, '#sdp=' + b64);

    const record = (room as any)._offers.get(offerId);
    expect(record).toBeTruthy();
    expect(record.state).toBe('answered');
    expect(record.answeredAt).toBeGreaterThan(0);
  });

  it('acceptAnswer signals the pending peer', async () => {
    const room = new P2PRoom(true, 'http://localhost');
    const p = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'x' });
    const { offerId } = await p;

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' }));
    room.acceptAnswer(offerId, '#sdp=' + b64);

    expect(mockPeers[0].signal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer', sdp: 'peer-sdp' }),
    );
  });

  it('duplicate acceptAnswer throws OFFER_ALREADY_ANSWERED', async () => {
    const room = new P2PRoom(true, 'http://localhost');
    const p = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'x' });
    const { offerId } = await p;

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' }));
    room.acceptAnswer(offerId, '#sdp=' + b64);
    expect(() => room.acceptAnswer(offerId, '#sdp=' + b64)).toThrow('OFFER_ALREADY_ANSWERED');
  });

  it('unknown offerId triggers onError', () => {
    const errors: Error[] = [];
    const room = new P2PRoom(true, '', { onError: (e) => errors.push(e) });
    room.acceptAnswer('nope', '#sdp=' + btoa('{}'));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('No pending offer');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. onOfferAnswered
// ═══════════════════════════════════════════════════════════

describe('onOfferAnswered', () => {
  it('fires when acceptAnswer is called', async () => {
    const calls: string[] = [];
    const room = new P2PRoom(true, 'http://localhost', {
      onOfferAnswered: (id) => calls.push(id),
    });
    const p = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'x' });
    const { offerId } = await p;

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' }));
    room.acceptAnswer(offerId, '#sdp=' + b64);
    expect(calls).toEqual([offerId]);
  });

  it('fires before onPeerJoin', async () => {
    const order: string[] = [];
    const room = new P2PRoom(true, 'http://localhost', {
      onOfferAnswered: () => order.push('answered'),
    });
    room.onPeerJoin(() => order.push('join'));

    const p = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'x' });
    const { offerId } = await p;

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' }));
    room.acceptAnswer(offerId, '#sdp=' + b64);

    // onOfferAnswered fires synchronously inside acceptAnswer.
    // onPeerJoin fires later when peer connects.
    expect(order).toEqual(['answered']);

    // Simulate peer connection
    mockPeers[0]._events.get('connect')?.();
    await Promise.resolve(); // flush await in _onPeerConnected

    expect(order).toEqual(['answered', 'join']);
  });

  it('fires only once per offer', async () => {
    const calls: string[] = [];
    const room = new P2PRoom(true, 'http://localhost', {
      onOfferAnswered: (id) => calls.push(id),
    });
    const p = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'x' });
    const { offerId } = await p;

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' }));
    room.acceptAnswer(offerId, '#sdp=' + b64);
    expect(() => room.acceptAnswer(offerId, '#sdp=' + b64)).toThrow('OFFER_ALREADY_ANSWERED');
    expect(calls).toEqual([offerId]);
  });

  it('handler via onOfferAnswered() method', async () => {
    const calls: string[] = [];
    const room = new P2PRoom(true, 'http://localhost');
    room.onOfferAnswered((id) => calls.push(id));

    const p = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'x' });
    const { offerId } = await p;

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' }));
    room.acceptAnswer(offerId, '#sdp=' + b64);
    expect(calls).toEqual([offerId]);
  });

  it('fires per-offer, not globally', async () => {
    const calls: string[] = [];
    const room = new P2PRoom(true, 'http://localhost', {
      onOfferAnswered: (id) => calls.push(id),
    });

    const p1 = room.offerUrl();
    const p2 = room.offerUrl();
    emitSignal(0, { type: 'offer', sdp: 'a' });
    emitSignal(1, { type: 'offer', sdp: 'b' });
    const [o1, o2] = await Promise.all([p1, p2]);

    const b64 = btoa(JSON.stringify({ type: 'answer', sdp: 'x' }));
    room.acceptAnswer(o1.offerId, '#sdp=' + b64);
    expect(calls).toEqual([o1.offerId]);

    room.acceptAnswer(o2.offerId, '#sdp=' + b64);
    expect(calls).toEqual([o1.offerId, o2.offerId]);
  });
});