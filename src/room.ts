import SimplePeer from 'simple-peer';
import { encodeSignal, decodeSignal } from './signal';
import type { Room, RoomOptions, PeerInfo, SignalData } from './types';

let peerCounter = 0;

export class P2PRoom implements Room {
  public readonly isHost: boolean;

  // Host state
  private _hostOfferPeer?: SimplePeer.Instance;
  private _peers: Map<string, SimplePeer.Instance> = new Map();
  private _peerInfos: PeerInfo[] = [];

  // Peer state
  private _peer?: SimplePeer.Instance;

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

  /** Generate offer URL. Host only. Returns promise resolving with the offer URL. */
  offerUrl(): Promise<string> {
    if (!this.isHost) return Promise.reject(new Error('Only host can generate offers'));
    return new Promise((resolve, reject) => {
      const peer = new SimplePeer({ initiator: true, trickle: false });
      this._hostOfferPeer = peer;

      peer.on('signal', (data: SignalData) => {
        const { url } = encodeSignal(data, this._baseUrl);
        resolve(url);
      });

      peer.on('connect', () => this._onPeerConnected(peer));
      peer.on('error', (err: Error) => {
        this._onError?.(err);
        reject(err);
      });
    });
  }

  /** Accept a peer's answer. Host only. */
  acceptAnswer(signalUrl: string): void {
    if (!this.isHost || !this._hostOfferPeer) {
      this._onError?.(new Error('No pending connection'));
      return;
    }
    const data = decodeSignal(signalUrl);
    if (!data) {
      this._onError?.(new Error('Invalid answer URL'));
      return;
    }
    this._hostOfferPeer.signal(data);
  }

  /** Connect to host using offer URL. Peer only. Returns answer URL promise. */
  connectToHost(offerUrl: string): Promise<string> {
    if (this.isHost) return Promise.reject(new Error('Host cannot connectToHost'));
    const signalData = decodeSignal(offerUrl);
    if (!signalData) return Promise.reject(new Error('Invalid offer URL'));

    return new Promise((resolve, reject) => {
      const peer = new SimplePeer({ initiator: false, trickle: false });

      peer.on('signal', (data: SignalData) => {
        const { url } = encodeSignal(data, this._baseUrl);
        resolve(url);
      });

      peer.on('connect', () => {
        peer.on('data', (data: Uint8Array) => {
          const text = new TextDecoder().decode(data);
          this._onMessage?.(text, 'host');
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
    this._hostOfferPeer?.destroy();
    for (const p of this._peers.values()) p.destroy();
    this._peer?.destroy();
    this._peers.clear();
    this._peerInfos = [];
    this._onClose?.();
  }

  // ── Internal ──

  private _onPeerConnected(peer: SimplePeer.Instance): void {
    const peerId = `peer-${++peerCounter}`;
    this._peers.set(peerId, peer);
    this._peerInfos.push({
      id: peerId,
      send: (d: string | Uint8Array) => peer.send(d),
    });
    this._onPeerJoin?.(peerId);

    peer.on('data', (data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      this._onMessage?.(text, peerId);
    });

    peer.on('close', () => {
      this._peers.delete(peerId);
      this._peerInfos = this._peerInfos.filter(p => p.id !== peerId);
      this._onPeerLeave?.(peerId);
    });

    this._hostOfferPeer = undefined;
  }
}