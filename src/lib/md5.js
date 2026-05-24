/**
 * Minimal MD5 implementation for Subsonic API token auth.
 * Subsonic requires: token = md5(password + salt)
 */
export default function md5(str) {
  function rotl(v, s) { return (v << s) | (v >>> (32 - s)); }
  function fmix(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h; }

  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8 >> 6) + 1) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, len * 8, true);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

  const S = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21];
  const K = Array.from({length:64}, (_,i) => Math.floor(2**32 * Math.abs(Math.sin(i+1))) >>> 0);
  const G = [
    i => i, i => (5*i+1)%16, i => (3*i+5)%16, i => (7*i)%16
  ];
  const F = [
    (b,c,d) => (b&c)|((~b)&d),
    (b,c,d) => (d&b)|((~d)&c),
    (b,c,d) => b^c^d,
    (b,c,d) => c^(b|(~d)),
  ];

  for (let offset = 0; offset < padded.length; offset += 64) {
    const M = Array.from({length:16}, (_,i) => view.getUint32(offset + i*4, true));
    let [aa,bb,cc,dd] = [a,b,c,d];
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const f = F[r](bb,cc,dd);
      const g = G[r](i);
      const temp = dd;
      dd = cc; cc = bb;
      bb = (bb + rotl((aa + f + K[i] + M[g]) >>> 0, S[r*4 + (i%4)])) >>> 0;
      aa = temp;
    }
    a = (a+aa)>>>0; b = (b+bb)>>>0; c = (c+cc)>>>0; d = (d+dd)>>>0;
  }

  return [a,b,c,d].map(v => {
    const bytes = [(v)&0xff, (v>>>8)&0xff, (v>>>16)&0xff, (v>>>24)&0xff];
    return bytes.map(b => b.toString(16).padStart(2,'0')).join('');
  }).join('');
}
