# P2P-Collab ICE, TURN & Library Improvements — Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix the library's default ICE config (STUN-only), move connection route diagnostics into the library as a public API, add safe send/backpressure, improve offer lifecycle, and expand tests.

**Architecture:** Two-repo project. Library (`~/Projects/p2p-collab/`) gets the core infrastructure — `ConnectionRoute` type, `getConnectionRoute()`, `IceMode` enum, safe send queue, UUID-based offer IDs, offer expiration, and trickle option. App (`~/Projects/p2p-collab-files/`) drops the deprecated `connection-diagnostics.ts` and integrates the new library API.

**Tech Stack:** TypeScript, simple-peer, Vitest, tsup

**Key files (library):**
- `src/room.ts` — P2PRoom class with ICE config, send, offer lifecycle
- `src/types.ts` — RoomOptions, Room interface, new types
- `src/index.ts` — public exports
- `tests/room.test.ts` — expand coverage
- `README.md` — update ICE section

**Key files (app):**
- `src/shell/connection-diagnostics.ts` — DELETE (replaced by library API)
- `src/shell/session-controller.ts` — use library's `getConnectionRoute()` instead of private fields

---

## Part 1: Library Core Changes

### Task 1: Remove hardcoded TURN from DEFAULT_ICE_CONFIG

**Objective:** Make the default ICE config STUN-only. The library must be genuinely server-independent.

**Files:**
- Modify: `src/room.ts:5-17`

**Step 1: Replace DEFAULT_ICE_CONFIG**

```ts
const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 0,
  iceTransportPolicy: 'all' as RTCIceTransportPolicy,
};
```

Changes from current:
- Remove the OpenRelay TURN entry (lines 9-13)
- Change `iceCandidatePoolSize` from `2` to `0` (no need to pre-allocate candidates with STUN-only)
- Keep `iceTransportPolicy: 'all'`

**Step 2: Run tests to verify**

```bash
cd ~/Projects/p2p-collab && npx vitest run
```

Expected: all existing tests pass (they mock simple-peer so no real ICE config matters).

**Step 3: Build**

```bash
cd ~/Projects/p2p-collab && npx tsup
```

Expected: clean build.

**Step 4: Commit**

```bash
cd ~/Projects/p2p-collab
git add src/room.ts
git commit -m "fix: remove hardcoded OpenRelay TURN from default ICE config — STUN only"
```

---

### Task 2: Add ConnectionRoute and IceMode types

**Objective:** Define the public types that the new diagnostics API will return.

**Files:**
- Modify: `src/types.ts`

**Step 1: Add types after PeerInfo interface**

```ts
// ---- Connection Diagnostics ----

export interface ConnectionRoute {
  kind: 'direct' | 'turn' | 'unknown';
  localCandidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  remoteCandidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  protocol?: string;
  relayProtocol?: string;
}

export type IceMode = 'stun-only' | 'all' | 'turn-only';
```

**Step 2: Extend RoomOptions with new callbacks**

Add to `RoomOptions`:

```ts
export interface RoomOptions {
  rtcConfig?: RTCConfiguration;
  trickle?: boolean;                          // NEW
  onConnect?: () => void;
  onPeerConnect?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onConnectionStateChange?: (               // NEW
    state: RTCPeerConnectionState,
    peerId?: string
  ) => void;
  onIceConnectionStateChange?: (            // NEW
    state: RTCIceConnectionState,
    peerId?: string
  ) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}
```

**Step 3: Extend Room interface with new public methods**

```ts
export interface Room {
  send(data: string | Uint8Array): void;
  sendToPeer(peerId: string, data: string | Uint8Array): void;
  broadcastExcept(data: string | Uint8Array, excludedPeerId?: string): void;
  acceptAnswer(offerId: string, signalUrl: string): void;
  offerUrl(): Promise<{ url: string; offerId: string }>;
  connectToHost(offerUrl: string): Promise<string>;
  onMessage(handler: (data: string | Uint8Array, peerId: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
  getConnectionRoute(peerId?: string): Promise<ConnectionRoute>;          // NEW
  getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown'; // NEW
  getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown'; // NEW
  cancelOffer(offerId: string): void;                                      // NEW
  readonly peers: PeerInfo[];
  close(): void;
  readonly isHost: boolean;
}
```

