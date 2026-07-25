# @joverval/p2p-collab

Browser-to-browser P2P collaboration library. Establishes WebRTC data channels with structured signaling — URL-encoded for manual mode, relay-friendly for automatic handshake. Built on [simple-peer](https://github.com/feross/simple-peer).

## Install

```bash
npm install @joverval/p2p-collab
```

For local development as a file dependency:

```bash
# In your app's package.json
"@joverval/p2p-collab": "file:../p2p-collab"
```

## Quick Start

```typescript
import { P2PRoom } from '@joverval/p2p-collab';

// Host
const room = new P2PRoom(true, { iceMode: 'all' });
const { offerId, signal } = await room.createOffer();
// Deliver signal to peer (relay, paste, QR, etc.)

// Peer
const peer = new P2PRoom(false, { iceMode: 'all' });
const { connectionId, signal: answer } = await peer.createAnswer(offerSignal);
// Deliver answer back to host
peer.applySignal(connectionId, answer);

// Host receives answer
room.acceptAnswerSignal(offerId, answerSignal);
```

## API

### Constructor

`new P2PRoom(isHost: boolean, options?: RoomOptions)`

**RoomOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rtcConfig` | `RTCConfiguration` | STUN-only | Custom ICE servers. TURN must be app-provided. |
| `iceMode` | `IceMode` | `'stun-only'` | `'stun-only'`, `'all'`, or `'turn-only'` |
| `trickle` | `boolean` | `false` | Enable trickle ICE signaling |
| `maxPendingOffers` | `number` | `50` | Max simultaneous pending offers |
| `maxQueuedBytes` | `number` | `256KB` | Max bytes queued per peer before rejection |
| `offerTimeoutMs` | `number` | — | Auto-cancel expired offers |

**Callbacks:**

| Callback | Signature |
|----------|-----------|
| `onConnect` | `() => void` |
| `onPeerConnect` | `(peerId: string) => void` |
| `onPeerLeave` | `(peerId: string) => void` |
| `onOfferAnswered` | `(offerId: string) => void` |
| `onError` | `(err: Error) => void` |
| `onClose` | `() => void` |
| `onConnectionStateChange` | `(state: RTCPeerConnectionState, connectionId?: string) => void` |
| `onIceConnectionStateChange` | `(state: RTCIceConnectionState, connectionId?: string) => void` |
| `onSignal` | `(data: SignalData) => void` |

### Host Methods

#### `createOffer() → Promise<{ offerId: string, signal: SignalData }>`

Generates a WebRTC offer. Returns structured signal data. Each call creates a fresh offer — supports multiple simultaneous peers.

#### `acceptAnswerSignal(offerId: string, signal: SignalData): void`

Accepts a peer's answer for a specific offer. Valid only when offer is in 'pending' state. Throws `OFFER_ALREADY_ANSWERED` on duplicate.

#### `cancelOffer(offerId: string): void`

Cancels a pending offer and destroys its peer connection. Idempotent.

#### `offerUrl() → Promise<{ url: string, offerId: string }>`

Legacy URL-encoded signaling (manual copy-paste mode).

### Peer Methods

#### `createAnswer(signal: SignalData) → Promise<{ connectionId: string, signal: SignalData }>`

Creates an answer from a received offer signal. Returns answer signal for delivery back to host.

#### `applySignal(connectionId: string, signal: SignalData): void`

Applies a signal to an existing connection — used for answer delivery and trickle ICE candidates.

### Shared Methods

#### `send(data: string | Uint8Array): SendResult`

Host: broadcasts to all connected peers. Peer: sends to host. Returns `{ status: 'accepted' | 'queued' | 'rejected', bufferedAmount? }`. Pre-connect data is queued up to `maxQueuedBytes`.

#### `sendToPeer(peerId: string, data: string | Uint8Array): SendResult`

Host only: sends to a specific peer. Same return semantics as `send()`.

#### `broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): BroadcastResult`

Host only: broadcasts to all peers except one. Returns `{ accepted, queued, rejected, total }`.

#### `onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void`

Receives data from peers (host) or host (peer).

#### `close(): void`

Closes all connections, cancels all pending offers, cleans all state.

### Diagnostics

#### `getConnectionRoute(peerId?: string): Promise<ConnectionRoute>`

Inspects selected ICE candidate pair. Returns `{ kind: 'direct' | 'turn' | 'unknown', localCandidateType, remoteCandidateType, protocol, relayProtocol? }`. Never exposes IPs or credentials.

#### `getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown'`

#### `getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown'`

#### `getIceConfigurationSummary(): { mode, transportPolicy, stunServerCount, turnServerCount, hasTurnCredentials }`

#### `getCandidateSummary(): { host, srflx, relay, udp, tcp }`

Counts only — no raw candidates, IPs, or credentials exposed.

## ICE Configuration

Default is **STUN-only** — no TURN servers. The library never ships with hardcoded TURN credentials.

```typescript
// Default (applied when no rtcConfig provided)
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]
```

### Adding TURN

TURN is **application-provided** via `rtcConfig`. The library does not fetch or cache credentials.

```typescript
const room = new P2PRoom(true, {
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: 'turn:turn.example.com:3478',
        username: 'short-lived-username',
        credential: 'short-lived-password',
      },
    ],
  },
  iceMode: 'all', // preserves TURN and allows relay fallback
});
```

### IceMode

| Mode | Behavior |
|------|----------|
| `'stun-only'` | Strips all `turn:`/`turns:` URLs. Forces `transportPolicy='all'`. |
| `'all'` | Preserves provided configuration. Default `transportPolicy='all'`. |
| `'turn-only'` | Forces `transportPolicy='relay'`. Throws `TURN_REQUIRED` if no TURN configured. |

## Security

- **No hardcoded credentials.** The library never includes TURN usernames, passwords, or API keys.
- **Diagnostics are safe.** `getConnectionRoute()`, `getCandidateSummary()`, and `getIceConfigurationSummary()` never expose IP addresses, SDP, or credentials.
- **TURN is app-provided.** Credentials come from the consuming application — never fetched or cached by this library.

## Architecture

```
Host (⭐)
  ├── Peer 1 (WebRTC data channel)
  ├── Peer 2 (WebRTC data channel)
  └── Peer N (WebRTC data channel)
```

**Signaling:** Structured API for relay-based handshake. Legacy URL encoding available for manual copy-paste mode.

**Topology:** Host-star. One host, multiple peers. Host broadcasts, peers send to host.

## License

MIT