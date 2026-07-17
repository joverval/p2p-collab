// p2p-collab WebSocket relay for automatic SDP handshake

import { WebSocketServer } from 'ws';

const PORT = 8083;
const rooms = new Map(); // roomId → host ws

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
        rooms.set(roomId, ws);
        ws.send(JSON.stringify({ type: 'registered', room: roomId }));
        break;
      }

      case 'peer-relay': {
        role = 'peer';
        roomId = msg.room;
        const hostWs = rooms.get(roomId);
        if (hostWs) {
          hostWs.send(JSON.stringify({ type: 'answer', payload: msg.payload }));
          ws.send(JSON.stringify({ type: 'relayed' }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (role === 'host' && roomId) {
      rooms.delete(roomId);
    }
  });
});

console.log(`WS relay listening on :${PORT}`);