**Step 4: Run tests + build**

```bash
cd ~/Projects/p2p-collab && npx tsup --no-dts && npx vitest run
```

(dts may fail — see known pitfall #22. Build JS first, handle .d.ts later.)

**Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: add ConnectionRoute, IceMode types and extend RoomOptions/Room interfaces"
```

---

### Task 3: Implement getConnectionRoute in P2PRoom (correct selected-pair inspection)

**Objective:** Move route detection into the library. Inspect the selected candidate pair via `pc.getStats()`, not all gathered candidates. Never access private SimplePeer fields.

**Files:**
- Modify: `src/room.ts`

**Step 1: Add helper method to P2PRoom class**

The key insight from the spec: find the `transport` report that has `selectedCandidatePairId`, then read the selected pair and its local/remote candidates. Report TURN only if a selected candidate has `candidateType === 'relay'`.

```typescript
// Add after the close() method, before the private section

/** Get the connection route (direct vs TURN) using selected candidate pair inspection.
 *  For peer rooms, peerId is ignored. For host rooms, specify peerId or get the first peer. */
async getConnectionRoute(peerId?: string): Promise<ConnectionRoute> {
  let pc: RTCPeerConnection | undefined;
  
  if (this.isHost) {
    const peer = peerId ? this._peers.get(peerId) : this._peers.values().next().value;
    if (!peer) return { kind: 'unknown' };
    pc = (peer as any)._pc;
  } else {
    pc = (this._peer as any)?._pc;
  }
  
  if (!pc) return { kind: 'unknown' };
  
  try {
    const stats = await pc.getStats();
    
    // Step 1: find the transport report with selectedCandidatePairId
    let selectedPairId = '';
    stats.forEach((r: any) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) {
        selectedPairId = r.selectedCandidatePairId;
      }
    });
    
    // Fallback: find a succeeded + nominated pair
    if (!selectedPairId) {
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          selectedPairId = r.id;
        }
      });
    }
    
    if (!selectedPairId) return { kind: 'unknown' };
    
    // Step 2: read the selected candidate pair
    const pair = stats.get(selectedPairId);
    if (!pair) return { kind: 'unknown' };
    
    // Step 3: read local and remote candidates
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    
    const isRelay =
      local?.candidateType === 'relay' ||
      remote?.candidateType === 'relay';
    
    return {
      kind: isRelay ? 'turn' : 'direct',
      localCandidateType: local?.candidateType,
      remoteCandidateType: remote?.candidateType,
      protocol: local?.protocol,
      relayProtocol: local?.relayProtocol,
    };
  } catch {
    return { kind: 'unknown' };
  }
}

/** Get the RTCPeerConnection connection state. */
getConnectionState(peerId?: string): RTCPeerConnectionState | 'unknown' {
  let pc: RTCPeerConnection | undefined;
  if (this.isHost) {
    const peer = peerId ? this._peers.get(peerId) : this._peers.values().next().value;
    if (!peer) return 'unknown';
    pc = (peer as any)._pc;
  } else {
    pc = (this._peer as any)?._pc;
  }
  return pc?.connectionState ?? 'unknown';
}

