// Auto-generated declaration file for @joverval/p2p-collab
// Manually maintained due to tsup dts failure with TypeScript 7.x
// Source of truth: src/types.ts, src/room.ts, src/signal.ts, src/index.ts

// ---- Signal ----
export interface SignalData {
  type?: 'offer' | 'answer';
  sdp?: string;
  candidate?: unknown;
}

export function encodeSignal(data: SignalData, baseUrl?: string): { url: string; sizeKB: number };
export function decodeSignal(input: string): SignalData | null;

// ---- Connection Diagnostics ----
export interface ConnectionRoute {
  kind: 'direct' | 'turn' | 'unknown';
  localCandidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  remoteCandidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  protocol?: string;
  relayProtocol?: string;
}

export interface BroadcastResult {
  accepted: number;
  total: number;
}

// ---- Peer Info ----
export interface PeerInfo {
  id: string;
  send: (data: string | Uint8Array) => void;
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

// ---- P2PRoom class ----
export class P2PRoom implements Room {
  readonly isHost: boolean;
  constructor(isHost: boolean, baseUrl: string, opts?: RoomOptions);
  offerUrl(): Promise<{ url: string; offerId: string }>;
  acceptAnswer(offerId: string, signalUrl: string): void;
  connectToHost(offerUrl: string): Promise<string>;
  send(data: string | Uint8Array): boolean;
  sendToPeer(peerId: string, data: string | Uint8Array): boolean;
  broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult;
  onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
  getConnectionRoute(peerId?: string): Promise<ConnectionRoute>;
  getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown';
  getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown';
  cancelOffer(offerId: string): void;
  readonly peers: PeerInfo[];
  close(): void;
}

// ---- Convenience functions ----
export function createRoom(baseUrl?: string, opts?: RoomOptions): Promise<CreateRoomResult>;
export function joinRoom(offerUrl: string, baseUrl?: string, opts?: RoomOptions): Promise<{ room: Room; answerUrl: string }>;
