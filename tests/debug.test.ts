import { describe, it, expect, vi } from 'vitest';

const mockPeerEvents: any[] = [];
vi.mock('simple-peer', () => ({
  default: vi.fn().mockImplementation(function (this: any, opts: any) {
    const events = new Map();
    mockPeerEvents.push(events);
    this._opts = opts;
    this._pc = { connectionState: 'connected', iceConnectionState: 'connected', getStats: vi.fn().mockResolvedValue(new Map()) };
    this._channel = { bufferedAmount: 0 };
    this.on = vi.fn((event: string, fn: any) => { events.set(event, fn); });
    this.signal = vi.fn();
    this.send = vi.fn();
    this.write = vi.fn().mockReturnValue(true);
    this.bufferSize = 0;
    this.removeAllListeners = vi.fn();
    this.destroy = vi.fn(function(this: any) { const closeFn = events.get('close'); if (closeFn) closeFn(); });
    this.connected = false;
    return this;
  }),
}));

import { P2PRoom } from '../src/room';

describe('debug fields', () => {
  it('check _offers after construction', () => {
    const room = new P2PRoom(true, 'http://localhost');
    const offers = (room as any)._offers;
    console.log('_offers:', offers);
    console.log('typeof:', typeof offers);
    console.log('is Map:', offers instanceof Map);
    console.log('_peers:', (room as any)._peers);
    console.log('_sendStates:', (room as any)._sendStates);
    expect(offers).toBeDefined();
    expect(offers instanceof Map).toBe(true);
  });

  it('check offerUrl works', async () => {
    const room = new P2PRoom(true, 'http://localhost');
    setTimeout(() => {
      mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'test' });
    }, 5);
    const result = await room.offerUrl();
    console.log('offer result:', result);
    expect(result.url).toContain('#sdp=');
  });
});