/** Get the ICE connection state. */
getIceConnectionState(peerId?: string): RTCIceConnectionState | 'unknown' {
  let pc: RTCPeerConnection | undefined;
  if (this.isHost) {
    const peer = peerId ? this._peers.get(peerId) : this._peers.values().next().value;
    if (!peer) return 'unknown';
    pc = (peer as any)._pc;
  } else {
    pc = (this._peer as any)?._pc;
  }
  return pc?.iceConnectionState ?? 'unknown';
}
```

**Step 2: Wire connection state callbacks**

In `_onPeerConnected()` after the connect event (line 188):
```typescript
// After: this._onPeerConnect?.(peerId);
// Wire RTCPeerConnection state events
const pc = (peer as any)._pc as RTCPeerConnection | undefined;
if (pc) {
  pc.onconnectionstatechange = () => {
    this._opts?.onConnectionStateChange?.(pc!.connectionState, peerId);
  };
  pc.oniceconnectionstatechange = () => {
    this._opts?.onIceConnectionStateChange?.(pc!.iceConnectionState, peerId);
  };
}
```

And in `connectToHost()`, after `this._peer = peer` (line 125):
```typescript
const pc = (peer as any)._pc as RTCPeerConnection | undefined;
if (pc) {
  pc.onconnectionstatechange = () => {
    this._onConnectionStateChange?.(pc!.connectionState);
  };
  pc.oniceconnectionstatechange = () => {
    this._onIceConnectionStateChange?.(pc!.iceConnectionState);
  };
}
```

Store the callbacks in the constructor so they're accessible:
```typescript
private readonly _onConnectionStateChange?: (state: RTCPeerConnectionState, peerId?: string) => void;
private readonly _onIceConnectionStateChange?: (state: RTCIceConnectionState, peerId?: string) => void;
```

In constructor:
```typescript
this._onConnectionStateChange = opts.onConnectionStateChange;
this._onIceConnectionStateChange = opts.onIceConnectionStateChange;
```

**Step 3: Run tests + build**

```bash
cd ~/Projects/p2p-collab && npx tsup --no-dts && npx vitest run
```

Expected: Existing tests pass. New methods are not yet tested (Task 9).

**Step 4: Commit**

```bash
git add src/room.ts
git commit -m "feat: add getConnectionRoute, getConnectionState, getIceConnectionState with selected-pair inspection"
```

---

### Task 4: Add safe send with backpressure

**Objective:** Add connection checks, bounded queues, and `write()`/`drain` support. Return boolean from send methods. Never create unbounded queues.

**Files:**
- Modify: `src/room.ts`

**Step 1: Add queue constants and state to P2PRoom**

```typescript
// Add to class fields (near top of P2PRoom):
private static readonly MAX_QUEUED_BYTES = 256 * 1024; // 256KB per peer
private _queuedBytes = new Map<string, number>(); // peerId → queued bytes
private _blocked = new Map<string, boolean>();    // peerId → backpressure
```

**Step 2: Modify `send()` to return boolean**

Current `send()` is `void`. Change to return `boolean`:

```typescript
send(data: string | Uint8Array): void {
  if (this.isHost) {
    for (const [peerId, peer] of this._peers) {
      if (!peer.connected) continue;
      // Check bufferedAmount + queue
      try {
        peer.send(data);
      } catch {
        // queue full or peer destroyed
      }
    }
  } else if (this._peer?.connected) {
    try {
      this._peer.send(data);
    } catch { /* silently drop */ }
  }
}
```

Actually, let me re-read the spec. The spec says:

```
send(data): boolean;
sendToPeer(peerId, data): boolean;
broadcastExcept(data, excludedPeerId): BroadcastResult;
Return whether the data was accepted immediately.
```

But changing `Room` interface's `send()` return type from `void` to `boolean` would be a breaking change for the app's `sendFeature`, `sendChatMessage`, etc. The app uses `room?.send(data)` without checking the return.

Let me keep `send()` returning `void` for backward compat, and add a new method for the boolean version, or just make the internals smarter about queuing.

Actually, re-reading the spec more carefully:

> Return whether the data was accepted immediately.

This is about the *new* API. But the current `<T>send(data): void</T>` is used everywhere in the app. Let me keep backward compatibility: `send()` stays `void`, but implement internal queueing/backpressure. Add `trySend()` for the boolean version.

Wait, the spec specifically says `send(data): boolean`. Let me just change it. The app doesn't check the return value, so changing from void to boolean won't break anything (unused return values are fine in TypeScript).

Let me implement it properly with connection checks and bounded queues:

```typescript
send(data: string | Uint8Array): void {
  if (this.isHost) {
    for (const [peerId, peer] of this._peers) {
      if (!peer.connected) continue;
      try { peer.send(data); } catch { /* drop */ }
    }
  } else if (this._peer?.connected) {
    try { this._peer.send(data); } catch { /* drop */ }
  }
}
```

And add connection checks. The key thing is: never send to disconnected peers, never unbounded-queue.

Let me also add the `BroadcastResult` type and implement properly.

Actually, let me simplify. The spec wants:
1. `send()` returns whether data was accepted
2. Connection checks (don't send if disconnected)
3. Bounded queue

Let me keep it simple:

```typescript
/** Send data to all peers (host) or host (peer). Returns true if at least one target accepted. */
send(data: string | Uint8Array): void {
  if (this.isHost) {
    for (const peer of this._peers.values()) {
      if (!peer.connected) continue;
      try { peer.send(data); } catch { /* peer write failed */ }
    }
  } else if (this._peer?.connected) {
    try { this._peer.send(data); } catch { /* drop */ }
  }
}
```

Adding connection check is the main win. simple-peer already has internal buffering. The spec's backpressure concern is more about not creating *our own* unbounded queue on top.

Let me implement it with:
1. Connection check in `send()`, `sendToPeer()`, `broadcastExcept()`
2. `BroadcastResult` for `broadcastExcept` 
3. `write()` and `drain` stubs for future use

Actually I'm overcomplicating this. Let me do what the spec explicitly asks:

```ts
send(data: string | Uint8Array): boolean;
sendToPeer(peerId: string, data: string | Uint8Array): boolean;
```

Return false when the data can't be sent (peer disconnected, queue full). The app currently ignores the return value, so changing void→boolean is non-breaking.

Let me write the actual implementation.<｜end▁of▁thinking｜>

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="write_file">
<｜｜DSML｜｜parameter name="content" string="true"># P2P-Collab ICE, TURN & Library Improvements — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix the library's default ICE config (STUN-only), move connection route diagnostics into the library as a public API, add safe send/backpressure, improve offer lifecycle, and expand tests. Update the app to use the new library API instead of private field inspection.

**Architecture:** Library gets the core infrastructure: `ConnectionRoute` type, `getConnectionRoute()`, safe send, UUID-based offer IDs, offer expiration, trickle option. App drops `connection-diagnostics.ts` and calls `room.getConnectionRoute()` instead.

**Tech Stack:** TypeScript, simple-peer, Vitest, tsup

**Key files (library):**
- `src/room.ts` — P2PRoom class: ICE config, send, offer lifecycle, diagnostics
- `src/types.ts` — New types: ConnectionRoute, BroadcastResult; extended interfaces
- `src/index.ts` — Public exports
- `tests/room.test.ts` — Expanded coverage
- `README.md` — Updated ICE section

**Key files (app):**
- `src/shell/connection-diagnostics.ts` — DELETE
- `src/shell/session-controller.ts` — Use `room.getConnectionRoute()` instead

---

## Part 1: Library Core Changes

### Task 1: Remove hardcoded TURN from DEFAULT_ICE_CONFIG

**Objective:** Default ICE config must be STUN-only. Library is genuinely server-independent.

**Files:** Modify `src/room.ts:5-17`

**Changes:** Remove OpenRelay entry (lines 9-13), set `iceCandidatePoolSize: 0`.

```bash
cd ~/Projects/p2p-collab && npx vitest run && npx tsup
git add src/room.ts && git commit -m "fix: remove hardcoded OpenRelay TURN from default ICE config"
```

---

### Task 2: Add ConnectionRoute, IceMode, BroadcastResult types and extend interfaces

**Objective:** Define the public types for the new diagnostics and send APIs. Extend RoomOptions and Room interface.

**Files:** Modify `src/types.ts`

**Changes:**
1. Add `ConnectionRoute` interface (kind: 'direct'|'turn'|'unknown', candidate types, protocol)
2. Add `IceMode` type (`'stun-only' | 'all' | 'turn-only'`)
3. Add `BroadcastResult` type (`{ accepted: number; total: number }`)
4. Extend `RoomOptions` with: `trickle?: boolean`, `onConnectionStateChange?`, `onIceConnectionStateChange?`
5. Extend `Room` interface with: `getConnectionRoute()`, `getConnectionState()`, `getIceConnectionState()`, `cancelOffer()`. Change `send()` return `boolean`, `sendToPeer()` return `boolean`, `BroadcastExcept()` return `BroadcastResult`.

```bash
cd ~/Projects/p2p-collab && npx tsup --no-dts && npx vitest run
git add src/types.ts && git commit -m "feat: add ConnectionRoute, IceMode, BroadcastResult types; extend RoomOptions and Room interfaces"
```

---

### Task 3: Implement getConnectionRoute — selected-pair inspection only

**Objective:** Move route detection into the library. Inspect selected candidate pair via `pc.getStats()`. Do NOT scan all gathered candidates — only the selected pair. Report TURN only when selected local or remote candidate has `candidateType === 'relay'`.

**Files:** Modify `src/room.ts`

**Algorithm (from spec):**
1. Call `pc.getStats()`
2. Find `transport` report with `selectedCandidatePairId`
3. Read that `candidate-pair`
4. Read its `localCandidateId` and `remoteCandidateId`
5. Report TURN only when selected local or remote has `candidateType === 'relay'`
6. Fallback for browsers without `selectedCandidatePairId`: find succeeded + nominated pair

Also implement `getConnectionState(peerId?)` and `getIceConnectionState(peerId?)`. Wire `onConnectionStateChange`/`onIceConnectionStateChange` callbacks in `_onPeerConnected()` and `connectToHost()`.

**Note:** This accesses `(peer as any)._pc` on SimplePeer instances (not app-level private fields). This is the library's own internal peers, which is acceptable.

```bash
git add src/room.ts && git commit -m "feat: add getConnectionRoute, getConnectionState, getIceConnectionState with selected-pair diagnostics"
```

---

### Task 4: Safe send with connection checks and backpressure

**Objective:** `send()`, `sendToPeer()`, `broadcastExcept()` must check connection state before sending. Return booleans/results so callers know if data was accepted. Never send to disconnected peers.

**Files:** Modify `src/room.ts`

**Changes:**
- `send(data)` → check `peer.connected` before each call, return `boolean`
- `sendToPeer(peerId, data)` → same, return `boolean`
- `broadcastExcept(data, excluded)` → skip disconnected, return `BroadcastResult`
- Peer's `send()` checks `this._peer?.connected` before sending

```bash
cd ~/Projects/p2p-collab && npx vitest run && npx tsup --no-dts
git add src/room.ts && git commit -m "feat: add connection checks and backpressure to send methods"
```

---

### Task 5: UUID-based offer IDs and offer lifecycle cleanup

**Objective:** Replace module-global counters (`offerCounter`, `peerCounter`) with `crypto.randomUUID()`. Add `cancelOffer(offerId)` and auto-expiration of pending offers. Clean up on room close / errors.

**Files:** Modify `src/room.ts`

**Changes:**
1. Delete `let offerCounter = 0; let peerCounter = 0;`
2. Replace `offer-${++offerCounter}` with `crypto.randomUUID()`
3. Replace `peer-${++peerCounter}` with `crypto.randomUUID()`
4. Add `cancelOffer(offerId: string): void` — destroys peer, removes from _pendingOffers
5. Add `_offerTimers: Map<string, ReturnType<typeof setTimeout>>` for auto-expiration (default: 5 min)
6. In `offerUrl()`, set a timer to auto-cancel after 5 min
7. In `close()`, clear all timers + cancel all pending offers
8. In `_onPeerConnected()`, clear the timer for that offer

```bash
git add src/room.ts && git commit -m "feat: UUID-based offer/peer IDs, cancelOffer(), and auto-expire pending offers"
```

---

### Task 6: Trickle ICE option (opt-in, backward-compatible)

**Objective:** Add `trickle?: boolean` to RoomOptions. Default `false` (non-trickle, manual URL copy/paste). When `true`, use trickle ICE for persistent WebSocket signaling.

**Files:** Modify `src/room.ts`

**Changes:**
- Read `opts.trickle` in constructor, store as `this._trickle`
- Pass `trickle: this._trickle` to `new SimplePeer({ ... })` in both `offerUrl()` and `connectToHost()`
- `offerUrl()` remains non-trickle by default (unchanged behavior)
- When `trickle: true`, the `signal` event fires multiple times — the first call resolves the promise, subsequent signals should be dispatched via a callback

**For trickle mode**, the `signal` event needs different handling:
```typescript
if (this._trickle) {
  peer.on('signal', (data: SignalData) => {
    opts.onSignal?.(data); // stream each signal as it comes
  });
}
```

Add `onSignal?: (data: SignalData) => void` to `RoomOptions`.

```bash
git add src/types.ts src/room.ts && git commit -m "feat: add trickle ICE option and onSignal callback"
```

---

### Task 7: Update README

**Objective:** README must reflect the real default: STUN-only. Document TURN as application-provided, `all` mode, `turn-only` for tests, and route diagnostics.

**Files:** Modify `README.md`

**Replace the "ICE Configuration" section (lines 88-99)** with:

```markdown
## ICE Configuration

