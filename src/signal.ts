import type { SignalData } from './types';

export function encodeSignal(
  data: SignalData,
  baseUrl: string = ''
): { url: string; sizeKB: number } {
  const json = JSON.stringify(data);
  const encoded = btoa(json);
  const base = baseUrl.split('#')[0];
  const url = base
    ? `${base}#sdp=${encoded}`
    : `#sdp=${encoded}`;
  return { url, sizeKB: +(encoded.length / 1024).toFixed(1) };
}

export function decodeSignal(input: string): SignalData | null {
  if (!input) return null;
  try {
    const fragment = input.includes('#sdp=')
      ? input.split('#sdp=')[1]
      : input;
    const parsed = JSON.parse(atob(fragment));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.type && !parsed.sdp && !parsed.candidate) return null;
    return parsed as SignalData;
  } catch {
    return null;
  }
}