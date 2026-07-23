import SimplePeer from 'simple-peer';
import { encodeSignal, decodeSignal } from './signal';
import type { Room, RoomOptions, PeerInfo, SignalData, ConnectionRoute, BroadcastResult, SendResult, IceMode } from './types';

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 0,
  iceTransportPolicy: 'all' as RTCIceTransportPolicy,
};

const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024; // 256 KB
const DEFAULT_MAX_PENDING_OFFERS = 50;

function uuid(): string {
  return crypto.randomUUID();
}

interface QueuedMessage {
  data: string | Uint8Array;
  byteLength: number;
}

interface PeerSendState {
  peer: InstanceType<typeof SimplePeer>;
  peerId: string;
  queue: QueuedMessage[];
  queuedBytes: number;
  draining: boolean;
  connected: boolean;
}

export class P2PRoom implements Room {
  public readonly isHost: boolean;

  // Host state
  private _pendingOffers: Map<string, InstanceType<typeof SimplePeer>> = new Map();
  private _offerTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _peers: Map<string, InstanceType<typeof SimplePeer>> = new Map();
  private _peerInfos: PeerInfo[] = [];
  private _sendStates: Map<string, PeerSendState> = new Map();
  private _answeredOffers: Set<string> = new Set();

  // Peer state
  private _peer?: InstanceType<typeof SimplePeer>;
  private _hostSendState?: PeerSendState;

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
  private readonly _maxPendingOffers: number;
  private readonly _maxQueuedBytes: number;