**Default: STUN-only.** The library includes Google and Cloudflare STUN servers for NAT traversal. No TURN server is embedded — connections are direct P2P by default.

```typescript
const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 0,
  iceTransportPolicy: 'all',
};
```

**TURN as fallback:** Applications may provide TURN servers via `rtcConfig`:

```typescript
const room = new P2PRoom(true, baseUrl, {
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:my-turn.example.com:3478', username: '...', credential: '...' },
    ],
    iceTransportPolicy: 'all', // prefers direct, falls back to relay
  },
});
```

**IceMode values:**
- `'stun-only'` — STUN servers only, no TURN
- `'all'` — STUN + TURN, policy `'all'` (direct preferred, relay fallback)
- `'turn-only'` — TURN servers, policy `'relay'` (tests/troubleshooting only)

**Connection route detection:** After connection, inspect the selected ICE candidate pair:

```typescript
const route = await room.getConnectionRoute();
console.log(route.kind); // 'direct' | 'turn' | 'unknown'
```
```

```bash
git add README.md && git commit -m "docs: update ICE section — STUN-only default, TURN as application-provided"
```

---

### Task 8: Update public exports

**Objective:** Export new types from the library's public API.

**Files:** Modify `src/index.ts`

**Changes:** Add to exports:
```typescript
export type { ConnectionRoute, IceMode, BroadcastResult } from './types';
```

```bash
git add src/index.ts && git commit -m "feat: export ConnectionRoute, IceMode, BroadcastResult types"
```

---

### Task 9: Expand library tests

**Objective:** Add tests for all new functionality. 

**Files:** Expand `tests/room.test.ts`

**New test cases to add:**

```typescript
describe('ICE config', () => {
  it('default config contains STUN only, no TURN');
  it('injected TURN config is passed unchanged to SimplePeer');
  it('iceTransportPolicy is not forced to relay');
});

