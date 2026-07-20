import { P2PRoom } from '../../../dist/index.js';
import type { Room } from '../../../dist/index.js';
import './style.css';

import * as Y from 'yjs';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

// File System Access API types
declare global {
  interface Window {
    showOpenFilePicker(o?: any): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(o?: any): Promise<FileSystemFileHandle>;
  }
}

// ── DOM Helpers ──

function $(id: string): HTMLElement { return document.getElementById(id)!; }
function el(tag: string, attrs: Record<string, string> = {}, children: (string | Node)[] = []): HTMLElement {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  children.forEach(c => e.append(c));
  return e;
}

function log(type: string, text: string) {
  const logEl = $('chat-log');
  logEl.innerHTML += `<div class="entry ${type}">[${new Date().toLocaleTimeString()}] ${text}</div>`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(cls: string, text: string) {
  const el = $('main-status');
  el.className = `status ${cls}`;
  el.textContent = text;
}

// ── Email validation ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ── Message encoding (0x00 = chat, 0x01 = Yjs) ──

function encodeChat(text: string): Uint8Array {
  const enc = new TextEncoder().encode(text);
  const msg = new Uint8Array(1 + enc.length);
  msg[0] = 0x00;
  msg.set(enc, 1);
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

// ── WS Relay ──

const WS_URL = `ws://${window.location.hostname}:8083`;
let ws: WebSocket | null = null;

function wsConnect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(WS_URL);
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error('WS connection failed'));
    s.onclose = () => { ws = null; };
    ws = s;
  });
}

// ── State ──

let myEmail = '';
let isHost = false;
let room: Room | null = null;
let connected = false;
let connectedUsers: string[] = [];
const baseUrl = window.location.href.split('#')[0];

// Yjs
let ydoc: Y.Doc | null = null;
let ytext: Y.Text | null = null;
let editorView: EditorView | null = null;
let isRemoteUpdate = false;

// File
let fileHandle: FileSystemFileHandle | null = null;

// ── Top Bar ──

function updateTopBar() {
  $('topbar').style.display = 'flex';
  $('topbar-filename').textContent = fileHandle ? `📄 ${fileHandle.name}` : '📄 Untitled.md';
  $('topbar-users').textContent = connectedUsers.length
    ? `👤 ${connectedUsers.join(', ')}`
    : '👤 No users connected';
}

// ── Pending Requests ──

function addPendingRequest(email: string) {
  try {
    $('pending-section').style.display = 'block';
    const list = $('pending-list');

    const item = el('div', { class: 'pending-item' }, [
      el('span', {}, [`🔔 ${email} wants to join`]),
      el('div', { class: 'btn-row' }, [
        el('button', {}, ['Approve']),
        el('button', { class: 'reject-btn' }, ['Reject']),
      ]),
    ]);

    const [approveBtn, rejectBtn] = item.querySelectorAll('button');

    approveBtn.addEventListener('click', () => {
      if (!ws) { log('system', 'ERROR: WS disconnected'); return; }
      ws.send(JSON.stringify({ type: 'host-approve', email }));
      item.remove();
      if ($('pending-list').children.length === 0) {
        $('pending-section').style.display = 'none';
      }
    });

    rejectBtn.addEventListener('click', () => {
      if (!ws) { log('system', 'ERROR: WS disconnected'); return; }
      ws.send(JSON.stringify({ type: 'host-reject', email }));
      item.remove();
      if ($('pending-list').children.length === 0) {
        $('pending-section').style.display = 'none';
      }
    });

    list.appendChild(item);
  } catch (e: any) {
    log('system', `ERROR showing pending request: ${e?.message || e}`);
  }
}

// ── CodeMirror editor ──

function initEditor() {
  const editorEl = $('editor');
  $('editor-section').style.display = 'flex';

  ydoc = new Y.Doc();
  ytext = ydoc.getText('markdown');

  editorView = new EditorView({
    doc: '',
    extensions: [
      basicSetup,
      markdown(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isRemoteUpdate) {
          // Local edit → Yjs
          const value = update.state.doc.toString();
          ydoc!.transact(() => {
            ytext!.delete(0, ytext!.length);
            ytext!.insert(0, value);
          });
        }
      }),
      EditorView.theme({
        '&': { backgroundColor: '#0d1117' },
        '.cm-gutters': { backgroundColor: '#0d1117', borderRight: '1px solid #21262d', color: '#484f58' },
        '.cm-activeLineGutter': { backgroundColor: '#161b22' },
      }),
    ],
    parent: editorEl,
  });

  // Yjs update → send to peers
  ydoc.on('update', (update: Uint8Array) => {
    if (isRemoteUpdate) return;
    if (room && connected) room.send(encodeYjs(update));
  });

  ($('chat-input') as HTMLInputElement).disabled = false;
  ($('chat-send-btn') as HTMLButtonElement).disabled = false;
}

