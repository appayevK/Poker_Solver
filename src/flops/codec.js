// Compact encoding for flop study data: frequencies quantised to 0-255 and
// byte arrays stored as base64 (works in Node and browsers).

export const QMAX = 255;

/** 0..1 → 0..255 */
export function quantize(f) {
  return Math.round(Math.min(1, Math.max(0, f)) * QMAX);
}

/** Bytes of one combo's actions → frequencies summing to 1 (renormalised after rounding). */
export function dequantizeRow(bytes, offset, count) {
  let sum = 0;
  for (let a = 0; a < count; a++) sum += bytes[offset + a];
  const out = new Array(count);
  for (let a = 0; a < count; a++) out[a] = sum ? bytes[offset + a] / sum : 1 / count;
  return out;
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(text) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Uint16 values (little-endian) ↔ base64 */
export function uint16ToBase64(values) {
  const bytes = new Uint8Array(values.length * 2);
  values.forEach((v, i) => {
    bytes[2 * i] = v & 0xff;
    bytes[2 * i + 1] = v >> 8;
  });
  return bytesToBase64(bytes);
}

export function base64ToUint16(text) {
  const bytes = base64ToBytes(text);
  const out = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
  return out;
}
