import SimplePeer from 'simple-peer';
import { encodeSignal, decodeSignal } from './signal';
import type { Room, RoomOptions, PeerInfo, SignalData, ConnectionRoute, BroadcastResult } from './types';

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 0,
  iceTransportPolicy: 'all' as RTCIceTransportPolicy,
};

function uuid(): string {
  return crypto.randomUUID();
}

export class P2PRoom implements Room {
  public readonly isHost: boolean;

  // Host state
  private _pendingOffers: Map<string, InstanceType<typeof SimplePeer>> = new Map();
  private _offerTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _peers: Map<string, InstanceType<typeof SimplePeer>> = new Map();
  private _peerInfos: PeerInfo[] = [];

  // Peer state
  private _peer?: InstanceType<typeof SimplePeer>;

  // Handlers
  private _onMessage?: (data: string | Uint8Array, peerId: string) => void;
  private _onPeerJoin?: (peerId: string) => void;
  private readonly _onPeerConnect?: (peerId: string) => void;
  private readonly _onPeerLeave?: (peerId: string) => void;
  private readonly _onConnect?: () => void;
  private readonly _onError?: (err: Error) => void;
  private readonly _onClose?: () => void;
  private readonly _onConnectionStateChange?: (state: RTCPeerConnectionState, peerId?: string) => void;
  private readonly _onIceConnectionStateChange?: (state: RTCIceConnectionState, peerId?: string) => void;
  private readonly _onSignal?: (data: SignalData) => void;

  private readonly _baseUrl: string;
  private readonly _rtcConfig: RTCConfiguration;
  private readonly _trickle: boolean;

  constructor(isHost: boolean, baseUrl: string, opts: RoomOptions = {}) {
    this.isHost = isHost;
    this._baseUrl = baseUrl;
    this._rtcConfig = opts.rtcConfig || DEFAULT_ICE_CONFIG;
    this._trickle = opts.trickle ?? false;
    this._onConnect = opts.onConnect;
    this._onPeerConnect = opts.onPeerConnect;
    this._onPeerLeave = opts.onPeerLeave;
    this._onError = opts.onError;
    this._onClose = opts.onClose;
    this._onConnectionStateChange = opts.onConnectionStateChange;
    this._onIceConnectionStateChange = opts.onIceConnectionStateChange;
    this._onSignal = opts.onSignal;
  }

  /** Generate an offer for a new peer. Host only. Returns { url, offerId }. */
  offerUrl(): Promise<{ url: string; offerId: string }> {
    if (!this.isHost) return Promise.reject(new Error('Only host can generate offers'));
    return new Promise((resolve, reject) => {
      const offerId = uuid();
      const peer = new SimplePeer({ initiator: true, trickle: this._trickle, config: this._rtcConfig });
      this._pendingOffers.set(offerId, peer);

      // Auto-expire pending offers after 5 minutes
      const timer = setTimeout(() => {
        if (this._pendingOffers.has(offerId)) {
          peer.destroy();
          this._pendingOffers.delete(offerId);
          this._offerTimers.delete(offerId);
        }
      }, 5 * 60 * 1000);
      this._offerTimers.set(offerId, timer);

      let resolved = false;
      peer.on('signal', (data: SignalData) => {
        if (!resolved) {
          resolved = true;
          const { url } = encodeSignal(data, this._baseUrl);
          resolve({ url, offerId });
        } else if (this._trickle) {
          // Additional trickle signals go to onSignal callback
          this._onSignal?.(data);
        }
      });

      peer.on('connect', () => this._onPeerConnected(offerId, peer));
      peer.on('error', (err: Error) => {
        this._pendingOffers.delete(offerId);
        const t = this._offerTimers.get(offerId);
        if (t) { clearTimeout(t); this._offerTimers.delete(offerId); }
        this._onError?.(err);
        reject(err);
      });
    });
  }

  /** Accept a peer's answer for a specific offer. Host only. */
  acceptAnswer(offerId: string, signalUrl: string): void {
    if (!this.isHost) {
      this._onError?.(new Error('Only host can accept answers'));
      return;
    }
    const peer = this._pendingOffers.get(offerId);
    if (!peer) {
      this._onError?.(new Error(`No pending offer for ${offerId}`));
      return;
    }
    const data = decodeSignal(signalUrl);
    if (!data) {
      this._onError?.(new Error('Invalid answer URL'));
      return;
    }
    peer.signal(data);
  }

  /** Cancel a pending offer and destroy its peer. Host only. */
  cancelOffer(offerId: string): void {
    if (!this.isHost) return;
    const peer = this._pendingOffers.get(offerId);
    if (peer) {
      peer.destroy();
      this._pendingOffers.delete(offerId);
    }
    const timer = this._offerTimers.get(offerId);
    if (timer) {
      clearTimeout(timer);
      this._offerTimers.delete(offerId);
    }
  }

  /** Connect to host using offer URL. Peer only. Returns answer URL promise. */
  connectToHost(offerUrl: string): Promise<string> {
    if (this.isHost) return Promise.reject(new Error('Host cannot connectToHost'));
    const signalData = decodeSignal(offerUrl);
    if (!signalData) return Promise.reject(new Error('Invalid offer URL'));

    return new Promise((resolve, reject) => {
      const peer = new SimplePeer({ initiator: false, trickle: this._trickle, config: this._rtcConfig });

      this._attachStateCallbacks(peer, undefined);

      let resolved = false;
      peer.on('signal', (data: SignalData) => {
        if (!resolved) {
          resolved = true;
          const { url } = encodeSignal(data, this._baseUrl);
          resolve(url);
        } else if (this._trickle) {
          this._onSignal?.(data);
        }
      });

      peer.on('connect', () => {
        peer.on('data', (data: Uint8Array) => {
          this._onMessage?.(data, 'host');
        });
        this._onConnect?.();
      });

      peer.on('error', (err: Error) => {
        this._onError?.(err);
        reject(err);
      });

      peer.on('close', () => this._onClose?.());

      this._peer = peer;
      peer.signal(signalData);
    });
  }

