import SimplePeer from 'simple-peer';
import { encodeSignal, decodeSignal } from './signal';
import type { Room, RoomOptions, PeerInfo, SignalData, ConnectionRoute, BroadcastResult, SendResult, IceMode, CancelOfferResult, IceConfigurationSummary, CandidateSummary } from './types';

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

type OfferState = 'pending' | 'answered' | 'connected' | 'failed' | 'cancelled';

interface OfferRecord {
  peer: InstanceType<typeof SimplePeer>;
  state: OfferState;
  createdAt: number;
  answeredAt?: number;
  timer?: ReturnType<typeof setTimeout>;
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
  private _offers: Map<string, OfferRecord> = new Map();
  private _peers: Map<string, InstanceType<typeof SimplePeer>> = new Map();
  private _peerInfos: PeerInfo[] = [];
  private _sendStates: Map<string, PeerSendState> = new Map();

  // Peer state
  private _peer?: InstanceType<typeof SimplePeer>;
  private _hostSendState?: PeerSendState;

  // Handlers
  private _onMessage?: (data: string | Uint8Array, peerId: string) => void;
  private _onPeerJoin?: (peerId: string) => void;
  private _onOfferAnswered?: (offerId: string) => void;
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
  private readonly _offerTimeoutMs: number;
  private readonly _iceMode: IceMode;

