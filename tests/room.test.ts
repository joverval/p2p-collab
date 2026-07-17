import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock simple-peer
const mockPeerEvents: Map<string, (...args: any[]) => void> = new Map();

vi.mock('simple-peer', () => ({
  default: vi.fn().mockImplementation(function (this: any, opts: any) {
    this._opts = opts;
    this.on = vi.fn((event: string, fn: any) => {
      mockPeerEvents.set(event, fn);
    });
    this.signal = vi.fn();
    this.send = vi.fn();
    this.destroy = vi.fn(function (this: any) {
      const closeFn = mockPeerEvents.get('close');
      if (closeFn) closeFn();
    });
    this.connected = false;
    return this;
  }),
}));

import { P2PRoom } from '../src/room';

describe('P2PRoom', () => {
  beforeEach(() => {
    mockPeerEvents.clear();
  });

  describe('host', () => {
    it('creates with isHost=true', () => {
      const room = new P2PRoom(true, 'http://localhost');
      expect(room.isHost).toBe(true);
    });

    it('generates offer URL via offerUrl()', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      // Simulate signal event after a tick
      setTimeout(() => {
        const signalFn = mockPeerEvents.get('signal');
        signalFn?.({ type: 'offer', sdp: 'test-sdp' });
      }, 10);
      const url = await room.offerUrl();
      expect(url).toContain('#sdp=');
    });

    it('starts with zero peers', () => {
      const room = new P2PRoom(true, '');
      expect(room.peers).toHaveLength(0);
    });
  });

  describe('peer', () => {
    it('creates with isHost=false', () => {
      const room = new P2PRoom(false, '');
      expect(room.isHost).toBe(false);
    });
  });

  describe('close', () => {
    it('clears peers', () => {
      const room = new P2PRoom(true, '');
      room.close();
      expect(room.peers).toHaveLength(0);
    });
  });
});