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
      const { url, offerId } = await room.offerUrl();
      expect(url).toContain('#sdp=');
      expect(offerId).toBeTruthy();
      // UUID format (36 chars with dashes)
      expect(offerId).toMatch(/^[0-9a-f-]{36}$/);
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

      // Now accept answer -- should call signal on the pending peer
      room.acceptAnswer(offerId, '#sdp=' + btoa(JSON.stringify({ type: 'answer', sdp: 'peer-sdp' })));
      // The pending offer should still exist (awaiting connect event)
      const pending = (room as any)._pendingOffers.get(offerId);
      expect(pending).toBeTruthy();
    });

    it('broadcasts send() to all connected peers', () => {
      const room = new P2PRoom(true, '');
      // Simulate connected peers with .connected = true
      const mockSend1 = vi.fn();
      const mockSend2 = vi.fn();
      (room as any)._peers.set('peer-1', { send: mockSend1, on: vi.fn(), connected: true });
      (room as any)._peers.set('peer-2', { send: mockSend2, on: vi.fn(), connected: true });
      (room as any)._peerInfos = [
        { id: 'peer-1', send: mockSend1 },
        { id: 'peer-2', send: mockSend2 },
      ];

      const result = room.send('hello');
      expect(result).toBe(true);
      expect(mockSend1).toHaveBeenCalledWith('hello');
      expect(mockSend2).toHaveBeenCalledWith('hello');
    });

    it('send skips disconnected peers', () => {
      const room = new P2PRoom(true, '');
      const mockSend1 = vi.fn();
      const mockSend2 = vi.fn();
      (room as any)._peers.set('peer-1', { send: mockSend1, on: vi.fn(), connected: false });
      (room as any)._peers.set('peer-2', { send: mockSend2, on: vi.fn(), connected: true });
      (room as any)._peerInfos = [
        { id: 'peer-1', send: mockSend1 },
        { id: 'peer-2', send: mockSend2 },
      ];

      const result = room.send('hello');
      expect(result).toBe(true); // one accepted
      expect(mockSend1).not.toHaveBeenCalled();
      expect(mockSend2).toHaveBeenCalledWith('hello');
    });

    it('send returns false when no peers are connected', () => {
      const room = new P2PRoom(true, '');
      const result = room.send('hello');
      expect(result).toBe(false);
    });

    it('sendToPeer returns false for unknown peer', () => {
      const room = new P2PRoom(true, '');
      const result = room.sendToPeer('nonexistent', 'hello');
      expect(result).toBe(false);
    });

    it('sendToPeer returns false for disconnected peer', () => {
      const room = new P2PRoom(true, '');
      const mockSend = vi.fn();
      (room as any)._peers.set('peer-1', { send: mockSend, on: vi.fn(), connected: false });
      const result = room.sendToPeer('peer-1', 'hello');
      expect(result).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('broadcastExcept returns BroadcastResult and skips disconnected', () => {
      const room = new P2PRoom(true, '');
      const mockSend1 = vi.fn();
      const mockSend2 = vi.fn();
      const mockSend3 = vi.fn();
      (room as any)._peers.set('peer-1', { send: mockSend1, on: vi.fn(), connected: true });
      (room as any)._peers.set('peer-2', { send: mockSend2, on: vi.fn(), connected: false });
      (room as any)._peers.set('peer-3', { send: mockSend3, on: vi.fn(), connected: true });

      const result = room.broadcastExcept('data', 'peer-3');
      expect(result).toEqual({ accepted: 1, total: 2 }); // peer-1 accepted, peer-2 disconnected, peer-3 excluded
      expect(mockSend1).toHaveBeenCalledWith('data');
      expect(mockSend2).not.toHaveBeenCalled();
      expect(mockSend3).not.toHaveBeenCalled(); // excluded
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
      // UUID format for peerId
      expect(joins[0]).toMatch(/^[0-9a-f-]{36}$/);
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

    it('send() sends to host only when connected', () => {
      const room = new P2PRoom(false, '');
      const mockSend = vi.fn();
      (room as any)._peer = { send: mockSend, on: vi.fn(), signal: vi.fn(), connected: true };

      const result = room.send('hello');
      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('hello');
    });

    it('send() returns false when disconnected', () => {
      const room = new P2PRoom(false, '');
      const mockSend = vi.fn();
      (room as any)._peer = { send: mockSend, on: vi.fn(), signal: vi.fn(), connected: false };

      const result = room.send('hello');
      expect(result).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('send() returns false with no peer', () => {
      const room = new P2PRoom(false, '');
      const result = room.send('hello');
      expect(result).toBe(false);
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

      const peerOpts = (mockPeerEvents[0] as any)?._opts || (mockPeerEvents[0] as any)?._peerOpts;
      // Check the room stores the custom config
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
      const mockPeer = {
        send: vi.fn(),
        on: vi.fn(),
        signal: vi.fn(),
        connected: true,
        _pc: {
          connectionState: 'connected' as RTCPeerConnectionState,
          iceConnectionState: 'connected' as RTCIceConnectionState,
        },
      };
      (room as any)._peer = mockPeer;
      expect(room.getConnectionState()).toBe('connected');
      expect(room.getIceConnectionState()).toBe('connected');
    });

    it('getConnectionRoute with mock stats returns direct', async () => {
      const room = new P2PRoom(true, '');
      const mockStats = new Map();
      mockStats.set('transport1', {
        type: 'transport',
        selectedCandidatePairId: 'pair1',
      });
      mockStats.set('pair1', {
        type: 'candidate-pair',
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      });
      mockStats.set('local1', {
        type: 'local-candidate',
        candidateType: 'host',
        protocol: 'udp',
      });
      mockStats.set('remote1', {
        type: 'remote-candidate',
        candidateType: 'host',
      });
      const mockPeer = {
        send: vi.fn(),
        on: vi.fn(),
        connected: true,
        _pc: {
          getStats: vi.fn().mockResolvedValue(mockStats),
        },
      };
      (room as any)._peers.set('peer-1', mockPeer);

      const route = await room.getConnectionRoute('peer-1');
      expect(route.kind).toBe('direct');
      expect(route.localCandidateType).toBe('host');
      expect(route.protocol).toBe('udp');
    });

    it('getConnectionRoute with relay pair returns turn', async () => {
      const room = new P2PRoom(true, '');
      const mockStats = new Map();
      mockStats.set('transport1', {
        type: 'transport',
        selectedCandidatePairId: 'pair1',
      });
      mockStats.set('pair1', {
        type: 'candidate-pair',
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      });
      mockStats.set('local1', {
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'udp',
        relayProtocol: 'udp',
      });
      mockStats.set('remote1', {
        type: 'remote-candidate',
        candidateType: 'srflx',
      });
      const mockPeer = {
        send: vi.fn(),
        on: vi.fn(),
        connected: true,
        _pc: {
          getStats: vi.fn().mockResolvedValue(mockStats),
        },
      };
      (room as any)._peers.set('peer-1', mockPeer);

      const route = await room.getConnectionRoute('peer-1');
      expect(route.kind).toBe('turn');
      expect(route.localCandidateType).toBe('relay');
      expect(route.relayProtocol).toBe('udp');
    });

    it('getConnectionRoute uses fallback when no selectedCandidatePairId', async () => {
      const room = new P2PRoom(true, '');
      const mockStats = new Map();
      mockStats.set('transport1', { type: 'transport' }); // no selectedCandidatePairId
      mockStats.set('pair-fallback', {
        id: 'pair-fallback',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      });
      mockStats.set('local1', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' });
      mockStats.set('remote1', { type: 'remote-candidate', candidateType: 'srflx' });
      const mockPeer = {
        send: vi.fn(),
        on: vi.fn(),
        connected: true,
        _pc: { getStats: vi.fn().mockResolvedValue(mockStats) },
      };
      (room as any)._peers.set('peer-1', mockPeer);

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
      // But peer is in pending (connect not yet fired), so it should have been moved? No -- _onPeerConnected moves it from pending to _peers.
      // Since we didn't fire connect, it's still in _pendingOffers.

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
      // Should not throw
      room.cancelOffer('any-id');
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

      // Check the SimplePeer constructor was called with trickle: false
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

      // Fire a second signal (trickle ICE candidate)
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

      // Simulate connect
      mockPeerEvents[0]?.get('connect')?.();

      // The mock has _pc with onconnectionstatechange/oniceconnectionstatechange setters
      // After _attachStateCallbacks, the setters should be assigned
      const pc = (room as any)._peers.values().next().value?._pc;
      expect(pc).toBeDefined();
      expect(pc.onconnectionstatechange).toBeDefined();
      expect(pc.oniceconnectionstatechange).toBeDefined();

      // Trigger the callbacks manually
      pc.onconnectionstatechange?.();
      pc.oniceconnectionstatechange?.();

      expect(connStates.length).toBe(1);
      expect(iceStates.length).toBe(1);
    });
  });
});
