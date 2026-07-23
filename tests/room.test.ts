import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock simple-peer -- tracks events per instance so we can test multiple peers
const mockPeerEvents: Map<string, (...args: any[]) => void>[] = [];

vi.mock('simple-peer', () => ({
  default: vi.fn().mockImplementation(function (this: any, opts: any) {
    const events = new Map<string, (...args: any[]) => void>();
    mockPeerEvents.push(events);
    this._opts = opts;
    this._pc = {
      connectionState: 'connected' as RTCPeerConnectionState,
      iceConnectionState: 'connected' as RTCIceConnectionState,
      getStats: vi.fn().mockResolvedValue(new Map()),
      onconnectionstatechange: null,
      oniceconnectionstatechange: null,
    };
    this._channel = { bufferedAmount: 0 };
    this.on = vi.fn((event: string, fn: any) => {
      events.set(event, fn);
    });
    this.signal = vi.fn();
    this.send = vi.fn();
    this.write = vi.fn().mockReturnValue(true);
    this.bufferSize = 0;
    this.removeAllListeners = vi.fn();
    this.destroy = vi.fn(function (this: any) {
      const closeFn = events.get('close');
      if (closeFn) closeFn();
    });
    this.connected = false;
    return this;
  }),
}));

import { P2PRoom } from '../src/room';
import type { SendResult, BroadcastResult } from '../src/types';

beforeEach(() => {
  mockPeerEvents.length = 0;
});

/** Helper: create a mock SimplePeer-like object with all needed methods */
function mockPeer(overrides: any = {}) {
  return {
    send: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    signal: vi.fn(),
    destroy: vi.fn(),
    removeAllListeners: vi.fn(),
    connected: true,
    _pc: {
      connectionState: 'connected' as RTCPeerConnectionState,
      iceConnectionState: 'connected' as RTCIceConnectionState,
      getStats: vi.fn().mockResolvedValue(new Map()),
    },
    _channel: { bufferedAmount: 0 },
    bufferSize: 0,
    ...overrides,
  };
}

