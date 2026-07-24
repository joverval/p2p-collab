import type { Room, RoomOptions, PeerInfo, SignalData, ConnectionRoute, BroadcastResult, SendResult } from './types';
export declare class P2PRoom implements Room {
    readonly isHost: boolean;
    private _pendingOffers;
    private _offerTimers;
    private _peers;
    private _peerInfos;
    private _sendStates;
    private _answeredOffers;
    private _peer?;
    private _hostSendState?;
    private _onMessage?;
    private _onPeerJoin?;
    private readonly _onPeerConnect?;
    private readonly _onPeerLeave?;
    private readonly _onConnect?;
    private readonly _onError?;
    private readonly _onClose?;
    private readonly _onConnectionStateChange?;
    private readonly _onIceConnectionStateChange?;
    private readonly _onSignal?;
    private readonly _baseUrl;
    private readonly _rtcConfig;
    private readonly _trickle;
    private readonly _maxPendingOffers;
    private readonly _maxQueuedBytes;
    constructor(isHost: boolean, baseUrl: string, opts?: RoomOptions);
    /** Generate an offer for a new peer. Host only. Returns { url, offerId }. */
    offerUrl(): Promise<{
        url: string;
        offerId: string;
    }>;
    /** Accept a peer's answer for a specific offer. Host only. */
    acceptAnswer(offerId: string, signalUrl: string): void;
    /** Cancel a pending offer and destroy its peer. Host only. */
    cancelOffer(offerId: string): void;
    /** Feed a signal to a specific connection. Host uses offerId; peer uses 'host'. */
    applySignal(connectionId: string, signal: SignalData): void;
    /** Connect to host using offer URL. Peer only. Returns answer URL promise. */
    connectToHost(offerUrl: string): Promise<string>;
    get peers(): PeerInfo[];
    send(data: string | Uint8Array): SendResult;
    sendToPeer(peerId: string, data: string | Uint8Array): SendResult;
    broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult;
    onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void;
    onPeerJoin(handler: (peerId: string) => void): void;
    close(): void;
    getConnectionRoute(peerId?: string): Promise<ConnectionRoute>;
    getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown';
    getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown';
    private _getPC;
    private _attachStateCallbacks;
    private _attachDrainHandler;
    private _sendToState;
    private _enqueue;
    private _flushQueue;
    private _onPeerConnected;
}
