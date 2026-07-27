declare global {
  interface Window {
    __ROOM_SEND?: number;
    __SENDTOSTATE_CALLED?: number;
    __SEND_CALLED?: number;
    __RECV_CALLED?: number;
  }
}
export {};
