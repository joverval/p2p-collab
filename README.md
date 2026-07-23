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
  - `onPeerLeave?: (peerId: string) => void`
  - `onError?: (err: Error) => void`
  - `onClose?: () => void`

### Host Methods

#### `room.offerUrl() → Promise<{ url: string, offerId: string }>`

Generates a WebRTC offer. Returns a shareable URL with the SDP encoded in `#sdp=<base64>`. Each call creates a fresh offer for a new peer — supports multiple simultaneous peers.

#### `room.acceptAnswer(offerId: string, signalUrl: string)`

Accepts a peer's answer for a specific offer ID.

### Peer Methods

#### `room.connectToHost(offerUrl: string) → Promise<string>`

Connects to a host using their offer URL. Returns the answer URL to deliver back to the host.

### Shared Methods

#### `room.send(data: string | Uint8Array)`

Host: broadcasts to all connected peers. Peer: sends only to the host.

#### `room.onMessage(handler: (data: string | Uint8Array, peerId: string) => void)`

Receives data from peers (host) or the host (peer).

#### `room.onPeerJoin(handler: (peerId: string) => void)`

Called when a new peer connects (host only).

#### `room.close()`

Closes all connections.

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

### IceMode values for testing

| Mode        | ICE servers    | Policy  | Use case             |
|-------------|----------------|---------|----------------------|
| `stun-only` | STUN only      | `all`   | Default, direct P2P  |
| `all`       | STUN + TURN    | `all`   | Production fallback  |
| `turn-only` | TURN only      | `relay` | Testing/troubleshooting |

### Connection route detection

Inspect the selected ICE candidate pair at runtime:

```typescript
const route = await room.getConnectionRoute(peerId);
// { kind: 'direct' | 'turn' | 'unknown', localCandidateType, remoteCandidateType, protocol }
```

Available callbacks: `onConnectionStateChange` and `onIceConnectionStateChange`.

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