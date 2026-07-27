declare global {
  interface Window {
    __ROOM_SEND?: number;
    __SEND_CALLED?: number;
    __RECV_CALLED?: number;
  }
}
export {};