  constructor(isHost: boolean, baseUrl: string, opts: RoomOptions = {}) {
    this.isHost = isHost;
    this._baseUrl = baseUrl;
    this._maxPendingOffers = opts.maxPendingOffers ?? DEFAULT_MAX_PENDING_OFFERS;
    this._maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this._trickle = opts.trickle ?? false;
    this._onConnect = opts.onConnect;
    this._onPeerConnect = opts.onPeerConnect;
    this._onPeerLeave = opts.onPeerLeave;
    this._onError = opts.onError;
    this._onClose = opts.onClose;
    this._onConnectionStateChange = opts.onConnectionStateChange;
    this._onIceConnectionStateChange = opts.onIceConnectionStateChange;
    this._onSignal = opts.onSignal;

    // Wire IceMode
    const iceMode: IceMode = opts.iceMode ?? 'all';
    const userConfig = opts.rtcConfig;

    switch (iceMode) {
      case 'stun-only': {
        const servers = (userConfig?.iceServers ?? DEFAULT_ICE_CONFIG.iceServers) as RTCIceServer[];
        const stunServers = servers
          .filter(s => {
            if (!s) return false;
            const urls = s.urls;
            if (!urls) return true;
            const list = Array.isArray(urls) ? urls : [urls];
            return !list.some(u => typeof u === 'string' && u.startsWith('turn'));
          });
        this._rtcConfig = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceServers: stunServers,
          iceTransportPolicy: 'all',
        };
        break;
      }
      case 'turn-only':
        this._rtcConfig = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceTransportPolicy: 'relay',
        };
        break;
      case 'all':
      default:
        this._rtcConfig = userConfig ?? DEFAULT_ICE_CONFIG;
        break;
    }
  }

  /** Generate an offer for a new peer. Host only. Returns { url, offerId }. */
  offerUrl(): Promise<{ url: string; offerId: string }> {
    if (!this.isHost) return Promise.reject(new Error('Only host can generate offers'));
    if (this._pendingOffers.size >= this._maxPendingOffers) {
      return Promise.reject(new Error(`Max pending offers (${this._maxPendingOffers}) reached`));
    }
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
    if (this._answeredOffers.has(offerId)) {
      this._onError?.(new Error(`Offer ${offerId} already answered`));
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
    this._answeredOffers.add(offerId);
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
    // Also clean up send state and answered offers
    this._answeredOffers.delete(offerId);
    const state = this._sendStates.get(offerId);
    if (state) {
      (state.peer as any).removeAllListeners('drain');
      this._sendStates.delete(offerId);
    }
  }

  /** Feed a signal to a specific connection. Host uses offerId; peer uses 'host'. */
  applySignal(connectionId: string, signal: SignalData): void {
    if (this.isHost) {
      const peer = this._peers.get(connectionId);
      if (peer) {
        peer.signal(signal);
        return;
      }
      const pending = this._pendingOffers.get(connectionId);
      if (pending) {
        pending.signal(signal);
        return;
      }
      this._onError?.(new Error(`No connection found for ${connectionId}`));
    } else {
      if (connectionId !== 'host') {
        this._onError?.(new Error('Peer mode: connectionId must be "host"'));
        return;
      }
      if (this._peer) {
        this._peer.signal(signal);
      } else {
        this._onError?.(new Error('Not connected to host'));
      }
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
        // Initialize host send state
        this._hostSendState = {
          peer,
          peerId: 'host',
          queue: [],
          queuedBytes: 0,
          draining: false,
          connected: true,
        };
        this._attachDrainHandler(this._hostSendState);
        this._flushQueue(this._hostSendState);

        peer.on('data', (data: Uint8Array) => {
          this._onMessage?.(data, 'host');
        });
        this._onConnect?.();
      });

      peer.on('error', (err: Error) => {
        this._onError?.(err);
        reject(err);
      });

      peer.on('close', () => {
        // Detach listeners to prevent stale callbacks after close
        (peer as any).removeAllListeners('data');
        (peer as any).removeAllListeners('close');

        if (this._hostSendState) {
          (this._hostSendState.peer as any).removeAllListeners('drain');
          this._hostSendState.queue = [];
          this._hostSendState.queuedBytes = 0;
          this._hostSendState = undefined;
        }
        this._onClose?.();
      });

      this._peer = peer;
      peer.signal(signalData);
    });
  }

  // ── Shared public API ──

  get peers(): PeerInfo[] {
    return this._peerInfos;
  }

  send(data: string | Uint8Array): SendResult {
    if (this.isHost) {
      let anyAccepted = false;
      let anyQueued = false;
      for (const state of this._sendStates.values()) {
        const r = this._sendToState(state, data);
        if (r.status === 'accepted') anyAccepted = true;
        if (r.status === 'queued') anyQueued = true;
      }
      if (anyAccepted) return { status: 'accepted' };
      if (anyQueued) return { status: 'queued' };
      return { status: 'rejected', reason: 'no peers connected' };
    } else if (this._hostSendState) {
      return this._sendToState(this._hostSendState, data);
    }
    return { status: 'rejected', reason: 'not connected' };
  }

  sendToPeer(peerId: string, data: string | Uint8Array): SendResult {
    if (!this.isHost) return { status: 'rejected', reason: 'only host can send to specific peers' };
    const state = this._sendStates.get(peerId);
    if (!state) return { status: 'rejected', reason: `unknown peer: ${peerId}` };
    return this._sendToState(state, data);
  }

  broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult {
    if (!this.isHost) return { accepted: 0, queued: 0, rejected: 0, total: 0 };
    let accepted = 0;
    let queued = 0;
    let rejected = 0;
    let total = 0;
    for (const [id, state] of this._sendStates) {
      if (id !== excludedPeerId) {
        total++;
        const r = this._sendToState(state, data);
        if (r.status === 'accepted') accepted++;
        else if (r.status === 'queued') queued++;
        else rejected++;
      }
    }
    return { accepted, queued, rejected, total };
  }

  onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void {
    this._onMessage = handler;
  }

  onPeerJoin(handler: (peerId: string) => void): void {
    this._onPeerJoin = handler;
  }

  close(): void {
    // Clean up send states
    for (const state of this._sendStates.values()) {
      (state.peer as any).removeAllListeners('drain');
      state.queue = [];
    }
    this._sendStates.clear();
    if (this._hostSendState) {
      (this._hostSendState.peer as any).removeAllListeners('drain');
      this._hostSendState.queue = [];
      this._hostSendState = undefined;
    }

    for (const t of this._offerTimers.values()) clearTimeout(t);
    this._offerTimers.clear();
    for (const p of this._pendingOffers.values()) p.destroy();
    for (const p of this._peers.values()) p.destroy();
    this._peer?.destroy();
    this._pendingOffers.clear();
    this._peers.clear();
    this._peerInfos = [];
    this._answeredOffers.clear();
    this._onClose?.();
  }

  // ── Diagnostics ──

  async getConnectionRoute(peerId?: string): Promise<ConnectionRoute> {
    const pc = this._getPC(peerId);
    if (!pc) return { kind: 'unknown' };
    try {
      const stats = await pc.getStats();
      let selectedPairId: string | undefined;
      for (const report of stats.values()) {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
          break;
        }
      }
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

  private _attachDrainHandler(state: PeerSendState): void {
    (state.peer as any).on('drain', () => {
      state.draining = false;
      state.queuedBytes = (state.peer as any).bufferSize ?? 0;
      this._flushQueue(state);
    });
  }

  private _sendToState(state: PeerSendState, data: string | Uint8Array): SendResult {
    const byteLength = typeof data === 'string'
      ? new TextEncoder().encode(data).length
      : data.length;

    if (state.connected && state.queue.length === 0) {
      const wrote = (state.peer as any).write?.(data);
      if (wrote === false) {
        state.draining = true;
        return this._enqueue(state, data, byteLength);
      }
      // write() returned true or is not available (fallback to send)
      if (wrote === undefined) {
        // SimplePeer without write(): use send() directly
        (state.peer as any).send?.(data);
      }
      const buf = (state.peer as any)._channel?.bufferedAmount ?? (state.peer as any).bufferSize ?? 0;
      return { status: 'accepted', bufferedAmount: buf };
    }

    return this._enqueue(state, data, byteLength);
  }

  private _enqueue(state: PeerSendState, data: string | Uint8Array, byteLength: number): SendResult {
    if (state.queuedBytes + byteLength > this._maxQueuedBytes) {
      return {
        status: 'rejected',
        reason: `queue full: ${state.queuedBytes}/${this._maxQueuedBytes} bytes buffered`,
        bufferedAmount: state.queuedBytes,
      };
    }
    state.queuedBytes += byteLength;
    if (state.connected) {
      // Connected: push through write() immediately
      const wrote = (state.peer as any).write?.(data);
      if (wrote === false) {
        state.draining = true;
        state.queue.push({ data, byteLength });
        return { status: 'queued', bufferedAmount: state.queuedBytes };
      }
      // If write returned true or is unavailable, data was accepted
      // Still count as queued since we had backlog
      return { status: 'queued', bufferedAmount: state.queuedBytes };
    }
    // Pre-connect: store in queue
    state.queue.push({ data, byteLength });
    return { status: 'queued', bufferedAmount: state.queuedBytes };
  }

  private _flushQueue(state: PeerSendState): void {
    while (state.queue.length > 0 && !state.draining) {
      const msg = state.queue.shift()!;
      state.queuedBytes -= msg.byteLength;
      const wrote = (state.peer as any).write?.(msg.data);
      if (wrote === false) {
        state.draining = true;
        // Put it back at front
        state.queue.unshift(msg);
        state.queuedBytes += msg.byteLength;
        break;
      }
    }
  }

  private async _onPeerConnected(offerId: string, peer: InstanceType<typeof SimplePeer>): Promise<void> {
    const peerId = uuid();
    this._attachStateCallbacks(peer, peerId);
    this._peers.set(peerId, peer);
    this._peerInfos.push({
      id: peerId,
      send: (d: string | Uint8Array) => peer.send(d),
    });
    this._answeredOffers.delete(offerId);
    this._pendingOffers.delete(offerId);
    const timer = this._offerTimers.get(offerId);
    if (timer) { clearTimeout(timer); this._offerTimers.delete(offerId); }
    // Await onPeerJoin so the handler can create next offer before we mark this peer as fully connected
    await this._onPeerJoin?.(peerId);
    this._onPeerConnect?.(peerId);

    // Initialize send state for this peer
    const sendState: PeerSendState = {
      peer,
      peerId,
      queue: [],
      queuedBytes: 0,
      draining: false,
      connected: true,
    };
    this._sendStates.set(peerId, sendState);
    this._attachDrainHandler(sendState);
    this._flushQueue(sendState);

    peer.on('data', (data: Uint8Array) => {
      this._onMessage?.(data, peerId);
    });

    peer.on('close', () => {
      // Guard against duplicate close events
      if (!this._peers.has(peerId)) return;

      // Detach listeners to prevent stale callbacks after close
      (peer as any).removeAllListeners('data');
      (peer as any).removeAllListeners('close');

      // Clean up send state
      const st = this._sendStates.get(peerId);
      if (st) {
        (st.peer as any).removeAllListeners('drain');
        st.queue = [];
        this._sendStates.delete(peerId);
      }
      this._peers.delete(peerId);
      this._peerInfos = this._peerInfos.filter(p => p.id !== peerId);
      this._onPeerLeave?.(peerId);
    });
  }
}