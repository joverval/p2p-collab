import { createRoom, joinRoom, P2PRoom } from '../../../dist/index.js';
import type { Room } from '../../../dist/index.js';
import './style.css';

import * as Y from 'yjs';

// File System Access API type declarations
declare global {
  interface Window {
    showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  }
}

interface OpenFilePickerOptions {
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

// ── Helpers ──

function $(id: string): HTMLElement { return document.getElementById(id)!; }

function log(panel: string, type: string, text: string) {
  const el = $(`${panel}-log`);
  el.innerHTML += `<div class="entry ${type}">[${new Date().toLocaleTimeString()}] ${text}</div>`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(panel: string, cls: string, text: string) {
  const el = $(`${panel}-status`);
  el.className = `status ${cls}`;
  el.textContent = text;
}

function enableMsg(panel: string, enabled: boolean) {
  ($(`${panel}-msg-input`) as HTMLInputElement).disabled = !enabled;
  ($(`${panel}-send-btn`) as HTMLButtonElement).disabled = !enabled;
}

function urlSizeKB(url: string): string {
  const match = url.match(/#sdp=(.*)/);
  if (!match) return '';
  return `URL segment: ${(match[1].length / 1024).toFixed(1)} KB`;
}

// ── Message encoding (0x00 = chat text, 0x01 = Yjs CRDT) ──

function encodeChat(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const msg = new Uint8Array(1 + encoded.length);
  msg[0] = 0x00;
  msg.set(encoded, 1);
  return msg;
}

function encodeYjs(data: Uint8Array): Uint8Array {
  const msg = new Uint8Array(1 + data.length);
  msg[0] = 0x01;
  msg.set(data, 1);
  return msg;
}

function decodeMessage(data: Uint8Array): { type: 'chat'; text: string } | { type: 'yjs'; update: Uint8Array } {
  if (data.length === 0) return { type: 'chat', text: '' };
  if (data[0] === 0x01) return { type: 'yjs', update: data.slice(1) };
  const start = data[0] === 0x00 ? 1 : 0;
  return { type: 'chat', text: new TextDecoder().decode(data.slice(start)) };
}

// ── WS relay ──

const WS_URL = `ws://${window.location.hostname}:8083`;
let ws: WebSocket | null = null;

function wsConnect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('WS connection failed'));
    socket.onclose = () => { ws = null; };
    ws = socket;
  });
}

function wsRegister(): Promise<string> {
  return new Promise((resolve) => {
    ws!.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'registered') resolve(msg.room);
    };
    ws!.send(JSON.stringify({ type: 'host-register' }));
  });
}

function wsWaitForAnswer(): Promise<any> {
  return new Promise((resolve) => {
    ws!.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'answer') resolve(msg.payload);
    };
  });
}

function wsRelayAnswer(roomId: string, payload: any): Promise<void> {
  return new Promise((resolve, reject) => {
    ws!.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'relayed') resolve();
      if (msg.type === 'error') reject(new Error(msg.message));
    };
    ws!.send(JSON.stringify({ type: 'peer-relay', room: roomId, payload }));
  });
}

// ── State ──

let hostRoom: Room | null = null;
let peerRoom: Room | null = null;
let hostConnected = false;
let peerConnected = false;
let isHost = false;

const baseUrl = window.location.href.split('#')[0];

// ── Yjs CRDT state ──

let ydoc: Y.Doc | null = null;
let ytext: Y.Text | null = null;
let editorInitialized = false;
let isRemoteUpdate = false;

function initCollaborativeEditor() {
  if (editorInitialized) return;
  editorInitialized = true;

  ydoc = new Y.Doc();
  ytext = ydoc.getText('markdown');

  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  textarea.disabled = false;
  document.getElementById('editor-section')!.style.display = 'block';

  textarea.addEventListener('input', () => {
    if (isRemoteUpdate) return;
    ydoc!.transact(() => {
      ytext!.delete(0, ytext!.length);
      ytext!.insert(0, textarea.value);
    });
  });

  ydoc.on('update', (update: Uint8Array) => {
    if (isRemoteUpdate) return;
    const msg = encodeYjs(update);
    if (hostRoom && hostConnected) hostRoom.send(msg);
    if (peerRoom && peerConnected) peerRoom.send(msg);
  });
}

// ── File System Access API (host only) ──

let fileHandle: FileSystemFileHandle | null = null;
const openFileBtn = document.getElementById('open-file-btn') as HTMLButtonElement;
const saveFileBtn = document.getElementById('save-file-btn') as HTMLButtonElement;

openFileBtn?.addEventListener('click', async () => {
  if (!isHost) return;
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Markdown files', accept: { 'text/markdown': ['.md'] } }],
    });
    fileHandle = handle;
    const content = await (await handle.getFile()).text();
    ydoc!.transact(() => { ytext!.delete(0, ytext!.length); ytext!.insert(0, content); });
    (document.getElementById('editor-textarea') as HTMLTextAreaElement).value = content;
    log('host', 'system', `Opened: ${fileHandle.name}`);
  } catch (err: any) {
    if (err.name !== 'AbortError') log('host', 'system', `ERROR: ${err.message}`);
  }
});

saveFileBtn?.addEventListener('click', async () => {
  if (!isHost) return;
  if (!fileHandle) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: 'document.md',
        types: [{ description: 'Markdown files', accept: { 'text/markdown': ['.md'] } }],
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') log('host', 'system', `ERROR: ${err.message}`);
      return;
    }
  }
  try {
    const writable = await fileHandle.createWritable();
    await writable.write(ytext!.toString());
    await writable.close();
    log('host', 'system', `Saved: ${fileHandle.name}`);
  } catch (err: any) {
    log('host', 'system', `ERROR saving: ${err.message}`);
  }
});

