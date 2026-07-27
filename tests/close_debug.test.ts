import { describe, it, expect, vi } from 'vitest';

const mockPeerEvents: any[] = [];
vi.mock('simple-peer', () => ({
  default: vi.fn().mockImplementation(function (this: any, opts: any) {
    const events = new Map();
    mockPeerEvents.push(events);
    this._opts = opts;
    this._pc = { connectionState: 'connected', iceConnectionState: 'connected', getStats: vi.fn().mockResolvedValue(new Map()) };
    this._channel = { bufferedAmount: 0 };
    this.on = vi.fn((event: string, fn: any) => { events.set(event, fn); });
    this.signal = vi.fn();
    this.send = vi.fn();
    this.write = vi.fn().mockReturnValue(true);
    this.bufferSize = 0;
    this.removeAllListeners = vi.fn();
    this.destroy = vi.fn(function(this: any) { const closeFn = events.get('close'); if (closeFn) closeFn(); });
    this.connected = false;
    return this;
  }),
}));

import { P2PRoom } from '../src/room';

describe('debug close', () => {
  it('clears peers', () => {
    const room = new P2PRoom(true, '');
    const mockPeer = { destroy: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    (room as any)._peers.set('p1', mockPeer);
    (room as any)._peerInfos = [{ id: 'p1', send: vi.fn() }];
    
    console.log('before close:');
    console.log('  _peers.size:', (room as any)._peers.size);
    console.log('  _peerInfos:', JSON.stringify((room as any)._peerInfos));
    console.log('  _offers.size:', (room as any)._offers.size);
    
    room.close();
    
    console.log('after close:');
    console.log('  _peers.size:', (room as any)._peers.size);
    console.log('  _peerInfos:', JSON.stringify((room as any)._peerInfos));
    console.log('  mockPeer.destroy called:', mockPeer.destroy.mock?.calls?.length ?? '?');
    console.log('  typeof _peerInfos:', typeof (room as any)._peerInfos);
    
    expect(room.peers).toHaveLength(0);
  });
});
