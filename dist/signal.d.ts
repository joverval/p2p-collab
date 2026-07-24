import type { SignalData } from './types';
export declare function encodeSignal(data: SignalData, baseUrl?: string): {
    url: string;
    sizeKB: number;
};
export declare function decodeSignal(input: string): SignalData | null;
