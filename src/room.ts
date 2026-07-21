import SimplePeer from 'simple-peer';
import { encodeSignal, decodeSignal } from './signal';
import type { Room, RoomOptions, PeerInfo, SignalData } from './types';

// STUN servers for NAT traversal (no TURN — P2P only)
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let peerCounter = 0;
let offerCounter = 0;

export class P2PRoom implements Room {
  public readonly isHost: boolean;

  // Host state
  private _pendingOffers: Map<string, InstanceType<typeof SimplePeer>> = new Map();
  private _peers: Map<string, InstanceType<typeof SimplePeer>> = new Map();
  private _peerInfos: PeerInfo[] = [];

  // Peer state
  private _peer?: InstanceType<typeof SimplePeer>;

  // Handlers
  private _onMessage?: (data: string | Uint8Array, peerId: string) => void;
  private _onPeerJoin?: (peerId: string) => void;
  private readonly _onPeerLeave?: (peerId: string) => void;
  private readonly _onError?: (err: Error) => void;
  private readonly _onClose?: () => void;

  private readonly _baseUrl: string;

  constructor(isHost: boolean, baseUrl: string, opts: RoomOptions = {}) {
    this.isHost = isHost;
    this._baseUrl = baseUrl;
    this._onPeerLeave = opts.onPeerLeave;
    this._onError = opts.onError;
    this._onClose = opts.onClose;
  }

  /** Generate an offer for a new peer. Host only. Returns { url, offerId }. */
  offerUrl(): Promise<{ url: string; offerId: string }> {
    if (!this.isHost) return Promise.reject(new Error('Only host can generate offers'));
    return new Promise((resolve, reject) => {
      const offerId = `offer-${++offerCounter}`;
      const peer = new SimplePeer({ initiator: true, trickle: false, config: ICE_SERVERS });
      this._pendingOffers.set(offerId, peer);

      peer.on('signal', (data: SignalData) => {
        const { url } = encodeSignal(data, this._baseUrl);
        resolve({ url, offerId });
      });

      peer.on('connect', () => this._onPeerConnected(offerId, peer));
      peer.on('error', (err: Error) => {
        this._pendingOffers.delete(offerId);
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

  /** Connect to host using offer URL. Peer only. Returns answer URL promise. */
  connectToHost(offerUrl: string): Promise<string> {
    if (this.isHost) return Promise.reject(new Error('Host cannot connectToHost'));
    const signalData = decodeSignal(offerUrl);
    if (!signalData) return Promise.reject(new Error('Invalid offer URL'));

    return new Promise((resolve, reject) => {
      const peer = new SimplePeer({ initiator: false, trickle: false, config: ICE_SERVERS });

      peer.on('signal', (data: SignalData) => {
        const { url } = encodeSignal(data, this._baseUrl);
        resolve(url);
      });

      peer.on('connect', () => {
        peer.on('data', (data: Uint8Array) => {
          this._onMessage?.(data, 'host');
        });
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

  send(data: string | Uint8Array): void {
    if (this.isHost) {
      for (const peer of this._peers.values()) {
        peer.send(data);
      }
    } else if (this._peer) {
      this._peer.send(data);
    }
  }

  onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void {
    this._onMessage = handler;
  }

  onPeerJoin(handler: (peerId: string) => void): void {
    this._onPeerJoin = handler;
  }

  close(): void {
    for (const p of this._pendingOffers.values()) p.destroy();
    for (const p of this._peers.values()) p.destroy();
    this._peer?.destroy();
    this._pendingOffers.clear();
    this._peers.clear();
    this._peerInfos = [];
    this._onClose?.();
  }

  // ── Internal ──

  private _onPeerConnected(offerId: string, peer: InstanceType<typeof SimplePeer>): void {
    const peerId = `peer-${++peerCounter}`;
    this._peers.set(peerId, peer);
    this._peerInfos.push({
      id: peerId,
      send: (d: string | Uint8Array) => peer.send(d),
    });
    this._pendingOffers.delete(offerId);
    this._onPeerJoin?.(peerId);

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