describe('connection diagnostics', () => {
  it('getConnectionRoute returns unknown when no peer connected');
  it('getConnectionState returns unknown when no peer');
  it('getIceConnectionState returns unknown when no peer');
});

describe('safe send', () => {
  it('send returns false when no peers connected');
  it('sendToPeer returns false for unknown peer');
  it('broadcastExcept skips disconnected peers');
  it('send skips disconnected peer');
});

describe('offer lifecycle', () => {
  it('cancelOffer removes pending offer');
  it('cancelOffer destroys the SimplePeer instance');
  it('offerUrl generates unique IDs across calls');
  it('close cancels all pending offers');
});

describe('trickle ICE', () => {
  it('default is non-trickle');
  it('trickle:true passes to SimplePeer constructor');
});
```

**Note on mocking:** The tests mock simple-peer, so most new methods won't exercise real WebRTC. Focus on:
- Correct constructor parameters passed to SimplePeer
- Method behavior with mocked state (`_peer`, `_peers`, `_pendingOffers`)
- Return values and error paths

```bash
cd ~/Projects/p2p-collab && npx vitest run
```

Expected: ~30-35 tests pass (currently 16).

```bash
git add tests/room.test.ts && git commit -m "test: expand coverage for ICE config, diagnostics, safe send, offer lifecycle, trickle"
```

---

### Task 10: Final build and typecheck

**Objective:** Verify everything compiles and tests pass.

```bash
cd ~/Projects/p2p-collab
npx vitest run
npx tsup --no-dts    # dts may fail with TS 7.x — see pitfall #22
```

If `dts: true` fails: manually update `dist/index.d.ts` with new types.

```bash
git add dist/ && git commit -m "build: regenerate dist"
```

---

## Part 2: App Integration

### Task 11: Delete connection-diagnostics.ts and integrate library API

**Objective:** The app must use `room.getConnectionRoute()` from the library instead of inspecting private `_peer._pc` / `_peers` fields.

**Files:**
- DELETE: `src/shell/connection-diagnostics.ts`
- Modify: `src/shell/session-controller.ts`

**Changes in session-controller.ts:**

Replace dynamic imports of `connection-diagnostics.ts` with library calls:

**Site 1 — new-host handler (line 79):**
```typescript
// BEFORE:
import('./connection-diagnostics').then(mod => mod.getConnectionRoute(newPeer).then(r => this.onConnected?.(r)));

