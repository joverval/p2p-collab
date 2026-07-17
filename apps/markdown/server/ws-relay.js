// p2p-collab WebSocket relay for automatic SDP handshake
// Supports: host registration, peer join requests with email, host approve/reject

import { WebSocketServer } from 'ws';

const PORT = 8083;
const rooms = new Map(); // roomId → { hostWs, pending: Map<peerWs, { email, answerB64 }> }

const wss = new WebSocketServer({ port: PORT });

function genRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

wss.on('connection', (ws) => {
  let role = null;
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      case 'host-register': {
        role = 'host';
        roomId = genRoomId();
        rooms.set(roomId, { hostWs: ws, pending: new Map() });
        ws.send(JSON.stringify({ type: 'registered', room: roomId }));
        break;
      }

      case 'peer-join-request': {
        role = 'peer';
        roomId = msg.room;
        const room = rooms.get(roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }

        // Store pending request
        room.pending.set(ws, {
          email: msg.email || 'unknown',
          answerB64: msg.answerB64,
        });

        // Notify host of pending request
        room.hostWs.send(JSON.stringify({
          type: 'peer-request',
          email: msg.email || 'unknown',
        }));

        ws.send(JSON.stringify({ type: 'waiting-approval' }));
        break;
      }

      case 'host-approve': {
        const room = rooms.get(roomId);
        if (!room) return;

        // Find the pending peer (approve the first one, or match by email)
        for (const [peerWs, pending] of room.pending) {
          if (pending.email === msg.email || true) { // approve first pending
            // Send answer to host
            room.hostWs.send(JSON.stringify({
              type: 'answer',
              answerB64: pending.answerB64,
              email: pending.email,
            }));

            // Notify peer
            peerWs.send(JSON.stringify({ type: 'approved' }));

            room.pending.delete(peerWs);
            break;
          }
        }
        break;
      }

      case 'host-reject': {
        const room = rooms.get(roomId);
        if (!room) return;

        for (const [peerWs, pending] of room.pending) {
          if (pending.email === msg.email || true) {
            peerWs.send(JSON.stringify({ type: 'rejected', message: 'Host rejected your request' }));
            room.pending.delete(peerWs);
            // Close peer connection
            peerWs.close();
            break;
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (role === 'host' && roomId) {
      // Reject all pending peers
      const room = rooms.get(roomId);
      if (room) {
        for (const [peerWs] of room.pending) {
          peerWs.send(JSON.stringify({ type: 'rejected', message: 'Host disconnected' }));
          peerWs.close();
        }
        rooms.delete(roomId);
      }
    }
  });
});

console.log(`WS relay listening on :${PORT}`);