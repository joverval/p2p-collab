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

// ---- Public API ----
export interface RoomOptions {
  rtcConfig?: RTCConfiguration;
  onConnect?: () => void;
  onPeerConnect?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface Room {
  send(data: string | Uint8Array): void;
  onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
  readonly peers: PeerInfo[];
  close(): void;
  readonly isHost: boolean;
}

export interface CreateRoomResult {
  url: string;
  room: Room;
}