// ── HOST ──

async function hostCreateRoom() {
  log('host', 'system', 'Creating room...');
  setStatus('host', 'connecting', 'connecting to relay');
  ($('host-create-btn') as HTMLButtonElement).disabled = true;

  try {
    // 1. Connect to WS relay
    await wsConnect();

    // 2. Register as host → get room ID
    const roomId = await wsRegister();
    log('host', 'system', `Room registered: ${roomId}`);

    // 3. Create WebRTC offer with room ID in URL
    const { url, room } = await createRoom(baseUrl);
    hostRoom = room;
    isHost = true;
    if (openFileBtn) openFileBtn.disabled = false;
    if (saveFileBtn) saveFileBtn.disabled = false;

    // Build shareable URL: base + #room=xxx&sdp=xxx
    const shareUrl = url.replace('#sdp=', `#room=${roomId}&sdp=`);

    $('host-offer-url').textContent = shareUrl;
    $('host-offer-url').classList.remove('empty');
    $('host-offer-size').textContent = urlSizeKB(url);
    log('host', 'system', 'Offer generated — share this URL with peer');
    setStatus('host', 'connecting', 'waiting for peer');

    // 4. Wait for peer's answer via WS relay
    log('host', 'system', 'Waiting for peer to connect...');
    const payload = await wsWaitForAnswer();
    log('host', 'system', 'Peer answer received, accepting...');
    room.acceptAnswer(JSON.stringify(payload));

    // 5. Set up message handling
    room.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          (document.getElementById('editor-textarea') as HTMLTextAreaElement).value = ytext!.toString();
          isRemoteUpdate = false;
        }
      } else {
        log('host', 'received', `Peer(${peerId}): ${decoded.text}`);
      }
    });

    room.onPeerJoin((peerId: string) => {
      hostConnected = true;
      setStatus('host', 'connected', 'connected');
      log('host', 'system', `🎉 Connection established! (peer: ${peerId})`);
      enableMsg('host', true);
      initCollaborativeEditor();
      if (ydoc) room.send(encodeYjs(Y.encodeStateAsUpdate(ydoc)));
    });

  } catch (err: any) {
    setStatus('host', 'error', 'error');
    log('host', 'system', `ERROR: ${err.message}`);
    ($('host-create-btn') as HTMLButtonElement).disabled = false;
  }
}

function hostSend() {
  const input = $('host-msg-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !hostRoom || !hostConnected) return;
  hostRoom.send(encodeChat(text));
  log('host', 'sent', `Me: ${text}`);
  input.value = '';
}

// ── PEER ──

function parseRoomFromUrl(): { roomId: string; offer: string } | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1));
  const roomId = params.get('room');
  const sdp = params.get('sdp');
  if (!roomId || !sdp) return null;
  return { roomId, offer: sdp };
}

async function peerAutoJoin(roomId: string, offerB64: string) {
  log('peer', 'system', `Joining room ${roomId}...`);
  setStatus('peer', 'connecting', 'connecting to relay');
  ($('peer-join-btn') as HTMLButtonElement).disabled = true;

  try {
    // 1. Connect to WS relay
    await wsConnect();

    // 2. Reconstruct offer URL and join room
    const offerUrl = `${baseUrl}#sdp=${offerB64}`;
    const { room, answerUrl } = await joinRoom(offerUrl, baseUrl);
    peerRoom = room;

    // 3. Relay answer back to host via WS
    const match = answerUrl.match(/#sdp=(.*)/);
    const answerPayload = match ? JSON.parse(atob(match[1])) : null;
    if (!answerPayload) throw new Error('Could not decode answer');

    log('peer', 'system', 'Relaying answer to host...');
    await wsRelayAnswer(roomId, answerPayload);

    setStatus('peer', 'connecting', 'waiting for host...');
    enableMsg('peer', true);
    peerConnected = true;

    // 4. Set up message handling
    room.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          (document.getElementById('editor-textarea') as HTMLTextAreaElement).value = ytext!.toString();
          isRemoteUpdate = false;
        }
      } else {
        setStatus('peer', 'connected', 'connected');
        log('peer', 'received', `Host(${peerId}): ${decoded.text}`);
      }
    });

    setTimeout(() => initCollaborativeEditor(), 0);

  } catch (err: any) {
    setStatus('peer', 'error', 'error');
    log('peer', 'system', `ERROR: ${err.message}`);
    ($('peer-join-btn') as HTMLButtonElement).disabled = false;
  }
}

function peerSend() {
  const input = $('peer-msg-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !peerRoom || !peerConnected) return;
  peerRoom.send(encodeChat(text));
  log('peer', 'sent', `Me: ${text}`);
  input.value = '';
}

// ── Event bindings ──

$('host-create-btn').addEventListener('click', hostCreateRoom);
$('host-send-btn').addEventListener('click', hostSend);
($('host-msg-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') hostSend();
});

$('peer-join-btn').addEventListener('click', () => {
  const raw = ($('peer-offer-input') as HTMLInputElement).value.trim();
  if (raw) {
    // Manual fallback: parse URL and auto-join
    const parsed = parseRoomFromUrl();
    if (parsed) peerAutoJoin(parsed.roomId, parsed.offer);
    else log('peer', 'system', 'ERROR: Invalid URL');
  }
});
$('peer-send-btn').addEventListener('click', peerSend);
($('peer-msg-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') peerSend();
});

// ── Auto-detect peer mode on page load ──

const parsed = parseRoomFromUrl();
if (parsed) {
  // We're a peer — hide the manual input and auto-join
  ($('peer-offer-input') as HTMLInputElement).disabled = true;
  ($('peer-offer-input') as HTMLInputElement).value = window.location.href;
  peerAutoJoin(parsed.roomId, parsed.offer);
}