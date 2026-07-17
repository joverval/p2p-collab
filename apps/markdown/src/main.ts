import { createRoom, joinRoom, P2PRoom } from '../../../dist/index.js';
import type { Room } from '../../../dist/index.js';
import './style.css';

// Yjs
import * as Y from 'yjs';

// File System Access API type declarations
declare global {
  interface Window {
    showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  }
}

interface OpenFilePickerOptions {
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

// ── Helpers ──

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

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
  if (data[0] === 0x01) {
    return { type: 'yjs', update: data.slice(1) };
  }
  // 0x00 or legacy (no prefix) — treat as chat
  const start = data[0] === 0x00 ? 1 : 0;
  return { type: 'chat', text: new TextDecoder().decode(data.slice(start)) };
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

  // Create Yjs document
  ydoc = new Y.Doc();
  ytext = ydoc.getText('markdown');

  // Use textarea for simplicity
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  textarea.disabled = false;

  // Show editor section
  document.getElementById('editor-section')!.style.display = 'block';

  // Local edit → Yjs → send to peers
  textarea.addEventListener('input', () => {
    if (isRemoteUpdate) return;
    ydoc!.transact(() => {
      ytext!.delete(0, ytext!.length);
      ytext!.insert(0, textarea.value);
    });
  });

  // Yjs update → send to peers via p2p
  ydoc.on('update', (update: Uint8Array) => {
    if (isRemoteUpdate) return;
    const msg = encodeYjs(update);
    if (hostRoom && hostConnected) hostRoom.send(msg);
    if (peerRoom && peerConnected) peerRoom.send(msg);
  });

  // Remote Yjs update → textarea
  ydoc.on('update', () => {
    // updates applied via Y.applyUpdate in onMessage handler trigger this
    // textarea sync happens in the apply path below
  });

  log('host', 'system', '📝 Collaborative editor initialized');
  log('peer', 'system', '📝 Collaborative editor initialized');
}

// ── File System Access API (host only) ──

let fileHandle: FileSystemFileHandle | null = null;

const openFileBtn = document.getElementById('open-file-btn') as HTMLButtonElement;
const saveFileBtn = document.getElementById('save-file-btn') as HTMLButtonElement;

openFileBtn?.addEventListener('click', async () => {
  if (!isHost) return;
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Markdown files',
        accept: { 'text/markdown': ['.md'] },
      }],
    });
    fileHandle = handle;
    const file = await handle.getFile();
    const content = await file.text();

    // Replace Yjs document content
    ydoc!.transact(() => {
      ytext!.delete(0, ytext!.length);
      ytext!.insert(0, content);
    });

    // Update textarea
    const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
    textarea.value = content;

    log('host', 'system', `Opened: ${file.name}`);
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      log('host', 'system', `ERROR: ${err.message}`);
    }
  }
});

saveFileBtn?.addEventListener('click', async () => {
  if (!isHost) return;
  if (!fileHandle) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: 'document.md',
        types: [{
          description: 'Markdown files',
          accept: { 'text/markdown': ['.md'] },
        }],
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        log('host', 'system', `ERROR: ${err.message}`);
      }
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
  setStatus('host', 'connecting', 'generating offer');
  ($('host-create-btn') as HTMLButtonElement).disabled = true;

  try {
    const { url, room } = await createRoom(baseUrl);
    hostRoom = room;
    isHost = true;

    if (openFileBtn) openFileBtn.disabled = false;
    if (saveFileBtn) saveFileBtn.disabled = false;

    $('host-offer-url').textContent = url;
    $('host-offer-url').classList.remove('empty');
    $('host-offer-size').textContent = urlSizeKB(url);
    log('host', 'system', 'Offer generated');
    log('host', 'system', 'Copy the Offer URL and paste in Peer panel');
    setStatus('host', 'connecting', 'waiting for answer');
    ($('host-answer-btn') as HTMLButtonElement).disabled = false;

    room.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          // Sync textarea
          const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
          textarea.value = ytext!.toString();
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

      // Send initial Yjs state to the newly connected peer
      if (ydoc) {
        const update = Y.encodeStateAsUpdate(ydoc);
        room.send(encodeYjs(update));
      }
    });
  } catch (err: any) {
    setStatus('host', 'error', 'error');
    log('host', 'system', `ERROR: ${err.message}`);
    ($('host-create-btn') as HTMLButtonElement).disabled = false;
  }
}

function hostApplyAnswer() {
  const raw = ($('host-answer-input') as HTMLInputElement).value.trim();
  if (!raw) return;
  if (!hostRoom) {
    log('host', 'system', 'ERROR: No active room');
    return;
  }

  try {
    (hostRoom as P2PRoom).acceptAnswer(raw);
    log('host', 'system', 'Applying answer signal...');
    ($('host-answer-btn') as HTMLButtonElement).disabled = true;
    ($('host-answer-input') as HTMLInputElement).disabled = true;
    setStatus('host', 'connecting', 'connecting...');
  } catch (err: any) {
    log('host', 'system', `ERROR: ${err.message}`);
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

async function peerJoin() {
  const raw = ($('peer-offer-input') as HTMLInputElement).value.trim();
  if (!raw) return;

  log('peer', 'system', 'Joining room...');
  setStatus('peer', 'connecting', 'creating peer...');
  ($('peer-join-btn') as HTMLButtonElement).disabled = true;
  ($('peer-offer-input') as HTMLInputElement).disabled = true;

  try {
    const { room, answerUrl } = await joinRoom(raw, baseUrl);
    peerRoom = room;

    $('peer-answer-url').textContent = answerUrl;
    $('peer-answer-url').classList.remove('empty');
    $('peer-answer-size').textContent = urlSizeKB(answerUrl);
    log('peer', 'system', 'Answer generated');
    log('peer', 'system', 'Copy the Answer URL and paste in Host panel');
    setStatus('peer', 'connecting', 'waiting for host...');
    enableMsg('peer', true);
    peerConnected = true;

    room.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
          textarea.value = ytext!.toString();
          isRemoteUpdate = false;
        }
      } else {
        if (!peerConnected) {
          peerConnected = true;
          setStatus('peer', 'connected', 'connected');
          log('peer', 'system', '🎉 Connection established!');
        }
        log('peer', 'received', `Host(${peerId}): ${decoded.text}`);
      }
    });

    setTimeout(() => initCollaborativeEditor(), 0);
  } catch (err: any) {
    setStatus('peer', 'error', 'error');
    log('peer', 'system', `ERROR: ${err.message}`);
    ($('peer-join-btn') as HTMLButtonElement).disabled = false;
    ($('peer-offer-input') as HTMLInputElement).disabled = false;
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
$('host-answer-btn').addEventListener('click', hostApplyAnswer);
$('host-send-btn').addEventListener('click', hostSend);
($('host-msg-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') hostSend();
});

$('peer-join-btn').addEventListener('click', peerJoin);
$('peer-send-btn').addEventListener('click', peerSend);
($('peer-msg-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') peerSend();
});