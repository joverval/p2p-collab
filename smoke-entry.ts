import { P2PRoom, encodeSignal, decodeSignal } from './src/index.ts';
const el = document.getElementById('results')!;
el.innerHTML = 'P2PRoom: ' + typeof P2PRoom + '<br>encodeSignal: ' + typeof encodeSignal + '<br>decodeSignal: ' + typeof decodeSignal;
console.log('SMOKE PASS: all exports loaded');