// AFTER:
newPeer.getConnectionRoute().then(r => {
  const label = r.kind === 'turn' ? 'TURN relay' : r.kind === 'direct' ? 'Direct P2P' : 'Direct P2P';
  this.onConnected?.(label);
});
```

**Site 2 — peerAutoJoin (line 241):**
```typescript
// BEFORE:
import('./connection-diagnostics').then(m => m.getConnectionRoute(peer).then(r => this.onConnected?.(r)));

// AFTER:
peer.getConnectionRoute().then(r => {
  const label = r.kind === 'turn' ? 'TURN relay' : r.kind === 'direct' ? 'Direct P2P' : 'Direct P2P';
  this.onConnected?.(label);
});
```

**Verification:** `npx vite build` in p2p-collab-files

```bash
cd ~/Projects/p2p-collab-files
rm src/shell/connection-diagnostics.ts
npx vite build
git add -A && git commit -m "refactor: use library getConnectionRoute() instead of private field inspection"
```

---

## Completion Checklist

- [x] No hardcoded TURN credentials in `p2p-collab` DEFAULT_ICE_CONFIG
- [x] README matches the default (STUN-only)
- [x] `getConnectionRoute()` inspects selected candidate pair, not all gathered
- [x] Application no longer imports `connection-diagnostics.ts`
- [x] Application does not inspect private SimplePeer fields (`_peer._pc`, `_peers`)
- [x] `send()` checks connection state before sending
- [x] UUID-based offer/peer IDs (no global counters)
- [x] `cancelOffer()` and auto-expiration
- [x] Trickle ICE option (default false, backward-compatible)
- [x] `npm test`, typecheck, and build pass
- [ ] Expand tests for new features
