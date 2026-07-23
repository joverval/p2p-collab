// ---- Signal ----
export interface SignalData {
  type?: 'offer' | 'answer';
  sdp?: string;
  candidate?: unknown;
}

// ---- Peer Info ----
export interface PeerInfo {
  id: string;
  send: (data: string | Uint8Array) => void;
}

export interface ConnectionRoute {
  kind: 'direct' | 'turn' | 'unknown';
  localCandidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  remoteCandidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  protocol?: string;
  relayProtocol?: string;
}

export type IceMode = 'stun-only' | 'all' | 'turn-only';

export interface BroadcastResult {
  accepted: number;
  total: number;
}

// ---- Public API ----
export interface RoomOptions {
  rtcConfig?: RTCConfiguration;
  trickle?: boolean;
  onConnect?: () => void;
  onPeerConnect?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState, peerId?: string) => void;
  onIceConnectionStateChange?: (state: RTCIceConnectionState, peerId?: string) => void;
  onSignal?: (data: SignalData) => void;
}

export interface Room {
  send(data: string | Uint8Array): boolean;
  sendToPeer(peerId: string, data: string | Uint8Array): boolean;
  broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult;
  acceptAnswer(offerId: string, signalUrl: string): void;
  offerUrl(): Promise<{ url: string; offerId: string }>;
  connectToHost(offerUrl: string): Promise<string>;
  onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
  getConnectionRoute(peerId?: string): Promise<ConnectionRoute>;
  getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown';
  getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown';
  cancelOffer(offerId: string): void;
  readonly peers: PeerInfo[];
  close(): void;
  readonly isHost: boolean;
}

export interface CreateRoomResult {
  url: string;
  room: Room;
}