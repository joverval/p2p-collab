// src/signal.ts
function encodeSignal(data, baseUrl = "") {
  const json = JSON.stringify(data);
  const encoded = btoa(json);
  const base = baseUrl.split("#")[0];
  const url = base ? `${base}#sdp=${encoded}` : `#sdp=${encoded}`;
  return { url, sizeKB: +(encoded.length / 1024).toFixed(1) };
}
function decodeSignal(input) {
  if (!input) return null;
  try {
    const fragment = input.includes("#sdp=") ? input.split("#sdp=")[1] : input;
    const parsed = JSON.parse(atob(fragment));
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.type && !parsed.sdp && !parsed.candidate) return null;
    return parsed;
  } catch {
    return null;
  }
}

// src/room.ts
import SimplePeer from "simple-peer";
var DEFAULT_ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceCandidatePoolSize: 0,
  iceTransportPolicy: "all"
};
function uuid() {
  return crypto.randomUUID();
}
var P2PRoom = class {
  isHost;
  // Host state
  _pendingOffers = /* @__PURE__ */ new Map();
  _offerTimers = /* @__PURE__ */ new Map();
  _peers = /* @__PURE__ */ new Map();
  _peerInfos = [];
  // Peer state
  _peer;
  // Handlers
  _onMessage;
  _onPeerJoin;
  _onPeerConnect;
  _onPeerLeave;
  _onConnect;
  _onError;
  _onClose;
  _onConnectionStateChange;
  _onIceConnectionStateChange;
  _onSignal;
  _baseUrl;
  _rtcConfig;
  _trickle;
  constructor(isHost, baseUrl, opts = {}) {
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
  offerUrl() {
    if (!this.isHost) return Promise.reject(new Error("Only host can generate offers"));
    return new Promise((resolve, reject) => {
      const offerId = uuid();
      const peer = new SimplePeer({ initiator: true, trickle: this._trickle, config: this._rtcConfig });
      this._pendingOffers.set(offerId, peer);
      const timer = setTimeout(() => {
        if (this._pendingOffers.has(offerId)) {
          peer.destroy();
          this._pendingOffers.delete(offerId);
          this._offerTimers.delete(offerId);
        }
      }, 5 * 60 * 1e3);
      this._offerTimers.set(offerId, timer);
      let resolved = false;
      peer.on("signal", (data) => {
        if (!resolved) {
          resolved = true;
          const { url } = encodeSignal(data, this._baseUrl);
          resolve({ url, offerId });
        } else if (this._trickle) {
          this._onSignal?.(data);
        }
      });
      peer.on("connect", () => this._onPeerConnected(offerId, peer));
      peer.on("error", (err) => {
        this._pendingOffers.delete(offerId);
        const t = this._offerTimers.get(offerId);
        if (t) {
          clearTimeout(t);
          this._offerTimers.delete(offerId);
        }
        this._onError?.(err);
        reject(err);
      });
    });
  }
  /** Accept a peer's answer for a specific offer. Host only. */
  acceptAnswer(offerId, signalUrl) {
    if (!this.isHost) {
      this._onError?.(new Error("Only host can accept answers"));
      return;
    }
    const peer = this._pendingOffers.get(offerId);
    if (!peer) {
      this._onError?.(new Error(`No pending offer for ${offerId}`));
      return;
    }
    const data = decodeSignal(signalUrl);
    if (!data) {
      this._onError?.(new Error("Invalid answer URL"));
      return;
    }
    peer.signal(data);
  }
  /** Cancel a pending offer and destroy its peer. Host only. */
  cancelOffer(offerId) {
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
  connectToHost(offerUrl) {
    if (this.isHost) return Promise.reject(new Error("Host cannot connectToHost"));
    const signalData = decodeSignal(offerUrl);
    if (!signalData) return Promise.reject(new Error("Invalid offer URL"));
    return new Promise((resolve, reject) => {
      const peer = new SimplePeer({ initiator: false, trickle: this._trickle, config: this._rtcConfig });
      this._attachStateCallbacks(peer, void 0);
      let resolved = false;
      peer.on("signal", (data) => {
        if (!resolved) {
          resolved = true;
          const { url } = encodeSignal(data, this._baseUrl);
          resolve(url);
        } else if (this._trickle) {
          this._onSignal?.(data);
        }
      });
      peer.on("connect", () => {
        peer.on("data", (data) => {
          this._onMessage?.(data, "host");
        });
        this._onConnect?.();
      });
      peer.on("error", (err) => {
        this._onError?.(err);
        reject(err);
      });
      peer.on("close", () => this._onClose?.());
      this._peer = peer;
      peer.signal(signalData);
    });
  }
  // ── Shared public API ──
  get peers() {
    return this._peerInfos;
  }
  send(data) {
    if (this.isHost) {
      let accepted = false;
      for (const peer of this._peers.values()) {
        if (peer.connected) {
          peer.send(data);
          accepted = true;
        }
      }
      return accepted;
    } else if (this._peer && this._peer.connected) {
      this._peer.send(data);
      return true;
    }
    return false;
  }
  sendToPeer(peerId, data) {
    if (!this.isHost) return false;
    const peer = this._peers.get(peerId);
    if (peer && peer.connected) {
      peer.send(data);
      return true;
    }
    return false;
  }
  broadcastExcept(data, excludedPeerId) {
    if (!this.isHost) return { accepted: 0, total: 0 };
    let accepted = 0;
    let total = 0;
    for (const [id, peer] of this._peers) {
      if (id !== excludedPeerId) {
        total++;
        if (peer.connected) {
          peer.send(data);
          accepted++;
        }
      }
    }
    return { accepted, total };
  }
  onMessage(handler) {
    this._onMessage = handler;
  }
  onPeerJoin(handler) {
    this._onPeerJoin = handler;
  }
  close() {
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
  async getConnectionRoute(peerId) {
    const pc = this._getPC(peerId);
    if (!pc) return { kind: "unknown" };
    try {
      const stats = await pc.getStats();
      let selectedPairId;
      for (const report of stats.values()) {
        if (report.type === "transport" && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
          break;
        }
      }
      if (!selectedPairId) {
        for (const report of stats.values()) {
          if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) {
            selectedPairId = report.id;
            break;
          }
        }
      }
      if (!selectedPairId) return { kind: "unknown" };
      const pair = stats.get(selectedPairId);
      if (!pair || pair.type !== "candidate-pair") return { kind: "unknown" };
      const localCandidate = pair.localCandidateId ? stats.get(pair.localCandidateId) : void 0;
      const remoteCandidate = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : void 0;
      const localType = localCandidate?.candidateType;
      const remoteType = remoteCandidate?.candidateType;
      const kind = localType === "relay" || remoteType === "relay" ? "turn" : "direct";
      return {
        kind,
        localCandidateType: localType,
        remoteCandidateType: remoteType,
        protocol: localCandidate?.protocol,
        relayProtocol: localCandidate?.relayProtocol
      };
    } catch {
      return { kind: "unknown" };
    }
  }
  getConnectionState(peerId) {
    const pc = this._getPC(peerId);
    return pc?.connectionState ?? "unknown";
  }
  getIceConnectionState(peerId) {
    const pc = this._getPC(peerId);
    return pc?.iceConnectionState ?? "unknown";
  }
  // ── Internal ──
  _getPC(peerId) {
    if (this.isHost) {
      if (peerId) {
        const peer = this._peers.get(peerId);
        return peer?._pc ?? null;
      }
      for (const peer of this._peers.values()) {
        const pc = peer?._pc;
        if (pc) return pc;
      }
      return null;
    }
    return this._peer?._pc ?? null;
  }
  _attachStateCallbacks(peer, peerId) {
    const pc = peer._pc;
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
  _onPeerConnected(offerId, peer) {
    const peerId = uuid();
    this._attachStateCallbacks(peer, peerId);
    this._peers.set(peerId, peer);
    this._peerInfos.push({
      id: peerId,
      send: (d) => peer.send(d)
    });
    this._pendingOffers.delete(offerId);
    const timer = this._offerTimers.get(offerId);
    if (timer) {
      clearTimeout(timer);
      this._offerTimers.delete(offerId);
    }
    this._onPeerJoin?.(peerId);
    this._onPeerConnect?.(peerId);
    peer.on("data", (data) => {
      this._onMessage?.(data, peerId);
    });
    peer.on("close", () => {
      this._peers.delete(peerId);
      this._peerInfos = this._peerInfos.filter((p) => p.id !== peerId);
      this._onPeerLeave?.(peerId);
    });
  }
};

// src/index.ts
async function createRoom(baseUrl = "", opts) {
  const room = new P2PRoom(true, baseUrl, opts);
  const url = await room.offerUrl();
  return { url, room };
}
async function joinRoom(offerUrl, baseUrl = "", opts) {
  const room = new P2PRoom(false, baseUrl, opts);
  const answerUrl = await room.connectToHost(offerUrl);
  return { room, answerUrl };
}
export {
  P2PRoom,
  createRoom,
  decodeSignal,
  encodeSignal,
  joinRoom
};
//# sourceMappingURL=index.js.map