// ── HOST ──

async function createRoom() {
  // Disable immediately to prevent double-clicks / HMR duplicate listeners
  const btn = $('create-room-btn') as HTMLButtonElement;
  if (btn.disabled) return;
  btn.disabled = true;

  const email = ($('email-input') as HTMLInputElement).value.trim();
  if (!validateEmail(email)) {
    log('system', 'ERROR: Please enter a valid email');
    btn.disabled = false;
    return;
  }
  myEmail = email;
  isHost = true;
  ($('email-input') as HTMLInputElement).disabled = true;

  log('system', 'Creating room...');
  setStatus('connecting', 'connecting to relay');

  try {
    await wsConnect();

    // Register as host
    const roomId = await new Promise<string>((resolve) => {
      ws!.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'registered') resolve(msg.room);
      };
      ws!.send(JSON.stringify({ type: 'host-register' }));
    });

    log('system', `Room registered: ${roomId}`);

    // Create WebRTC offer
    log('system', 'Generating WebRTC offer...');

        // Use P2PRoom directly (createRoom wrapper is broken by Vite module transform)
        const r = new P2PRoom(true, baseUrl);
        const url = await r.offerUrl();
        room = r;

    const sdpB64 = url.match(/#sdp=(.*)/)?.[1] || '';
    const shareUrl = `${baseUrl}#room=${roomId}&sdp=${encodeURIComponent(sdpB64)}`;

    $('share-url').textContent = shareUrl;
    $('share-url').classList.remove('empty');
    $('share-url-size').textContent = `URL segment: ${(sdpB64.length / 1024).toFixed(1)} KB`;
    $('share-section').style.display = 'block';

    setStatus('connecting', 'waiting for peer');
    log('system', 'Share the URL above with a peer');

    // Enable file buttons
    ($('open-file-btn') as HTMLButtonElement).disabled = false;
    ($('save-file-btn') as HTMLButtonElement).disabled = false;

    // Handle WS messages (pending requests)
    ws!.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'peer-request') {
        log('system', `📩 ${msg.email} wants to join`);
        addPendingRequest(msg.email);
      } else if (msg.type === 'answer') {
        log('system', `✅ ${msg.email || 'Peer'} approved — applying answer`);
        room!.acceptAnswer(`#sdp=${msg.answerB64}`);
      }
    };

    // Set up room message handling
    r.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          if (editorView) {
            editorView.dispatch({
              changes: { from: 0, to: editorView.state.doc.length, insert: ytext!.toString() },
            });
          }
          isRemoteUpdate = false;
        }
      } else {
        log('received', `${peerId}: ${decoded.text}`);
      }
    });

    r.onPeerJoin((peerId: string) => {
      connected = true;
      connectedUsers.push('Peer');
      setStatus('connected', `connected (${connectedUsers.length} peer(s))`);
      updateTopBar();
      log('system', '🎉 Peer connected!');
      if (!editorView) initEditor();
      if (ydoc) room!.send(encodeYjs(Y.encodeStateAsUpdate(ydoc)));
    });

  } catch (err: any) {
    setStatus('error', 'error');
    log('system', `ERROR: ${err.message}`);
    ($('create-room-btn') as HTMLButtonElement).disabled = false;
    ($('email-input') as HTMLInputElement).disabled = false;
  }
}

let _pendingEmail = '';

// ── PEER ──

function parseRoomFromUrl(): { roomId: string; offer: string } | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const m = hash.match(/^#room=([^&]+)&sdp=(.+)$/);
  if (!m) return null;
  return { roomId: m[1], offer: decodeURIComponent(m[2]) };
}