  // ── Shared public API ──

  get peers(): PeerInfo[] {
    return this._peerInfos;
  }

  send(data: string | Uint8Array): boolean {
    if (this.isHost) {
      let accepted = false;
      for (const peer of this._peers.values()) {
        if ((peer as any).connected) {
          peer.send(data);
          accepted = true;
        }
      }
      return accepted;
    } else if (this._peer && (this._peer as any).connected) {
      this._peer.send(data);
      return true;
    }
    return false;
  }

  sendToPeer(peerId: string, data: string | Uint8Array): boolean {
    if (!this.isHost) return false;
    const peer = this._peers.get(peerId);
    if (peer && (peer as any).connected) {
      peer.send(data);
      return true;
    }
    return false;
  }

  broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult {
    if (!this.isHost) return { accepted: 0, total: 0 };
    let accepted = 0;
    let total = 0;
    for (const [id, peer] of this._peers) {
      if (id !== excludedPeerId) {
        total++;
        if ((peer as any).connected) {
          peer.send(data);
          accepted++;
        }
      }
    }
    return { accepted, total };
  }

  onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void {
    this._onMessage = handler;
  }

  onPeerJoin(handler: (peerId: string) => void): void {
    this._onPeerJoin = handler;
  }

  close(): void {
    for (const t of this._offerTimers.values()) clearTimeout(t);
    this._offerTimers.clear();
    for (const p of this._pendingOffers.values()) p.destroy();
    for (const p of this._peers.values()) p.destroy();
    this._peer?.destroy();
    this._pendingOffers.clear();
    this._peers.clear();
    this._peerInfos = [];
    this._onClose?.();
  }

  // ── Diagnostics ──

  async getConnectionRoute(peerId?: string): Promise<ConnectionRoute> {
    const pc = this._getPC(peerId);
    if (!pc) return { kind: 'unknown' };
    try {
      const stats = await pc.getStats();
      // Find the transport report with selectedCandidatePairId
      let selectedPairId: string | undefined;
      for (const report of stats.values()) {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
          break;
        }
      }
      // Fallback: find a succeeded + nominated pair
      if (!selectedPairId) {
        for (const report of stats.values()) {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
            selectedPairId = report.id;
            break;
          }
        }
      }
      if (!selectedPairId) return { kind: 'unknown' };

      const pair = stats.get(selectedPairId);
      if (!pair || pair.type !== 'candidate-pair') return { kind: 'unknown' };

      const localCandidate = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
      const remoteCandidate = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined;

      const localType = localCandidate?.candidateType as ConnectionRoute['localCandidateType'] | undefined;
      const remoteType = remoteCandidate?.candidateType as ConnectionRoute['remoteCandidateType'] | undefined;

      const kind: ConnectionRoute['kind'] =
        (localType === 'relay' || remoteType === 'relay') ? 'turn' : 'direct';

      return {
        kind,
        localCandidateType: localType,
        remoteCandidateType: remoteType,
        protocol: localCandidate?.protocol,
        relayProtocol: localCandidate?.relayProtocol,
      };
    } catch {
      return { kind: 'unknown' };
    }
  }

  getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown' {
    const pc = this._getPC(peerId);
    return pc?.connectionState ?? 'unknown';
  }

  getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown' {
    const pc = this._getPC(peerId);
    return pc?.iceConnectionState ?? 'unknown';
  }

  // ── Internal ──

  private _getPC(peerId?: string): RTCPeerConnection | null {
    if (this.isHost) {
      if (peerId) {
        const peer = this._peers.get(peerId);
        return (peer as any)?._pc ?? null;
      }
      // Without peerId, return first connected peer's PC
      for (const peer of this._peers.values()) {
        const pc = (peer as any)?._pc;
        if (pc) return pc;
      }
      return null;
    }
    return (this._peer as any)?._pc ?? null;
  }

  private _attachStateCallbacks(peer: InstanceType<typeof SimplePeer>, peerId: string | undefined): void {
    const pc = (peer as any)._pc as RTCPeerConnection | undefined;
    if (!pc) return;
    if (this._onConnectionStateChange) {
      pc.onconnectionstatechange = () => {
        this._onConnectionStateChange?.(pc.connectionState, peerId);
      };
    }
    if (this._onIceConnectionStateChange) {
      pc.oniceconnectionstatechange = () => {
        this._onIceConnectionStateChange?.(pc.iceConnectionState, peerId);
      };
    }
  }

  private _onPeerConnected(offerId: string, peer: InstanceType<typeof SimplePeer>): void {
    const peerId = uuid();
    this._attachStateCallbacks(peer, peerId);
    this._peers.set(peerId, peer);
    this._peerInfos.push({
      id: peerId,
      send: (d: string | Uint8Array) => peer.send(d),
    });
    this._pendingOffers.delete(offerId);
    const timer = this._offerTimers.get(offerId);
    if (timer) { clearTimeout(timer); this._offerTimers.delete(offerId); }
    this._onPeerJoin?.(peerId);
    this._onPeerConnect?.(peerId);

    peer.on('data', (data: Uint8Array) => {
      this._onMessage?.(data, peerId);
    });

    peer.on('close', () => {
      this._peers.delete(peerId);
      this._peerInfos = this._peerInfos.filter(p => p.id !== peerId);
      this._onPeerLeave?.(peerId);
    });
  }
}