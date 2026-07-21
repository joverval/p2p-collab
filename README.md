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

# In your vite.config.ts (if using Vite)
resolve: {
  alias: {
    '@joverval/p2p-collab': path.resolve(__dirname, '../p2p-collab/dist/index.js'),
  },
},
```

> **Note for Vite users:** The `file:` dependency alone creates a symlink that Vite's bundler (Rolldown) may not resolve correctly during builds. The `resolve.alias` in `vite.config.ts` is required for production builds. During development (`vite dev`), the symlink is sufficient.

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

Creates a room instance.

- `isHost: boolean` — `true` for the host, `false` for a peer
- `baseUrl: string` — Base URL for SDP encoding (e.g., `'http://localhost:8080'`)
- `options?: RoomOptions` — Optional callbacks:
  - `onPeerLeave?: (peerId: string) => void`
  - `onError?: (err: Error) => void`
  - `onClose?: () => void`

### Host Methods

#### `room.offerUrl() → Promise<{ url: string, offerId: string }>`

Generates a WebRTC offer and returns a shareable URL. The URL contains the SDP offer encoded in the fragment (`#sdp=<base64>`). Each call generates a new offer for a different peer.

```typescript
const { url, offerId } = await room.offerUrl();
// url: "http://localhost:8080/#sdp=eyJ0eXBlIjoib2ZmZX..."
// offerId: "offer-1"
```

#### `room.acceptAnswer(offerId: string, signalUrl: string)`

Accepts a peer's answer for a specific offer.

```typescript
room.acceptAnswer('offer-1', '#sdp=eyJ0eXBlIjoiYW5zd2Vy...');
```

### Peer Methods

#### `room.connectToHost(offerUrl: string) → Promise<string>`

Connects to a host using their offer URL. Returns the answer URL to deliver back to the host.

```typescript
const answerUrl = await peer.connectToHost(hostOfferUrl);
// Deliver answerUrl to the host via any out-of-band channel
```

### Shared Methods

#### `room.send(data: string | Uint8Array)`

Sends data. On the host, broadcasts to **all** connected peers. On a peer, sends only to the host.

```typescript
room.send('hello');
room.send(new Uint8Array([1, 2, 3]));
```

#### `room.onMessage(handler)`

Receives data from peers (host) or the host (peer).

```typescript
room.onMessage((data, peerId) => {
  // data: string | Uint8Array
  // peerId: "peer-1", "peer-2", ... or "host"
});
```

#### `room.onPeerJoin(handler)`

Called when a new peer connects (host only).

```typescript
room.onPeerJoin((peerId) => {
  console.log(`Peer ${peerId} connected`);
});
```

#### `room.peers`

Array of currently connected peers. Each entry: `{ id: string, send: (data) => void }`.

#### `room.close()`

Closes all connections and cleans up.

### Properties

- `room.isHost: boolean`
- `room.peers: PeerInfo[]`

## Architecture

```
┌──────────────────────────────────────┐
│           Your App                    │
│  (Yjs, chat, file editing, etc.)     │
├──────────────────────────────────────┤
│         p2p-collab                    │
│  ┌──────────┐ ┌────────────────────┐ │
│  │ Signaling│ │ WebRTC (simple-peer)│ │
│  │ URL SDP  │ │ Host-star topology  │ │
│  └──────────┘ └────────────────────┘ │
├──────────────────────────────────────┤
│         Browser APIs                  │
│  RTCPeerConnection, DataChannel       │
└──────────────────────────────────────┘
```

**Signaling:** SDP offers and answers are base64-encoded into URL fragments (`#sdp=...`). No signaling server needed — URLs can be shared via any channel (messaging apps, QR codes, email, copy-paste).

**Topology:** Host-star. One host maintains separate WebRTC connections to each peer. Messages from the host are broadcast to all peers. Messages from peers are sent to the host (which can relay them to other peers).

**Multi-peer:** The host can generate multiple offers (each with a unique `offerId`) to accept multiple peers. Each new `offerUrl()` call creates a fresh offer for a new peer.

## Development

```bash
npm install
npm run build    # Build with tsup (CJS + ESM)
npm test         # Run 22 unit tests (vitest)
npm run dev      # Watch mode
```

## License

MIT