async function peerAutoJoin(roomId: string, offerB64: string) {
  const btn = $('create-room-btn') as HTMLButtonElement;
  if (btn.disabled) return;
  btn.disabled = true;

  const email = ($('email-input') as HTMLInputElement).value.trim();
  if (!validateEmail(email)) {
    log('system', 'ERROR: Please enter a valid email to join');
    return;
  }
  myEmail = email;
  ($('email-input') as HTMLInputElement).disabled = true;
  ($('create-room-btn') as HTMLButtonElement).disabled = true;

  log('system', `Joining room ${roomId} as ${email}...`);
  setStatus('connecting', 'connecting to relay');

  try {
    await wsConnect();

    // Join room (use P2PRoom directly — joinRoom wrapper broken by Vite)
    const peer = new P2PRoom(false, baseUrl);
    const answerUrl = await peer.connectToHost(`${baseUrl}#sdp=${offerB64}`);
    room = peer;

    const match = answerUrl.match(/#sdp=(.*)/);
    const answerB64 = match ? match[1] : '';
    if (!answerB64) throw new Error('Could not extract answer');

    // Send join request with email
    ws!.send(JSON.stringify({
      type: 'peer-join-request',
      room: roomId,
      email,
      answerB64,
    }));

    log('system', 'Join request sent — waiting for host approval...');
    setStatus('connecting', 'awaiting approval');

    // Wait for approval/rejection
    ws!.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'waiting-approval') {
        // already handled in status
      } else if (msg.type === 'approved') {
        log('system', '✅ Approved by host!');
        setStatus('connected', 'connected');
        connected = true;
        connectedUsers.push('host');
        updateTopBar();
        initEditor();
      } else if (msg.type === 'rejected') {
        setStatus('error', 'rejected');
        log('system', `❌ Rejected: ${msg.message}`);
      }
    };

    // Room message handling
    room!.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          if (editorView) {
            editorView.dispatch({
              changes: { from: 0, to: editorView.state.doc.length, insert: ytext!.toString() },
            });
          }
          isRemoteUpdate = false;
        }
      } else {
        log('received', `Host: ${decoded.text}`);
      }
    });

  } catch (err: any) {
    setStatus('error', 'error');
    log('system', `ERROR: ${err.message}`);
    ($('create-room-btn') as HTMLButtonElement).disabled = false;
    ($('email-input') as HTMLInputElement).disabled = false;
  }
}

// ── Chat ──

function sendChat() {
  const input = $('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !room || !connected) return;
  room.send(encodeChat(text));
  log('sent', `Me: ${text}`);
  input.value = '';
}

// ── File System Access ──

($('open-file-btn') as HTMLButtonElement).addEventListener('click', async () => {
  if (!isHost) return;
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
    });
    fileHandle = handle;
    const content = await (await handle.getFile()).text();
    ydoc!.transact(() => { ytext!.delete(0, ytext!.length); ytext!.insert(0, content); });
    if (editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: content },
      });
    }
    updateTopBar();
    log('system', `Opened: ${handle.name}`);
  } catch (err: any) {
    if (err.name !== 'AbortError') log('system', `ERROR: ${err.message}`);
  }
});

($('save-file-btn') as HTMLButtonElement).addEventListener('click', async () => {
  if (!isHost) return;
  if (!fileHandle) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: 'document.md',
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      updateTopBar();
    } catch (err: any) {
      if (err.name !== 'AbortError') log('system', `ERROR: ${err.message}`);
      return;
    }
  }
  try {
    const w = await fileHandle.createWritable();
    await w.write(ytext!.toString());
    await w.close();
    log('system', `Saved: ${fileHandle.name}`);
  } catch (err: any) {
    log('system', `ERROR saving: ${err.message}`);
  }
});

// ── Event Bindings (HMR-safe via window flag) ──

if (!(window as any).__p2pBound) {
  (window as any).__p2pBound = true;

  ($('create-room-btn') as HTMLButtonElement).addEventListener('click', createRoom);
  ($('chat-send-btn') as HTMLButtonElement).addEventListener('click', sendChat);
  ($('chat-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // ── Auto-detect peer mode ──

  const parsed = parseRoomFromUrl();
  if (parsed) {
    ($('create-room-btn') as HTMLButtonElement).textContent = 'Join Room';
    ($('create-room-btn') as HTMLButtonElement).replaceWith(
      ($('create-room-btn') as HTMLButtonElement).cloneNode(true)
    );
    ($('create-room-btn') as HTMLButtonElement).addEventListener('click', () => {
      peerAutoJoin(parsed.roomId, parsed.offer);
    });
    ($('share-section') as HTMLElement).style.display = 'none';
  }
}