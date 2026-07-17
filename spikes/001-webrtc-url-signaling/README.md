# 001: WebRTC URL Signaling Spike

**Question:** Can we establish a WebRTC data channel between two browser peers using only URL-encoded SDP exchange, with no signaling server?

**Why it matters:** This is the core premise of p2p-collab. If URL-encoded signaling doesn't work, we need a fundamentally different approach.

**Risk: HIGH** — kills the project if it doesn't work.

## Approach

Single HTML file simulating host + peer in the same page using simple-peer. The signaling flow:

1. Host creates offer → base64 encoded → shown as URL
2. User copies URL, pastes it into Peer panel
3. Peer decodes offer, feeds to simple-peer → generates answer → shown as "answer URL"
4. User copies answer URL, pastes into Host panel
5. Host feeds answer → connection established → messages flow

This mirrors the real-world "two URL exchange" flow.

## What we're testing

- Can simple-peer work with manually exchanged SDP (no server)?
- What's the actual SDP offer size? Is it URL-friendly?
- Does the data channel work for bidirectional messaging?
- Are there any browser quirks or gotchas?