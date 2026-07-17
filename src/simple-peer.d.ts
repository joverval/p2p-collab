declare module 'simple-peer' {
  import { Duplex } from 'stream';

  interface Options {
    initiator?: boolean;
    trickle?: boolean;
    wrtc?: any;
    channelConfig?: RTCDataChannelInit;
    channelName?: string;
    config?: RTCConfiguration;
    offerOptions?: RTCOfferOptions;
    answerOptions?: RTCAnswerOptions;
    sdpTransform?: (sdp: string) => string;
    stream?: MediaStream | false;
    streams?: MediaStream[];
    objectMode?: boolean;
  }

  interface Instance extends Duplex {
    signal(data: string | any): void;
    send(data: string | Buffer | Uint8Array): void;
    destroy(err?: Error): void;
    connected: boolean;
    on(event: 'signal', listener: (data: any) => void): this;
    on(event: 'connect', listener: () => void): this;
    on(event: 'data', listener: (data: Uint8Array) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
  }

  interface SimplePeer {
    new (opts?: Options): Instance;
    (opts?: Options): Instance;
  }

  const SimplePeer: SimplePeer;
  export = SimplePeer;
}