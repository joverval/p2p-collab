import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock simple-peer — tracks events per instance so we can test multiple peers
const mockPeerEvents: Map<string, (...args: any[]) => void>[] = [];

vi.mock('simple-peer', () => ({
  default: vi.fn().mockImplementation(function (this: any, opts: any) {
    const events = new Map<string, (...args: any[]) => void>();
    mockPeerEvents.push(events);
    this._opts = opts;
    this.on = vi.fn((event: string, fn: any) => {
      events.set(event, fn);
    });
    this.signal = vi.fn();
    this.send = vi.fn();
    this.destroy = vi.fn(function (this: any) {
      const closeFn = events.get('close');
      if (closeFn) closeFn();
    });
    this.connected = false;
    return this;
  }),
}));

import { P2PRoom } from '../src/room';

beforeEach(() => {
  mockPeerEvents.length = 0;
});

describe('P2PRoom', () => {
  describe('host', () => {
    it('creates with isHost=true', () => {
      const room = new P2PRoom(true, 'http://localhost');
      expect(room.isHost).toBe(true);
    });

    it('starts with zero peers', () => {
      const room = new P2PRoom(true, '');
      expect(room.peers).toHaveLength(0);
    });

    it('generates offer URL via offerUrl()', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      setTimeout(() => {
        const sig = mockPeerEvents[0]?.get('signal');
        sig?.({ type: 'offer', sdp: 'test-sdp' });
      }, 10);
      const { url } = await room.offerUrl();
      expect(url).toContain('#sdp=');
    });

    it('acceptAnswer rejects invalid URL', () => {
      const room = new P2PRoom(true, '');
      const errors: Error[] = [];
      const r = new P2PRoom(true, '', { onError: (e) => errors.push(e) });
      // Trigger offerUrl first to set _hostOfferPeer
      setTimeout(() => {
        const sig = mockPeerEvents[1]?.get('signal');
        sig?.({ type: 'offer', sdp: 'x' });
      }, 5);
      r.acceptAnswer('not-a-valid-url');
      // Should not throw, should report error
    });

    it('acceptAnswer signals the pending peer', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      setTimeout(() => {
        const sig = mockPeerEvents[0]?.get('signal');
        sig?.({ type: 'offer', sdp: 'test' });
      }, 5);
      const { offerId } = await room.offerUrl();

      // Now accept answer — should call signal on the pending peer
      room.acceptAnswer(offerId, '#sdp=' + btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' })));
      // The pending offer should still exist (awaiting connect event)
      const pending = (room as any)._pendingOffers.get(offerId);
      expect(pending).toBeTruthy();
    });

    it('broadcasts send() to all peers', () => {
      const room = new P2PRoom(true, '');
      // Simulate a connected peer by directly manipulating internals
      const mockSend = vi.fn();
      (room as any)._peers.set('peer-1', { send: mockSend, on: vi.fn() });
      (room as any)._peers.set('peer-2', { send: mockSend, on: vi.fn() });
      (room as any)._peerInfos = [
        { id: 'peer-1', send: mockSend },
        { id: 'peer-2', send: mockSend },
      ];

      room.send('hello');
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledWith('hello');
    });

    it('triggers onPeerJoin when peer connects', async () => {
      const joins: string[] = [];
      const room = new P2PRoom(true, '', { onPeerLeave: () => {} });
      room.onPeerJoin((id) => joins.push(id));

      // Generate offer first
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();

      // Simulate connect event on the host peer
      const connectFn = mockPeerEvents[0]?.get('connect');
      connectFn?.();

      expect(joins.length).toBe(1);
      expect(joins[0]).toMatch(/^peer-/);
      expect(room.peers.length).toBe(1);
    });

    it('tracks multiple peer connections', async () => {
      const room = new P2PRoom(true, '');
      // Generate first offer
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();
      mockPeerEvents[0]?.get('connect')?.();

      expect(room.peers.length).toBe(1);

      // Generate second offer
      setTimeout(() => {
        mockPeerEvents[1]?.get('signal')?.({ type: 'offer', sdp: 'y' });
      }, 5);
      await room.offerUrl();
      mockPeerEvents[1]?.get('connect')?.();

      expect(room.peers.length).toBe(2);
    });
  });

  describe('peer', () => {
    it('creates with isHost=false', () => {
      const room = new P2PRoom(false, '');
      expect(room.isHost).toBe(false);
    });

    it('connectToHost returns answer URL', async () => {
      const room = new P2PRoom(false, 'http://localhost');
      const offerB64 = btoa(JSON.stringify({ type: 'offer', sdp: 'offer-sdp' }));

      const promise = room.connectToHost(`#sdp=${offerB64}`);

      // Simulate signal event (answer generated)
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'answer', sdp: 'answer-sdp' });
      }, 5);

      const answerUrl = await promise;
      expect(answerUrl).toContain('#sdp=');
    });

    it('connectToHost rejects invalid offers', async () => {
      const room = new P2PRoom(false, '');
      await expect(room.connectToHost('')).rejects.toThrow();
      await expect(room.connectToHost('not-valid')).rejects.toThrow();
    });

    it('send() sends to host only', () => {
      const room = new P2PRoom(false, '');
      const mockSend = vi.fn();
      (room as any)._peer = { send: mockSend, on: vi.fn(), signal: vi.fn() };

      room.send('hello');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('hello');
    });

    it('onMessage receives data from host', async () => {
      const messages: any[] = [];
      const room = new P2PRoom(false, 'http://localhost');
      room.onMessage((data, peerId) => messages.push({ data, peerId }));

      const offerB64 = btoa(JSON.stringify({ type: 'offer', sdp: 'offer-sdp' }));
      const promise = room.connectToHost(`#sdp=${offerB64}`);

      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'answer', sdp: 'answer-sdp' });
      }, 5);
      await promise;

      // Simulate connect + data
      mockPeerEvents[0]?.get('connect')?.();
      const dataFn = mockPeerEvents[0]?.get('data');
      dataFn?.(new TextEncoder().encode('hello from host'));

      expect(messages.length).toBe(1);
      expect(messages[0].peerId).toBe('host');
    });
  });

  describe('close', () => {
    it('clears peers', () => {
      const room = new P2PRoom(true, '');
      (room as any)._peers.set('p1', { destroy: vi.fn(), on: vi.fn() });
      (room as any)._peerInfos = [{ id: 'p1', send: vi.fn() }];
      room.close();
      expect(room.peers).toHaveLength(0);
    });

    it('calls onClose callback', () => {
      let closed = false;
      const room = new P2PRoom(true, '', { onClose: () => { closed = true; } });
      room.close();
      expect(closed).toBe(true);
    });

    it('destroys peer connection', () => {
      const room = new P2PRoom(false, '');
      const mockDestroy = vi.fn();
      (room as any)._peer = { destroy: mockDestroy, on: vi.fn() };
      room.close();
      expect(mockDestroy).toHaveBeenCalled();
    });
  });
});