  constructor(isHost: boolean, baseUrl: string, opts: RoomOptions = {}) {
    this.isHost = isHost;
    this._baseUrl = baseUrl;
    this._maxPendingOffers = opts.maxPendingOffers ?? DEFAULT_MAX_PENDING_OFFERS;
    this._maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this._offerTimeoutMs = opts.offerTimeoutMs ?? 5 * 60 * 1000;
    this._trickle = opts.trickle ?? false;
    this._onConnect = opts.onConnect;
    this._onPeerConnect = opts.onPeerConnect;
    this._onPeerLeave = opts.onPeerLeave;
    this._onOfferAnswered = opts.onOfferAnswered;
    this._onError = opts.onError;
    this._onClose = opts.onClose;
    this._onConnectionStateChange = opts.onConnectionStateChange;
    this._onIceConnectionStateChange = opts.onIceConnectionStateChange;
    this._onSignal = opts.onSignal;

    // Wire IceMode
    this._iceMode = opts.iceMode ?? 'all';
    const userConfig = opts.rtcConfig;

    switch (this._iceMode) {
      case 'stun-only': {
        const servers = (userConfig?.iceServers ?? DEFAULT_ICE_CONFIG.iceServers) as RTCIceServer[];
        const stunServers = servers
          .filter(s => {
            if (!s) return false;
            const urls = s.urls;
            // ponytail: servers without urls (credential-only TURN) are useless as STUN — strip
            if (!urls) return false;
            const list = Array.isArray(urls) ? urls : [urls];
            return !list.some(u => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:')));
          })
          // ponytail: strip credentials — never retain TURN credentials after filtering
          .map(s => {
            if ((s as any).username || (s as any).credential || (s as any).credentialType) {
              const { username, credential, credentialType, ...clean } = s as any;
              return clean as RTCIceServer;
            }
            return s;
          });
        this._rtcConfig = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceServers: stunServers,
          iceTransportPolicy: 'all',
        };
        break;
      }
      case 'turn-only': {
        const merged = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceTransportPolicy: 'relay' as RTCIceTransportPolicy,
        };
        // ponytail: inline TURN check — no helper, just one loop
        let hasTurn = false;
        for (const s of (merged.iceServers ?? []) as RTCIceServer[]) {
          if (!s?.urls) continue;
          const list = Array.isArray(s.urls) ? s.urls : [s.urls];
          if (list.some(u => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:')))) {
            hasTurn = true;
            break;
          }
        }
        if (!hasTurn) throw new Error('TURN_REQUIRED');
        this._rtcConfig = merged;
        break;
      }
      case 'all':
      default:
        this._rtcConfig = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceTransportPolicy: 'all',
        };
        break;
    }
  }

  /** Generate an offer for a new peer. Host only. Returns { url, offerId }. */
  offerUrl(): Promise<{ url: string; offerId: string }> {
    if (!this.isHost) return Promise.reject(new Error('Only host can generate offers'));
    if (this._offers.size >= this._maxPendingOffers) {
      const err = new Error(`Max pending offers (${this._maxPendingOffers}) reached`);
      (err as any).code = 'MAX_PENDING_OFFERS';
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const offerId = uuid();
      const peer = new SimplePeer({ initiator: true, trickle: this._trickle, config: this._rtcConfig });
      this._attachStateCallbacks(peer, undefined);
      const record: OfferRecord = { peer, state: 'pending', createdAt: Date.now() };
      this._offers.set(offerId, record);

      // Auto-expire pending offers
      record.timer = setTimeout(() => {
        const offer = this._offers.get(offerId);
        if (offer && offer.state === 'pending') {
          if (offer.timer) { clearTimeout(offer.timer); offer.timer = undefined; }
          offer.peer.destroy();
          offer.state = 'cancelled';
          this._offers.delete(offerId);
        }
      }, this._offerTimeoutMs);

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
        const offer = this._offers.get(offerId);
        if (offer) {
          offer.state = 'failed';
          if (offer.timer) { clearTimeout(offer.timer); offer.timer = undefined; }
        }
        this._onError?.(err);
        reject(err);
      });
    });
  }

  /** Accept a peer's answer for a specific offer. Host only. Throws if already answered. */
  acceptAnswer(offerId: string, signalUrl: string): void {
    if (!this.isHost) {
      this._onError?.(new Error('Only host can accept answers'));
      return;
    }
    const offer = this._offers.get(offerId);
    if (!offer) {
      this._onError?.(new Error(`No pending offer for ${offerId}`));
      return;
    }
    if (offer.state !== 'pending') {
      throw new Error('OFFER_ALREADY_ANSWERED');
    }
    const data = decodeSignal(signalUrl);
    if (!data) {
      this._onError?.(new Error('Invalid answer URL'));
      return;
    }
    offer.state = 'answered';
    offer.answeredAt = Date.now();
    if (offer.timer) { clearTimeout(offer.timer); offer.timer = undefined; }
    offer.peer.signal(data);
    this._onOfferAnswered?.(offerId);
  }

  /** Cancel a pending offer and destroy its peer. Host only. Idempotent. */
  cancelOffer(offerId: string): CancelOfferResult {
    if (!this.isHost) return { cancelled: false };
    const offer = this._offers.get(offerId);
    let cancelled = false;
    if (offer) {
      if (offer.timer) { clearTimeout(offer.timer); offer.timer = undefined; }
      // ponytail: simple-peer destroy() is idempotent (checks this.destroyed internally)
      offer.peer.destroy();
      offer.state = 'cancelled';
      this._offers.delete(offerId);
      cancelled = true;
    }
    // ponytail: belt-and-suspenders — _sendStates keys are peerIds, not offerIds,
    // but clean up by offerId too in case they're temporarily keyed that way.
    const ss = this._sendStates.get(offerId);
    if (ss) {
      (ss.peer as any).removeAllListeners('drain');
      this._sendStates.delete(offerId);
    }
    return { cancelled };
  }

  /** Feed a signal to a specific connection. Host uses offerId; peer uses 'host'. */
  applySignal(connectionId: string, signal: SignalData): void {
    if (this.isHost) {
      const peer = this._peers.get(connectionId);
      if (peer) {
        peer.signal(signal);
        return;
      }
      const pending = this._offers.get(connectionId);
      if (pending) {
        pending.peer.signal(signal);
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

  onOfferAnswered(handler: (offerId: string) => void): void {
    this._onOfferAnswered = handler;
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

    for (const o of this._offers.values()) {
      if (o.timer) clearTimeout(o.timer);
      o.peer.destroy();
    }
    for (const p of this._peers.values()) p.destroy();
    this._peer?.destroy();
    this._offers.clear();
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

  getIceConfigurationSummary(): IceConfigurationSummary {
    let stunCount = 0;
    let turnCount = 0;
    let hasCredentials = false;
    for (const server of this._rtcConfig.iceServers ?? []) {
      if (server?.username || (server as any)?.credential) hasCredentials = true;
      if (!server?.urls) continue;
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const u of urls) {
        const s = String(u);
        if (s.startsWith('turn') || s.startsWith('turns')) turnCount++;
        else if (s.startsWith('stun') || s.startsWith('stuns')) stunCount++;
      }
    }
    return {
      mode: this._iceMode,
      transportPolicy: (this._rtcConfig.iceTransportPolicy ?? 'all') as RTCIceTransportPolicy,
      stunCount,
      turnCount,
      hasTurnCredentials: hasCredentials,
    };
  }

  async getCandidateSummary(peerId?: string): Promise<CandidateSummary> {
    const pc = this._getPC(peerId);
    if (!pc) return { host: 0, srflx: 0, relay: 0, udp: 0, tcp: 0 };
    try {
      const stats = await pc.getStats();
      const summary = { host: 0, srflx: 0, relay: 0, udp: 0, tcp: 0 };
      for (const report of stats.values()) {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          const ct = report.candidateType;
          if (ct === 'host') summary.host++;
          else if (ct === 'srflx') summary.srflx++;
          else if (ct === 'relay') summary.relay++;
          const proto = report.protocol;
          if (proto === 'udp') summary.udp++;
          else if (proto === 'tcp') summary.tcp++;
        }
      }
      return summary;
    } catch {
      return { host: 0, srflx: 0, relay: 0, udp: 0, tcp: 0 };
    }
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
    pc.oniceconnectionstatechange = () => {
      console.log(`[p2p] ICE state → ${pc.iceConnectionState} (peer ${peerId || 'host'})`);
      
      if (pc.iceConnectionState === 'connected') {
        if (!this.isHost && !this._hostSendState) {
          // Peer side fallback
          const ch = (peer as any)._channel;
          if (ch) {
            if (ch.readyState === 'open') {
              console.log('[p2p] data channel already open — initializing send state from ICE');
              this._initPeerSendState(peer);
            } else {
              console.log(`[p2p] data channel state: ${ch.readyState} — waiting for open`);
              ch.addEventListener('open', () => {
                console.log('[p2p] data channel opened — initializing send state');
                this._initPeerSendState(peer);
              }, { once: true });
            }
          } else {
            console.log('[p2p] _channel is null — polling for datachannel...');
            let attempts = 0;
            const poll = setInterval(() => {
              const ch2 = (peer as any)._channel;
              if (ch2) {
                clearInterval(poll);
                console.log(`[p2p] _channel found after ${attempts * 250}ms, state: ${ch2.readyState}`);
                if (ch2.readyState === 'open') {
                  this._initPeerSendState(peer);
                } else {
                  ch2.addEventListener('open', () => {
                    console.log('[p2p] data channel opened — initializing send state');
                    this._initPeerSendState(peer);
                  }, { once: true });
                }
              }
              if (++attempts > 40) { clearInterval(poll); }
              if (this._hostSendState) { clearInterval(poll); }
            }, 250);
          }
        } else if (this.isHost) {
          // Host side fallback: find offer for this peer and fire _onPeerConnected early
          const ch = (peer as any)._channel;
          if (ch && ch.readyState === 'open') {
            for (const [offerId, offer] of this._offers) {
              if (offer.peer === peer && (offer.state === 'pending' || offer.state === 'answered')) {
                console.log(`[p2p] host data channel open — triggering _onPeerConnected for ${offerId}`);
                this._onPeerConnected(offerId, peer);
                break;
              }
            }
          } else {
            console.log(`[p2p] host _channel=${ch ? ch.readyState : 'null'} — polling for open...`);
            let hostAttempts = 0;
            const hostPoll = setInterval(() => {
              const ch2 = (peer as any)._channel;
              if (ch2 && ch2.readyState === 'open') {
                clearInterval(hostPoll);
                console.log(`[p2p] host data channel opened after ${hostAttempts * 250}ms`);
                for (const [offerId, offer] of this._offers) {
                  if (offer.peer === peer && (offer.state === 'pending' || offer.state === 'answered')) {
                    this._onPeerConnected(offerId, peer);
                    break;
                  }
                }
              }
              if (++hostAttempts > 40) { clearInterval(hostPoll); } // 10s timeout
            }, 250);
          }
        }
      }
      this._onIceConnectionStateChange?.(pc.iceConnectionState, peerId);
    };
    pc.onicegatheringstatechange = () => {
      console.log(`[p2p] ICE gathering → ${pc.iceGatheringState} (peer ${peerId || 'host'})`);
    };
  }

  /** Initialize the peer→host send state (idempotent — only sets if not already present). */
  private _initPeerSendState(peer: InstanceType<typeof SimplePeer>): void {
    if (this._hostSendState) return;
    this._hostSendState = { peer, peerId: 'host', queue: [], queuedBytes: 0, draining: false, connected: true };
    this._attachDrainHandler(this._hostSendState);
    peer.on('data', (data: Uint8Array) => { this._onMessage?.(data, 'host'); });
    this._onConnect?.();
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
    const offer = this._offers.get(offerId);
    if (offer) {
      offer.state = 'connected';
      if (offer.timer) { clearTimeout(offer.timer); offer.timer = undefined; }
    }

    // Initialize send state and register close/data handlers BEFORE awaiting
    // onPeerJoin so cleanup works even if close fires during the join callback.
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

    peer.on('data', (data: Uint8Array) => {
      this._onMessage?.(data, peerId);
    });

    peer.on('close', () => {
      if (!this._peers.has(peerId)) return;
      (peer as any).removeAllListeners('data');
      (peer as any).removeAllListeners('close');
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

    // Await onPeerJoin so the handler can create next offer before we mark this peer as fully connected
    await this._onPeerJoin?.(peerId);
    this._onPeerConnect?.(peerId);
    this._flushQueue(sendState);
  }
}