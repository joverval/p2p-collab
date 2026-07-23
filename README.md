# @joverval/p2p-collab

Browser-to-browser P2P collaboration library. Establishes WebRTC data channels between browsers using **URL-encoded SDP signaling** — no signaling server required. Built on [simple-peer](https://github.com/feross/simple-peer).

## Install

```bash
npm install @joverval/p2p-collab
```

For local development with a sibling project:

```bash
# In your app's package.json
"@joverval/p2p-collab": "file:../p2p-collab"

# In your vite.config.ts
resolve: {
  alias: {
    '@joverval/p2p-collab': path.resolve(__dirname, '../p2p-collab/dist/index.js'),
  },
},
```

> **Note for Vite users:** The `file:` dependency alone creates a symlink that Vite may not resolve correctly during builds. The `resolve.alias` is required for production builds.

## Quick Start

```typescript
import { P2PRoom } from '@joverval/p2p-collab';

// Host creates a room
const room = new P2PRoom(true, 'http://localhost:8080');
const { url, offerId } = await room.offerUrl();
// Share `url` with peers (copy-paste, QR, WebSocket relay, etc.)

// Peer joins using the URL
const peer = new P2PRoom(false, 'http://localhost:8080');
const answerUrl = await peer.connectToHost(offerUrl);
// Deliver `answerUrl` back to the host (out of band)
```

## API

### `new P2PRoom(isHost, baseUrl, options?)`

- `isHost: boolean`
- `baseUrl: string` — Base URL for SDP encoding
- `options?: RoomOptions`
  - `rtcConfig?: RTCConfiguration` — Custom ICE server configuration
  - `trickle?: boolean` — Enable trickle ICE (default: `false`)
  - `iceMode?: IceMode` — `'stun-only'` (no TURN), `'all'` (STUN+TURN), or `'turn-only'` (relay only)
  - `maxPendingOffers?: number` — Max simultaneous pending offers (default: 50)
  - `maxQueuedBytes?: number` — Max bytes queued per peer before rejection (default: 256 KB)
  - `onConnect?: () => void`
  - `onPeerConnect?: (peerId: string) => void`
  - `onPeerLeave?: (peerId: string) => void`
  - `onError?: (err: Error) => void`
  - `onClose?: () => void`
  - `onConnectionStateChange?: (state: RTCPeerConnectionState, peerId?: string) => void`
  - `onIceConnectionStateChange?: (state: RTCIceConnectionState, peerId?: string) => void`
  - `onSignal?: (data: SignalData) => void` — Called for trickle ICE signals

### Host Methods

#### `room.offerUrl() → Promise<{ url: string, offerId: string }>`

Generates a WebRTC offer. Returns a shareable URL with the SDP encoded in `#sdp=<base64>`. Each call creates a fresh offer for a new peer — supports multiple simultaneous peers.

#### `room.acceptAnswer(offerId: string, signalUrl: string)`

Accepts a peer's answer for a specific offer ID.

### Peer Methods

#### `room.connectToHost(offerUrl: string) → Promise<string>`

Connects to a host using their offer URL. Returns the answer URL to deliver back to the host.

### Shared Methods

#### `room.send(data: string | Uint8Array): SendResult`

Host: broadcasts to all connected peers. Peer: sends only to the host. Returns `{ status, bufferedAmount? }` — `status` is `'accepted'` (sent immediately), `'queued'` (buffered for later delivery), or `'rejected'` (no peers, queue full, or not connected).

#### `room.sendToPeer(peerId: string, data: string | Uint8Array): SendResult`

Host only: sends data to a specific peer by ID. Returns `{ status, bufferedAmount? }` — same semantics as `send()`.

#### `room.broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult`

Host only: broadcasts to all connected peers except the specified one. Returns `{ accepted, queued, rejected, total }` — counts of peers by delivery status.

#### `room.onMessage(handler: (data: string | Uint8Array, peerId: string) => void)`

Receives data from peers (host) or the host (peer).

#### `room.onPeerJoin(handler: (peerId: string) => void)`

Called when a new peer connects (host only).

#### `room.close()`

Closes all connections.

### Host-Only Methods

#### `room.cancelOffer(offerId: string): void`

Cancels a pending offer and destroys its peer connection. Use when a generated offer is no longer needed.

#### `room.applySignal(connectionId: string, signal: SignalData): void`

Feeds a trickle ICE signal to a specific connection. Host: `connectionId` is the peer or offer ID. Peer: `connectionId` must be `'host'`.

### Diagnostics

#### `room.getConnectionRoute(peerId?: string): Promise<ConnectionRoute>`

Inspect the selected ICE candidate pair at runtime. Returns connection metadata including whether the route is direct or relayed via TURN.

#### `room.getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown'`

Returns the current RTCPeerConnection state for a specific peer (host) or the host connection (peer).

#### `room.getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown'`

Returns the current ICE connection state for a specific peer (host) or the host connection (peer).

### `RoomOptions` Reference

| Option                      | Type                                                | Description                                      |
|-----------------------------|-----------------------------------------------------|--------------------------------------------------|
| `rtcConfig`                 | `RTCConfiguration`                                  | Custom ICE server configuration                  |
| `trickle`                   | `boolean`                                           | Enable trickle ICE (default: `false`)             |
| `iceMode`                   | `IceMode`                                           | ICE policy: `'stun-only'`, `'all'`, `'turn-only'`|
| `maxPendingOffers`          | `number`                                            | Max pending offers (default: 50)                 |
| `maxQueuedBytes`            | `number`                                            | Max queued bytes per peer (default: 256 KB)      |
| `onConnect`                 | `() => void`                                        | Called when peer connects to host                |
| `onPeerConnect`             | `(peerId: string) => void`                          | Called when a specific peer connects (host only) |
| `onPeerLeave`               | `(peerId: string) => void`                          | Called when a peer disconnects                   |
| `onError`                   | `(err: Error) => void`                              | Called on errors                                 |
| `onClose`                   | `() => void`                                        | Called when connection closes                    |
| `onConnectionStateChange`   | `(state: RTCPeerConnectionState, peerId?: string) => void` | Called on RTCPeerConnection state change   |
| `onIceConnectionStateChange`| `(state: RTCIceConnectionState, peerId?: string) => void` | Called on ICE connection state change     |
| `onSignal`                  | `(data: SignalData) => void`                        | Called for trickle ICE signals                   |

## ICE Configuration

Default is **STUN-only** -- no TURN servers included. Two public Google/Cloudflare STUN servers are configured for NAT traversal:

```typescript
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]
```

### Adding TURN

TURN is **application-provided** via the `rtcConfig` option. To use TURN as a fallback:

```typescript
const room = new P2PRoom(true, 'http://localhost', {
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: 'turn:your-turn-server:3478',
        username: 'username',
        credential: 'credential',
      },
    ],
    iceTransportPolicy: 'all', // prefers direct, falls back to relay
  },
});
```

> **Note:** Use `IceMode` to control ICE behavior. `'stun-only'` strips TURN servers (default safe mode), `'all'` allows STUN+TURN, and `'turn-only'` forces relay. You can also control behavior via `rtcConfig.iceTransportPolicy`.

## Architecture

```
Host (⭐)
  ├── Peer 1 (WebRTC data channel)
  ├── Peer 2 (WebRTC data channel)
  └── Peer N (WebRTC data channel)
```

**Signaling:** SDP offers/answers base64-encoded in URL fragments (`#sdp=...`). No server needed.

**Topology:** Host-star. One host, multiple peers. Host broadcasts all messages to all peers. Peers send only to host.

## License

MIT