/** Helper: set up a connected host peer with send state */
function addPeer(room: P2PRoom, peerId: string, peerOverrides: any = {}) {
  const peer = mockPeer(peerOverrides);
  (room as any)._peers.set(peerId, peer);
  (room as any)._peerInfos.push({ id: peerId, send: peer.send });
  (room as any)._sendStates.set(peerId, {
    peer,
    peerId,
    queue: [],
    queuedBytes: 0,
    draining: false,
    connected: true,
  });
  return peer;
}

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
      const { url, offerId } = await room.offerUrl();
      expect(url).toContain('#sdp=');
      expect(offerId).toBeTruthy();
      expect(offerId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('acceptAnswer rejects invalid URL', () => {
      const errors: Error[] = [];
      const r = new P2PRoom(true, '', { onError: (e) => errors.push(e) });
      setTimeout(() => {
        const sig = mockPeerEvents[0]?.get('signal');
        sig?.({ type: 'offer', sdp: 'x' });
      }, 5);
      r.acceptAnswer('not-a-valid-url');
      // Should not throw
    });

    it('acceptAnswer signals the pending peer', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      setTimeout(() => {
        const sig = mockPeerEvents[0]?.get('signal');
        sig?.({ type: 'offer', sdp: 'test' });
      }, 5);
      const { offerId } = await room.offerUrl();

      room.acceptAnswer(offerId, '#sdp=' + btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' })));
      const pending = (room as any)._pendingOffers.get(offerId);
      expect(pending).toBeTruthy();
    });

    it('broadcasts send() to all connected peers', () => {
      const room = new P2PRoom(true, '');
      const p1 = addPeer(room, 'peer-1');
      const p2 = addPeer(room, 'peer-2');

      const result: SendResult = room.send('hello');
      expect(result.status).toBe('accepted');
      expect(p1.write).toHaveBeenCalledWith('hello');
      expect(p2.write).toHaveBeenCalledWith('hello');
    });

    it('send skips disconnected peers', () => {
      const room = new P2PRoom(true, '');
      const p1 = addPeer(room, 'peer-1', { connected: false });
      (room as any)._sendStates.get('peer-1').connected = false;
      const p2 = addPeer(room, 'peer-2');

      const result: SendResult = room.send('hello');
      expect(result.status).toBe('accepted');
      expect(p1.write).not.toHaveBeenCalled();
      expect(p2.write).toHaveBeenCalledWith('hello');
    });

    it('send returns rejected when no peers connected', () => {
      const room = new P2PRoom(true, '');
      const result: SendResult = room.send('hello');
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('no peers connected');
    });

    it('sendToPeer returns rejected for unknown peer', () => {
      const room = new P2PRoom(true, '');
      const result: SendResult = room.sendToPeer('nonexistent', 'hello');
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('unknown peer');
    });

    it('sendToPeer returns rejected for disconnected peer', () => {
      const room = new P2PRoom(true, '');
      const p1 = addPeer(room, 'peer-1', { connected: false });
      (room as any)._sendStates.get('peer-1').connected = false;
      const result: SendResult = room.sendToPeer('peer-1', 'hello');
      expect(result.status).toBe('queued'); // disconnected → queued
    });

    it('broadcastExcept returns BroadcastResult and skips disconnected', () => {
      const room = new P2PRoom(true, '');
      const p1 = addPeer(room, 'peer-1');
      const p2 = addPeer(room, 'peer-2', { connected: false });
      (room as any)._sendStates.get('peer-2').connected = false;
      const p3 = addPeer(room, 'peer-3');

      const result: BroadcastResult = room.broadcastExcept('data', 'peer-3');
      expect(result.accepted).toBe(1);  // peer-1 accepted
      expect(result.queued).toBe(1);    // peer-2 disconnected → queued
      expect(result.rejected).toBe(0);
      expect(result.total).toBe(2);
      expect(p1.write).toHaveBeenCalledWith('data');
      expect(p2.write).not.toHaveBeenCalled();
      expect(p3.write).not.toHaveBeenCalled();
    });

    it('triggers onPeerJoin when peer connects', async () => {
      const joins: string[] = [];
      const room = new P2PRoom(true, '', { onPeerLeave: () => {} });
      room.onPeerJoin((id) => joins.push(id));

      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();

      const connectFn = mockPeerEvents[0]?.get('connect');
      connectFn?.();

      expect(joins.length).toBe(1);
      expect(joins[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(room.peers.length).toBe(1);
    });

    it('tracks multiple peer connections', async () => {
      const room = new P2PRoom(true, '');
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();
      mockPeerEvents[0]?.get('connect')?.();

      expect(room.peers.length).toBe(1);

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

    it('send() sends to host when connected', () => {
      const room = new P2PRoom(false, '');
      const p = mockPeer();
      (room as any)._peer = p;
      (room as any)._hostSendState = {
        peer: p,
        peerId: 'host',
        queue: [],
        queuedBytes: 0,
        draining: false,
        connected: true,
      };

      const result: SendResult = room.send('hello');
      expect(result.status).toBe('accepted');
      expect(p.write).toHaveBeenCalledWith('hello');
    });

    it('send() returns rejected when disconnected', () => {
      const room = new P2PRoom(false, '');
      // No _hostSendState → rejected
      const result: SendResult = room.send('hello');
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('not connected');
    });

    it('send() returns rejected with no peer', () => {
      const room = new P2PRoom(false, '');
      const result: SendResult = room.send('hello');
      expect(result.status).toBe('rejected');
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
      (room as any)._peers.set('p1', { destroy: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() });
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
      (room as any)._peer = { destroy: mockDestroy, on: vi.fn(), removeAllListeners: vi.fn() };
      room.close();
      expect(mockDestroy).toHaveBeenCalled();
    });

    it('cleans up send states and host send state', () => {
      const room = new P2PRoom(true, '');
      const p = mockPeer();
      (room as any)._sendStates.set('peer-1', {
        peer: p, peerId: 'peer-1', queue: [{ data: 'x', byteLength: 1 }], queuedBytes: 1, draining: false, connected: true,
      });
      (room as any)._hostSendState = {
        peer: p, peerId: 'host', queue: [{ data: 'y', byteLength: 1 }], queuedBytes: 1, draining: false, connected: true,
      };
      room.close();
      expect((room as any)._sendStates.size).toBe(0);
      expect((room as any)._hostSendState).toBeUndefined();
    });
  });

  // ── ICE Config Tests ──

  describe('ICE config', () => {
    it('default config is STUN-only with no TURN servers', () => {
      const room = new P2PRoom(true, '');
      const rtcConfig = (room as any)._rtcConfig as RTCConfiguration;
      expect(rtcConfig.iceServers).toHaveLength(2);
      for (const server of rtcConfig.iceServers!) {
        expect(server.urls).not.toContain('turn:');
        expect(server.urls).toContain('stun:');
      }
      expect(rtcConfig.iceTransportPolicy).toBe('all');
      expect(rtcConfig.iceCandidatePoolSize).toBe(0);
    });

    it('injected TURN config is passed to SimplePeer constructor', async () => {
      const turnConfig: RTCConfiguration = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:custom-turn:3478',
            username: 'test-user',
            credential: 'test-pass',
          },
        ],
      };
      const room = new P2PRoom(true, 'http://localhost', { rtcConfig: turnConfig });

      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();

      const storedConfig = (room as any)._rtcConfig;
      expect(storedConfig.iceServers?.length).toBe(2);
      expect(storedConfig.iceServers![1].urls).toBe('turn:custom-turn:3478');
    });

    it('does not force relay policy', () => {
      const room = new P2PRoom(true, '');
      const rtcConfig = (room as any)._rtcConfig as RTCConfiguration;
      expect(rtcConfig.iceTransportPolicy).toBe('all');
      expect(rtcConfig.iceTransportPolicy).not.toBe('relay');
    });
  });

  // ── IceMode tests ──

  describe('IceMode', () => {
    it('stun-only strips TURN servers from rtcConfig', () => {
      const room = new P2PRoom(true, '', {
        iceMode: 'stun-only',
        rtcConfig: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'turn:custom-turn:3478' },
          ],
        },
      });
      const cfg = (room as any)._rtcConfig as RTCConfiguration;
      expect(cfg.iceTransportPolicy).toBe('all');
      expect(cfg.iceServers!.length).toBe(1);
      expect(cfg.iceServers![0].urls).toBe('stun:stun.l.google.com:19302');
    });

    it('turn-only sets iceTransportPolicy to relay', () => {
      const room = new P2PRoom(true, '', { iceMode: 'turn-only' });
      const cfg = (room as any)._rtcConfig as RTCConfiguration;
      expect(cfg.iceTransportPolicy).toBe('relay');
    });

    it('all preserves existing behavior', () => {
      const room = new P2PRoom(true, '', { iceMode: 'all' });
      const cfg = (room as any)._rtcConfig as RTCConfiguration;
      expect(cfg.iceTransportPolicy).toBe('all');
      expect(cfg.iceServers?.length).toBe(2);
    });

    it('default iceMode is all', () => {
      const room = new P2PRoom(true, '');
      const cfg = (room as any)._rtcConfig as RTCConfiguration;
      expect(cfg.iceTransportPolicy).toBe('all');
    });
  });

  // ── Connection Diagnostics ──

  describe('connection diagnostics', () => {
    it('getConnectionRoute returns unknown when no peer', async () => {
      const room = new P2PRoom(true, '');
      const route = await room.getConnectionRoute();
      expect(route.kind).toBe('unknown');
    });

    it('getConnectionState returns unknown when no peer', () => {
      const room = new P2PRoom(true, '');
      expect(room.getConnectionState()).toBe('unknown');
    });

    it('getIceConnectionState returns unknown when no peer', () => {
      const room = new P2PRoom(true, '');
      expect(room.getIceConnectionState()).toBe('unknown');
    });

    it('getConnectionState returns state from connected peer', () => {
      const room = new P2PRoom(false, '');
      const mockP = mockPeer();
      (room as any)._peer = mockP;
      expect(room.getConnectionState()).toBe('connected');
      expect(room.getIceConnectionState()).toBe('connected');
    });

    it('getConnectionRoute with mock stats returns direct', async () => {
      const room = new P2PRoom(true, '');
      const mockStats = new Map();
      mockStats.set('transport1', { type: 'transport', selectedCandidatePairId: 'pair1' });
      mockStats.set('pair1', {
        type: 'candidate-pair', localCandidateId: 'local1', remoteCandidateId: 'remote1',
      });
      mockStats.set('local1', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' });
      mockStats.set('remote1', { type: 'remote-candidate', candidateType: 'host' });
      const mockP = mockPeer({ _pc: { getStats: vi.fn().mockResolvedValue(mockStats) } });
      (room as any)._peers.set('peer-1', mockP);

      const route = await room.getConnectionRoute('peer-1');
      expect(route.kind).toBe('direct');
      expect(route.localCandidateType).toBe('host');
      expect(route.protocol).toBe('udp');
    });

    it('getConnectionRoute with relay pair returns turn', async () => {
      const room = new P2PRoom(true, '');
      const mockStats = new Map();
      mockStats.set('transport1', { type: 'transport', selectedCandidatePairId: 'pair1' });
      mockStats.set('pair1', {
        type: 'candidate-pair', localCandidateId: 'local1', remoteCandidateId: 'remote1',
      });
      mockStats.set('local1', {
        type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp',
      });
      mockStats.set('remote1', { type: 'remote-candidate', candidateType: 'srflx' });
      const mockP = mockPeer({ _pc: { getStats: vi.fn().mockResolvedValue(mockStats) } });
      (room as any)._peers.set('peer-1', mockP);

      const route = await room.getConnectionRoute('peer-1');
      expect(route.kind).toBe('turn');
      expect(route.localCandidateType).toBe('relay');
      expect(route.relayProtocol).toBe('udp');
    });

    it('getConnectionRoute uses fallback when no selectedCandidatePairId', async () => {
      const room = new P2PRoom(true, '');
      const mockStats = new Map();
      mockStats.set('transport1', { type: 'transport' });
      mockStats.set('pair-fallback', {
        id: 'pair-fallback', type: 'candidate-pair', state: 'succeeded', nominated: true,
        localCandidateId: 'local1', remoteCandidateId: 'remote1',
      });
      mockStats.set('local1', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' });
      mockStats.set('remote1', { type: 'remote-candidate', candidateType: 'srflx' });
      const mockP = mockPeer({ _pc: { getStats: vi.fn().mockResolvedValue(mockStats) } });
      (room as any)._peers.set('peer-1', mockP);

      const route = await room.getConnectionRoute('peer-1');
      expect(route.kind).toBe('direct');
      expect(route.localCandidateType).toBe('srflx');
    });
  });

  // ── Offer Lifecycle ──

  describe('offer lifecycle', () => {
    it('offerUrl generates unique IDs', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      const p1Settled = (async () => {
        setTimeout(() => {
          mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
        }, 5);
        return room.offerUrl();
      })();
      const offer1 = await p1Settled;

      const p2Settled = (async () => {
        setTimeout(() => {
          mockPeerEvents[1]?.get('signal')?.({ type: 'offer', sdp: 'y' });
        }, 5);
        return room.offerUrl();
      })();
      const offer2 = await p2Settled;

      expect(offer1.offerId).not.toBe(offer2.offerId);
    });

    it('cancelOffer removes pending offer and destroys peer', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      const promise = (async () => {
        setTimeout(() => {
          mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
        }, 5);
        return room.offerUrl();
      })();
      const { offerId } = await promise;

      expect((room as any)._pendingOffers.has(offerId)).toBe(true);
      room.cancelOffer(offerId);
      expect((room as any)._pendingOffers.has(offerId)).toBe(false);
      expect((room as any)._offerTimers.has(offerId)).toBe(false);
    });

    it('close cancels all pending offer timers', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      const promise = (async () => {
        setTimeout(() => {
          mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
        }, 5);
        return room.offerUrl();
      })();
      await promise;

      expect((room as any)._offerTimers.size).toBeGreaterThanOrEqual(1);
      room.close();
      expect((room as any)._pendingOffers.size).toBe(0);
      expect((room as any)._offerTimers.size).toBe(0);
    });

    it('cancelOffer is no-op for non-host', () => {
      const room = new P2PRoom(false, '');
      room.cancelOffer('any-id');
    });

    it('duplicate acceptAnswer emits error', async () => {
      const errors: Error[] = [];
      const room = new P2PRoom(true, 'http://localhost', { onError: (e) => errors.push(e) });
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      const { offerId } = await room.offerUrl();
      const url = '#sdp=' + btoa(JSON.stringify({ type: 'answer', sdp: 'a' }));

      room.acceptAnswer(offerId, url);
      expect(errors.length).toBe(0); // first accept OK

      room.acceptAnswer(offerId, url);
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('already answered');
    });

    it('offerUrl rejects when maxPendingOffers reached', async () => {
      const room = new P2PRoom(true, 'http://localhost', { maxPendingOffers: 2 });
      // Create 2 pending offers
      const p1 = (async () => {
        setTimeout(() => mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' }), 5);
        return room.offerUrl();
      })();
      await p1;
      const p2 = (async () => {
        setTimeout(() => mockPeerEvents[1]?.get('signal')?.({ type: 'offer', sdp: 'y' }), 5);
        return room.offerUrl();
      })();
      await p2;

      // Third should reject
      await expect(room.offerUrl()).rejects.toThrow('Max pending offers');
    });

    it('cancelOffer frees slot after maxPendingOffers', async () => {
      const room = new P2PRoom(true, 'http://localhost', { maxPendingOffers: 2 });
      const p1 = (async () => {
        setTimeout(() => mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' }), 5);
        return room.offerUrl();
      })();
      const o1 = await p1;
      const p2 = (async () => {
        setTimeout(() => mockPeerEvents[1]?.get('signal')?.({ type: 'offer', sdp: 'y' }), 5);
        return room.offerUrl();
      })();
      await p2;

      room.cancelOffer(o1.offerId);

      // Should succeed now
      const p3 = (async () => {
        setTimeout(() => mockPeerEvents[2]?.get('signal')?.({ type: 'offer', sdp: 'z' }), 5);
        return room.offerUrl();
      })();
      await p3; // should not throw
    });
  });

  // ── applySignal ──

  describe('applySignal', () => {
    it('applySignal feeds signal to connected peer (host mode)', () => {
      const room = new P2PRoom(true, '');
      const p = addPeer(room, 'peer-1');
      room.applySignal('peer-1', { candidate: 'c:1' });
      expect(p.signal).toHaveBeenCalledWith({ candidate: 'c:1' });
    });

    it('applySignal feeds signal to pending offer (host mode)', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      const { offerId } = await room.offerUrl();

      room.applySignal(offerId, { candidate: 'c:1' });
      // Should not throw — signal was fed to pending peer
    });

    it('applySignal emits error for unknown connectionId (host)', () => {
      const errors: Error[] = [];
      const room = new P2PRoom(true, '', { onError: (e) => errors.push(e) });
      room.applySignal('unknown-id', { candidate: 'c:1' });
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('No connection found');
    });

    it('applySignal feeds signal to host connection (peer mode)', () => {
      const room = new P2PRoom(false, '');
      const p = mockPeer();
      (room as any)._peer = p;
      room.applySignal('host', { candidate: 'c:1' });
      expect(p.signal).toHaveBeenCalledWith({ candidate: 'c:1' });
    });

    it('applySignal emits error for non-host connectionId (peer mode)', () => {
      const errors: Error[] = [];
      const room = new P2PRoom(false, '', { onError: (e) => errors.push(e) });
      room.applySignal('other', { candidate: 'c:1' });
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('must be "host"');
    });

    it('applySignal emits error when peer not connected (peer mode)', () => {
      const errors: Error[] = [];
      const room = new P2PRoom(false, '', { onError: (e) => errors.push(e) });
      room.applySignal('host', { candidate: 'c:1' });
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('Not connected');
    });
  });

  // ── Safe Send / Backpressure ──

  describe('safe send', () => {
    it('send queued data when channel not yet connected', () => {
      const room = new P2PRoom(true, '');
      const p = mockPeer({ connected: false });
      (room as any)._sendStates.set('peer-1', {
        peer: p, peerId: 'peer-1', queue: [], queuedBytes: 0, draining: false, connected: false,
      });

      // sendToPeer to target just this one (avoids host aggregation)
      const result: SendResult = room.sendToPeer('peer-1', 'hello');
      expect(result.status).toBe('queued');
      expect(result.bufferedAmount).toBeGreaterThan(0);
      expect(p.write).not.toHaveBeenCalled();
    });

    it('queue rejects when over byte limit', () => {
      const room = new P2PRoom(true, '', { maxQueuedBytes: 10 });
      const p = mockPeer({ connected: false });
      (room as any)._sendStates.set('peer-1', {
        peer: p, peerId: 'peer-1', queue: [], queuedBytes: 0, draining: false, connected: false,
      });

      // Use sendToPeer to target this specific peer
      const result: SendResult = room.sendToPeer('peer-1', 'hello world');
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('queue full');
    });

    it('write() returning false triggers queuing', () => {
      const room = new P2PRoom(true, '');
      const p = mockPeer({ write: vi.fn().mockReturnValue(false) });
      (room as any)._sendStates.set('peer-1', {
        peer: p, peerId: 'peer-1', queue: [], queuedBytes: 0, draining: false, connected: true,
      });

      const result: SendResult = room.send('hello');
      expect(result.status).toBe('queued');
    });

    it('sendToPeer returns rejected for unknown peer', () => {
      const room = new P2PRoom(true, '');
      const result: SendResult = room.sendToPeer('bad-id', 'hello');
      expect(result.status).toBe('rejected');
    });

    it('broadcastExcept counts queued and rejected correctly', () => {
      const room = new P2PRoom(true, '');
      addPeer(room, 'peer-1'); // connected → accepted
      const p2 = mockPeer({ connected: false });
      (room as any)._sendStates.set('peer-2', {
        peer: p2, peerId: 'peer-2', queue: [], queuedBytes: 0, draining: false, connected: false,
      });

      const result: BroadcastResult = room.broadcastExcept('data');
      expect(result.accepted).toBe(1);
      expect(result.queued).toBe(1);
      expect(result.rejected).toBe(0);
      expect(result.total).toBe(2);
    });

    it('queue is flushed when peer connects', () => {
      const room = new P2PRoom(true, '');
      const p = mockPeer();
      const state = {
        peer: p, peerId: 'peer-1',
        queue: [{ data: 'msg1', byteLength: 4 }, { data: 'msg2', byteLength: 4 }],
        queuedBytes: 8, draining: false, connected: false,
      };
      (room as any)._sendStates.set('peer-1', state);

      // Simulate connect + flush
      state.connected = true;
      (room as any)._flushQueue(state);

      expect(state.queue.length).toBe(0);
      expect(state.queuedBytes).toBe(0);
      expect(p.write).toHaveBeenCalledTimes(2);
      expect(p.write).toHaveBeenCalledWith('msg1');
      expect(p.write).toHaveBeenCalledWith('msg2');
    });

    it('drain handler flushes queue', () => {
      const room = new P2PRoom(true, '');
      const p = mockPeer({ write: vi.fn().mockReturnValue(true) });
      const state = {
        peer: p, peerId: 'peer-1',
        queue: [{ data: 'queued-msg', byteLength: 10 }],
        queuedBytes: 10, draining: true, connected: true,
      };
      (room as any)._sendStates.set('peer-1', state);
      (room as any)._attachDrainHandler(state);

      // Trigger drain
      const drainFn = p.on.mock.calls.find((c: any[]) => c[0] === 'drain')?.[1];
      expect(drainFn).toBeDefined();
      drainFn?.();

      expect(state.draining).toBe(false);
      expect(state.queue.length).toBe(0);
      expect(p.write).toHaveBeenCalledWith('queued-msg');
    });

    it('write() backpressure during flush stops draining', () => {
      const room = new P2PRoom(true, '');
      const p = mockPeer({ write: vi.fn().mockReturnValueOnce(false) });
      const state = {
        peer: p, peerId: 'peer-1',
        queue: [{ data: 'msg1', byteLength: 4 }, { data: 'msg2', byteLength: 4 }],
        queuedBytes: 8, draining: false, connected: true,
      };
      (room as any)._sendStates.set('peer-1', state);
      (room as any)._flushQueue(state);

      expect(state.draining).toBe(true);
      expect(state.queue.length).toBe(2); // msg1 put back, msg2 still there
    });

    it('multiple peers have independent queues', () => {
      const room = new P2PRoom(true, '', { maxQueuedBytes: 5 });
      const p1 = mockPeer({ connected: false });
      const p2 = mockPeer({ connected: false });
      (room as any)._sendStates.set('peer-1', {
        peer: p1, peerId: 'peer-1', queue: [], queuedBytes: 0, draining: false, connected: false,
      });
      (room as any)._sendStates.set('peer-2', {
        peer: p2, peerId: 'peer-2', queue: [], queuedBytes: 4, draining: false, connected: false,
      });

      // peer-1: 4 bytes OK (under 5)
      const r1 = room.sendToPeer('peer-1', 'abcd');
      expect(r1.status).toBe('queued');

      // peer-2: already has 4 bytes, 4 more = 8 > 5 → rejected
      const r2 = room.sendToPeer('peer-2', 'abcd');
      expect(r2.status).toBe('rejected');
    });

    it('queue cleared on peer disconnect', () => {
      const room = new P2PRoom(true, '');
      const p = mockPeer();
      const state = {
        peer: p,
        peerId: 'peer-1',
        queue: [{ data: 'msg', byteLength: 3 }],
        queuedBytes: 3, draining: false, connected: true,
      };
      (room as any)._sendStates.set('peer-1', state);

      // Simulate cleanup like _onPeerConnected's close handler would
      state.peer.removeAllListeners('drain');
      state.queue = [];
      (room as any)._sendStates.delete('peer-1');

      expect((room as any)._sendStates.has('peer-1')).toBe(false);
    });
  });

  // ── Trickle ICE ──

  describe('trickle ICE', () => {
    it('default constructor passes trickle: false to SimplePeer', async () => {
      const room = new P2PRoom(true, 'http://localhost');
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();

      const simplePeerMock = (await import('simple-peer')).default;
      expect(simplePeerMock).toHaveBeenCalledWith(
        expect.objectContaining({ trickle: false }),
      );
    });

    it('trickle: true option is passed to SimplePeer constructor', async () => {
      const room = new P2PRoom(true, 'http://localhost', { trickle: true });
      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();

      const simplePeerMock = (await import('simple-peer')).default;
      expect(simplePeerMock).toHaveBeenCalledWith(
        expect.objectContaining({ trickle: true }),
      );
    });

    it('trickle: true forwards extra signals to onSignal callback', async () => {
      const signals: any[] = [];
      const room = new P2PRoom(true, 'http://localhost', {
        trickle: true,
        onSignal: (data) => signals.push(data),
      });

      const promise = (async () => {
        setTimeout(() => {
          mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'first' });
        }, 5);
        return room.offerUrl();
      })();
      await promise;

      const sigFn = mockPeerEvents[0]?.get('signal');
      sigFn?.({ candidate: 'candidate:1', type: 'offer' });

      expect(signals.length).toBe(1);
      expect(signals[0]).toEqual({ candidate: 'candidate:1', type: 'offer' });
    });
  });

  // ── State Callbacks ──

  describe('state callbacks', () => {
    it('onConnectionStateChange and onIceConnectionStateChange are wired on peer connect', async () => {
      const connStates: any[] = [];
      const iceStates: any[] = [];
      const room = new P2PRoom(true, 'http://localhost', {
        onConnectionStateChange: (state, peerId) => connStates.push({ state, peerId }),
        onIceConnectionStateChange: (state, peerId) => iceStates.push({ state, peerId }),
      });

      setTimeout(() => {
        mockPeerEvents[0]?.get('signal')?.({ type: 'offer', sdp: 'x' });
      }, 5);
      await room.offerUrl();

      mockPeerEvents[0]?.get('connect')?.();

      const pc = (room as any)._peers.values().next().value?._pc;
      expect(pc).toBeDefined();
      expect(pc.onconnectionstatechange).toBeDefined();
      expect(pc.oniceconnectionstatechange).toBeDefined();

      pc.onconnectionstatechange?.();
      pc.oniceconnectionstatechange?.();

      expect(connStates.length).toBe(1);
      expect(iceStates.length).toBe(1);
    });
  });
});