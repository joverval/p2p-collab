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
var DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;
var DEFAULT_MAX_PENDING_OFFERS = 50;
function uuid() {
  return crypto.randomUUID();
}
var P2PRoom = class {
  isHost;
  // Host state
  _offers = /* @__PURE__ */ new Map();
  _peers = /* @__PURE__ */ new Map();
  _peerInfos = [];
  _sendStates = /* @__PURE__ */ new Map();
  // Peer state
  _peer;
  _hostSendState;
  // Handlers
  _onMessage;
  _onPeerJoin;
  _onOfferAnswered;
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
  _maxPendingOffers;
  _maxQueuedBytes;
  _offerTimeoutMs;
  _iceMode;
  constructor(isHost, baseUrl, opts = {}) {
    this.isHost = isHost;
    this._baseUrl = baseUrl;
    this._maxPendingOffers = opts.maxPendingOffers ?? DEFAULT_MAX_PENDING_OFFERS;
    this._maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this._offerTimeoutMs = opts.offerTimeoutMs ?? 5 * 60 * 1e3;
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
    this._iceMode = opts.iceMode ?? "all";
    const userConfig = opts.rtcConfig;
    switch (this._iceMode) {
      case "stun-only": {
        const servers = userConfig?.iceServers ?? DEFAULT_ICE_CONFIG.iceServers;
        const stunServers = servers.filter((s) => {
          if (!s) return false;
          const urls = s.urls;
          if (!urls) return false;
          const list = Array.isArray(urls) ? urls : [urls];
          return !list.some((u) => typeof u === "string" && (u.startsWith("turn:") || u.startsWith("turns:")));
        }).map((s) => {
          if (s.username || s.credential || s.credentialType) {
            const { username, credential, credentialType, ...clean } = s;
            return clean;
          }
          return s;
        });
        this._rtcConfig = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceServers: stunServers,
          iceTransportPolicy: "all"
        };
        break;
      }
      case "turn-only": {
        const merged = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceTransportPolicy: "relay"
        };
        let hasTurn = false;
        for (const s of merged.iceServers ?? []) {
          if (!s?.urls) continue;
          const list = Array.isArray(s.urls) ? s.urls : [s.urls];
          if (list.some((u) => typeof u === "string" && (u.startsWith("turn:") || u.startsWith("turns:")))) {
            hasTurn = true;
            break;
          }
        }
        if (!hasTurn) throw new Error("TURN_REQUIRED");
        this._rtcConfig = merged;
        break;
      }
      case "all":
      default:
        this._rtcConfig = {
          ...DEFAULT_ICE_CONFIG,
          ...userConfig,
          iceTransportPolicy: "all"
        };
        break;
    }
  }
  /** Generate an offer for a new peer. Host only. Returns { url, offerId }. */
  offerUrl() {
    if (!this.isHost) return Promise.reject(new Error("Only host can generate offers"));
    if (this._offers.size >= this._maxPendingOffers) {
      const err = new Error(`Max pending offers (${this._maxPendingOffers}) reached`);
      err.code = "MAX_PENDING_OFFERS";
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const offerId = uuid();
      const peer = new SimplePeer({ initiator: true, trickle: this._trickle, config: this._rtcConfig });
      this._attachStateCallbacks(peer, void 0);
      const record = { peer, state: "pending", createdAt: Date.now() };
      this._offers.set(offerId, record);
      record.timer = setTimeout(() => {
        const offer = this._offers.get(offerId);
        if (offer && offer.state === "pending") {
          if (offer.timer) {
            clearTimeout(offer.timer);
            offer.timer = void 0;
          }
          offer.peer.destroy();
          offer.state = "cancelled";
          this._offers.delete(offerId);
        }
      }, this._offerTimeoutMs);
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
        const offer = this._offers.get(offerId);
        if (offer) {
          offer.state = "failed";
          if (offer.timer) {
            clearTimeout(offer.timer);
            offer.timer = void 0;
          }
        }
        this._onError?.(err);
        reject(err);
      });
    });
  }
  /** Accept a peer's answer for a specific offer. Host only. Throws if already answered. */
  acceptAnswer(offerId, signalUrl) {
    if (!this.isHost) {
      this._onError?.(new Error("Only host can accept answers"));
      return;
    }
    const offer = this._offers.get(offerId);
    if (!offer) {
      this._onError?.(new Error(`No pending offer for ${offerId}`));
      return;
    }
    if (offer.state !== "pending") {
      throw new Error("OFFER_ALREADY_ANSWERED");
    }
    const data = decodeSignal(signalUrl);
    if (!data) {
      this._onError?.(new Error("Invalid answer URL"));
      return;
    }
    offer.state = "answered";
    offer.answeredAt = Date.now();
    if (offer.timer) {
      clearTimeout(offer.timer);
      offer.timer = void 0;
    }
    offer.peer.signal(data);
    this._onOfferAnswered?.(offerId);
  }
  /** Cancel a pending offer and destroy its peer. Host only. Idempotent. */
  cancelOffer(offerId) {
    if (!this.isHost) return { cancelled: false };
    const offer = this._offers.get(offerId);
    let cancelled = false;
    if (offer) {
      if (offer.timer) {
        clearTimeout(offer.timer);
        offer.timer = void 0;
      }
      offer.peer.destroy();
      offer.state = "cancelled";
      this._offers.delete(offerId);
      cancelled = true;
    }
    const ss = this._sendStates.get(offerId);
    if (ss) {
      ss.peer.removeAllListeners("drain");
      this._sendStates.delete(offerId);
    }
    return { cancelled };
  }
  /** Feed a signal to a specific connection. Host uses offerId; peer uses 'host'. */
  applySignal(connectionId, signal) {
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
      if (connectionId !== "host") {
        this._onError?.(new Error('Peer mode: connectionId must be "host"'));
        return;
      }
      if (this._peer) {
        this._peer.signal(signal);
      } else {
        this._onError?.(new Error("Not connected to host"));
      }
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
        this._hostSendState = {
          peer,
          peerId: "host",
          queue: [],
          queuedBytes: 0,
          draining: false,
          connected: true
        };
        this._attachDrainHandler(this._hostSendState);
        this._flushQueue(this._hostSendState);
        peer.on("data", (data) => {
          this._onMessage?.(data, "host");
        });
        this._onConnect?.();
      });
      peer.on("error", (err) => {
        this._onError?.(err);
        reject(err);
      });
      peer.on("close", () => {
        peer.removeAllListeners("data");
        peer.removeAllListeners("close");
        if (this._hostSendState) {
          this._hostSendState.peer.removeAllListeners("drain");
          this._hostSendState.queue = [];
          this._hostSendState.queuedBytes = 0;
          this._hostSendState = void 0;
        }
        this._onClose?.();
      });
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
      let anyAccepted = false;
      let anyQueued = false;
      for (const state of this._sendStates.values()) {
        const r = this._sendToState(state, data);
        if (r.status === "accepted") anyAccepted = true;
        if (r.status === "queued") anyQueued = true;
      }
      if (anyAccepted) return { status: "accepted" };
      if (anyQueued) return { status: "queued" };
      return { status: "rejected", reason: "no peers connected" };
    } else if (this._hostSendState) {
      return this._sendToState(this._hostSendState, data);
    }
    return { status: "rejected", reason: "not connected" };
  }
  sendToPeer(peerId, data) {
    if (!this.isHost) return { status: "rejected", reason: "only host can send to specific peers" };
    const state = this._sendStates.get(peerId);
    if (!state) return { status: "rejected", reason: `unknown peer: ${peerId}` };
    return this._sendToState(state, data);
  }
  broadcastExcept(data, excludedPeerId) {
    if (!this.isHost) return { accepted: 0, queued: 0, rejected: 0, total: 0 };
    let accepted = 0;
    let queued = 0;
    let rejected = 0;
    let total = 0;
    for (const [id, state] of this._sendStates) {
      if (id !== excludedPeerId) {
        total++;
        const r = this._sendToState(state, data);
        if (r.status === "accepted") accepted++;
        else if (r.status === "queued") queued++;
        else rejected++;
      }
    }
    return { accepted, queued, rejected, total };
  }
  onMessage(handler) {
    this._onMessage = handler;
  }
  onPeerJoin(handler) {
    this._onPeerJoin = handler;
  }
  onOfferAnswered(handler) {
    this._onOfferAnswered = handler;
  }
  close() {
    for (const state of this._sendStates.values()) {
      state.peer.removeAllListeners("drain");
      state.queue = [];
    }
    this._sendStates.clear();
    if (this._hostSendState) {
      this._hostSendState.peer.removeAllListeners("drain");
      this._hostSendState.queue = [];
      this._hostSendState = void 0;
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
  getIceConfigurationSummary() {
    let stunCount = 0;
    let turnCount = 0;
    let hasCredentials = false;
    for (const server of this._rtcConfig.iceServers ?? []) {
      if (server?.username || server?.credential) hasCredentials = true;
      if (!server?.urls) continue;
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const u of urls) {
        const s = String(u);
        if (s.startsWith("turn") || s.startsWith("turns")) turnCount++;
        else if (s.startsWith("stun") || s.startsWith("stuns")) stunCount++;
      }
    }
    return {
      mode: this._iceMode,
      transportPolicy: this._rtcConfig.iceTransportPolicy ?? "all",
      stunCount,
      turnCount,
      hasTurnCredentials: hasCredentials
    };
  }
  async getCandidateSummary(peerId) {
    const pc = this._getPC(peerId);
    if (!pc) return { host: 0, srflx: 0, relay: 0, udp: 0, tcp: 0 };
    try {
      const stats = await pc.getStats();
      const summary = { host: 0, srflx: 0, relay: 0, udp: 0, tcp: 0 };
      for (const report of stats.values()) {
        if (report.type === "local-candidate" || report.type === "remote-candidate") {
          const ct = report.candidateType;
          if (ct === "host") summary.host++;
          else if (ct === "srflx") summary.srflx++;
          else if (ct === "relay") summary.relay++;
          const proto = report.protocol;
          if (proto === "udp") summary.udp++;
          else if (proto === "tcp") summary.tcp++;
        }
      }
      return summary;
    } catch {
      return { host: 0, srflx: 0, relay: 0, udp: 0, tcp: 0 };
    }
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
    pc.oniceconnectionstatechange = () => {
      console.log(`[p2p] ICE state \u2192 ${pc.iceConnectionState} (peer ${peerId || "host"})`);
      if (pc.iceConnectionState === "connected" && !this.isHost && !this._hostSendState) {
        const ch = peer._channel;
        if (ch) {
          if (ch.readyState === "open") {
            console.log("[p2p] data channel already open \u2014 initializing send state from ICE");
            this._initPeerSendState(peer);
          } else {
            console.log(`[p2p] data channel state: ${ch.readyState} \u2014 waiting for open`);
            ch.addEventListener("open", () => {
              console.log("[p2p] data channel opened \u2014 initializing send state");
              this._initPeerSendState(peer);
            }, { once: true });
          }
        } else {
          console.log("[p2p] _channel is null \u2014 polling for datachannel...");
          let attempts = 0;
          const poll = setInterval(() => {
            const ch2 = peer._channel;
            if (ch2) {
              clearInterval(poll);
              console.log(`[p2p] _channel found after ${attempts * 250}ms, state: ${ch2.readyState}`);
              if (ch2.readyState === "open") {
                this._initPeerSendState(peer);
              } else {
                ch2.addEventListener("open", () => {
                  console.log("[p2p] data channel opened \u2014 initializing send state");
                  this._initPeerSendState(peer);
                }, { once: true });
              }
            }
            if (++attempts > 40) {
              clearInterval(poll);
            }
            if (this._hostSendState) {
              clearInterval(poll);
            }
          }, 250);
        }
      }
      this._onIceConnectionStateChange?.(pc.iceConnectionState, peerId);
    };
    pc.onicegatheringstatechange = () => {
      console.log(`[p2p] ICE gathering \u2192 ${pc.iceGatheringState} (peer ${peerId || "host"})`);
    };
  }
  /** Initialize the peer→host send state (idempotent — only sets if not already present). */
  _initPeerSendState(peer) {
    if (this._hostSendState) return;
    this._hostSendState = { peer, peerId: "host", queue: [], queuedBytes: 0, draining: false, connected: true };
    this._attachDrainHandler(this._hostSendState);
    peer.on("data", (data) => {
      this._onMessage?.(data, "host");
    });
    this._onConnect?.();
  }
  _attachDrainHandler(state) {
    state.peer.on("drain", () => {
      state.draining = false;
      state.queuedBytes = state.peer.bufferSize ?? 0;
      this._flushQueue(state);
    });
  }
  _sendToState(state, data) {
    const byteLength = typeof data === "string" ? new TextEncoder().encode(data).length : data.length;
    if (state.connected && state.queue.length === 0) {
      const wrote = state.peer.write?.(data);
      if (wrote === false) {
        state.draining = true;
        return this._enqueue(state, data, byteLength);
      }
      if (wrote === void 0) {
        state.peer.send?.(data);
      }
      const buf = state.peer._channel?.bufferedAmount ?? state.peer.bufferSize ?? 0;
      return { status: "accepted", bufferedAmount: buf };
    }
    return this._enqueue(state, data, byteLength);
  }
  _enqueue(state, data, byteLength) {
    if (state.queuedBytes + byteLength > this._maxQueuedBytes) {
      return {
        status: "rejected",
        reason: `queue full: ${state.queuedBytes}/${this._maxQueuedBytes} bytes buffered`,
        bufferedAmount: state.queuedBytes
      };
    }
    state.queuedBytes += byteLength;
    if (state.connected) {
      const wrote = state.peer.write?.(data);
      if (wrote === false) {
        state.draining = true;
        state.queue.push({ data, byteLength });
        return { status: "queued", bufferedAmount: state.queuedBytes };
      }
      return { status: "queued", bufferedAmount: state.queuedBytes };
    }
    state.queue.push({ data, byteLength });
    return { status: "queued", bufferedAmount: state.queuedBytes };
  }
  _flushQueue(state) {
    while (state.queue.length > 0 && !state.draining) {
      const msg = state.queue.shift();
      state.queuedBytes -= msg.byteLength;
      const wrote = state.peer.write?.(msg.data);
      if (wrote === false) {
        state.draining = true;
        state.queue.unshift(msg);
        state.queuedBytes += msg.byteLength;
        break;
      }
    }
  }
  async _onPeerConnected(offerId, peer) {
    const peerId = uuid();
    this._attachStateCallbacks(peer, peerId);
    this._peers.set(peerId, peer);
    this._peerInfos.push({
      id: peerId,
      send: (d) => peer.send(d)
    });
    const offer = this._offers.get(offerId);
    if (offer) {
      offer.state = "connected";
      if (offer.timer) {
        clearTimeout(offer.timer);
        offer.timer = void 0;
      }
    }
    const sendState = {
      peer,
      peerId,
      queue: [],
      queuedBytes: 0,
      draining: false,
      connected: true
    };
    this._sendStates.set(peerId, sendState);
    this._attachDrainHandler(sendState);
    peer.on("data", (data) => {
      this._onMessage?.(data, peerId);
    });
    peer.on("close", () => {
      if (!this._peers.has(peerId)) return;
      peer.removeAllListeners("data");
      peer.removeAllListeners("close");
      const st = this._sendStates.get(peerId);
      if (st) {
        st.peer.removeAllListeners("drain");
        st.queue = [];
        this._sendStates.delete(peerId);
      }
      this._peers.delete(peerId);
      this._peerInfos = this._peerInfos.filter((p) => p.id !== peerId);
      this._onPeerLeave?.(peerId);
    });
    await this._onPeerJoin?.(peerId);
    this._onPeerConnect?.(peerId);
    this._flushQueue(sendState);
  }
};

// src/index.ts
async function createRoom(baseUrl = "", opts) {
  const room = new P2PRoom(true, baseUrl, opts);
  const result = await room.offerUrl();
  return { url: result.url, room };
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