export interface SignalData {
    type?: 'offer' | 'answer';
    sdp?: string;
    candidate?: unknown;
}
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
export type SendStatus = 'accepted' | 'queued' | 'rejected';
export interface SendResult {
    status: SendStatus;
    /** Bytes currently buffered on this peer's data channel, if connected */
    bufferedAmount?: number;
    /** Reason string, only present when rejected */
    reason?: string;
}
export interface BroadcastResult {
    accepted: number;
    queued: number;
    rejected: number;
    total: number;
}
export interface RoomOptions {
    rtcConfig?: RTCConfiguration;
    trickle?: boolean;
    iceMode?: IceMode;
    maxPendingOffers?: number;
    maxQueuedBytes?: number;
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
    send(data: string | Uint8Array): SendResult;
    sendToPeer(peerId: string, data: string | Uint8Array): SendResult;
    broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult;
    acceptAnswer(offerId: string, signalUrl: string): void;
    offerUrl(): Promise<{
        url: string;
        offerId: string;
    }>;
    connectToHost(offerUrl: string): Promise<string>;
    onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void;
    onPeerJoin(handler: (peerId: string) => void): void;
    getConnectionRoute(peerId?: string): Promise<ConnectionRoute>;
    getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown';
    getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown';
    cancelOffer(offerId: string): void;
    applySignal(connectionId: string, signal: SignalData): void;
    readonly peers: PeerInfo[];
    close(): void;
    readonly isHost: boolean;
}
export interface CreateRoomResult {
    url: string;
    room: Room;
}
