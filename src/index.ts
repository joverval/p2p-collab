// src/index.ts
export { encodeSignal, decodeSignal } from './signal';
export { P2PRoom } from './room';
export type { Room, RoomOptions, PeerInfo, CreateRoomResult, SignalData, ConnectionRoute, IceMode, BroadcastResult } from './types';

import { P2PRoom } from './room';
import type { Room, RoomOptions, CreateRoomResult } from './types';

/**
 * Create a new room as host.
 * Returns the offer URL (share with peers) and the Room instance.
 *
 * @param baseUrl - Optional base URL for the offer (e.g. 'http://192.168.100.13:8082')
 * @param opts - Optional lifecycle callbacks
 */
export async function createRoom(
  baseUrl: string = '',
  opts?: RoomOptions
): Promise<CreateRoomResult> {
  const room = new P2PRoom(true, baseUrl, opts);
  const url = await room.offerUrl();
  return { url, room };
}

/**
 * Join a room as peer using the host's offer URL.
 * Returns the Room instance and the answer URL (to deliver back to host).
 *
 * @param offerUrl - The host's offer URL (with #sdp= fragment)
 * @param baseUrl - Optional base URL for the answer
 * @param opts - Optional lifecycle callbacks
 */
export async function joinRoom(
  offerUrl: string,
  baseUrl: string = '',
  opts?: RoomOptions
): Promise<{ room: Room; answerUrl: string }> {
  const room = new P2PRoom(false, baseUrl, opts);
  const answerUrl = await room.connectToHost(offerUrl);
  return { room, answerUrl };
}