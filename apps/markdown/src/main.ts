import { createRoom, joinRoom, P2PRoom } from '../../../dist/index.js';
import type { Room } from '../../../dist/index.js';
import './style.css';

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

// ── State ──

let hostRoom: Room | null = null;
let peerRoom: Room | null = null;
let hostConnected = false;
let peerConnected = false;

const baseUrl = window.location.href.split('#')[0];

// ── HOST ──

async function hostCreateRoom() {
  log('host', 'system', 'Creating room...');
  setStatus('host', 'connecting', 'generating offer');
  ($('host-create-btn') as HTMLButtonElement).disabled = true;

  try {
    const { url, room } = await createRoom(baseUrl);
    hostRoom = room;

    $('host-offer-url').textContent = url;
    $('host-offer-url').classList.remove('empty');
    $('host-offer-size').textContent = urlSizeKB(url);
    log('host', 'system', 'Offer generated');
    log('host', 'system', 'Copy the Offer URL and paste in Peer panel');
    setStatus('host', 'connecting', 'waiting for answer');
    ($('host-answer-btn') as HTMLButtonElement).disabled = false;

    room.onMessage((data: string | Uint8Array, peerId: string) => {
      log('host', 'received', `Peer(${peerId}): ${data}`);
    });

    room.onPeerJoin((peerId: string) => {
      hostConnected = true;
      setStatus('host', 'connected', 'connected');
      log('host', 'system', `🎉 Connection established! (peer: ${peerId})`);
      enableMsg('host', true);
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
  hostRoom.send(text);
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
    // Enable messaging — simple-peer buffers until connected
    enableMsg('peer', true);
    peerConnected = true;

    room.onMessage((data: string | Uint8Array, peerId: string) => {
      // First message means we're truly connected
      if (!peerConnected) {
        peerConnected = true;
        setStatus('peer', 'connected', 'connected');
        log('peer', 'system', '🎉 Connection established!');
      }
      log('peer', 'received', `Host(${peerId}): ${data}`);
    });
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
  peerRoom.send(text);
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