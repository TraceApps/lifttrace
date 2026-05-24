/**
 * token-crypto.js — At-rest encryption for OIDC client secrets.
 *
 * Format on disk: `enc:v1:<base64(iv)>:<base64(ciphertext+tag)>`
 *
 * Key derivation: HKDF-SHA256 from JWT_SECRET + a fixed app-level salt. Using
 * JWT_SECRET means rotating it invalidates both sessions AND secret decryption
 * — operators should expect to re-enter OIDC client secrets after a
 * JWT_SECRET rotation. (For independent rotation, set TOKEN_ENC_KEY explicitly.)
 */
import crypto from 'crypto';
import { JWT_SECRET } from '../middleware/auth.js';

const PREFIX = 'enc:v1:';
const SALT   = 'lifttrace.token-crypto.v1';

let _key = null;
function _getKey() {
  if (_key) return _key;
  const source = process.env.TOKEN_ENC_KEY || JWT_SECRET;
  const out = crypto.hkdfSync('sha256', Buffer.from(source, 'utf8'), Buffer.from(SALT, 'utf8'), Buffer.alloc(0), 32);
  _key = Buffer.isBuffer(out) ? out : Buffer.from(out);
  return _key;
}

export function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  if (typeof plaintext !== 'string') plaintext = String(plaintext);
  if (plaintext.startsWith(PREFIX)) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + Buffer.concat([ct, tag]).toString('base64');
}

export function decrypt(value) {
  if (value == null || typeof value !== 'string') return value;
  if (!value.startsWith(PREFIX)) return value;
  try {
    const body = value.slice(PREFIX.length);
    const idx = body.indexOf(':');
    if (idx < 0) throw new Error('malformed ciphertext');
    const iv = Buffer.from(body.slice(0, idx), 'base64');
    const blob = Buffer.from(body.slice(idx + 1), 'base64');
    const ct = blob.subarray(0, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

export function isEncrypted(s) {
  return typeof s === 'string' && s.startsWith(PREFIX);
}
