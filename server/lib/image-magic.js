/**
 * Magic-byte sniffing for uploaded media. The client-sent Content-Type / file
 * extension is untrusted — a malicious uploader can lie. We re-check the
 * actual bytes against known signatures and reject anything that doesn't
 * match its claimed type.
 *
 * SVG is intentionally NOT in the allowed list. SVG can carry inline
 * <script> and event handlers, so serving an SVG from /uploads/ as
 * image/svg+xml is an XSS vector.
 */
import fs from 'fs';

const SIGS = [
  // [mime, bytes-as-hex prefix, optional offset]
  ['image/jpeg', 'ffd8ff'],
  ['image/png',  '89504e470d0a1a0a'],
  ['image/gif',  '474946383761'],   // GIF87a
  ['image/gif',  '474946383961'],   // GIF89a
  ['image/webp', '52494646', 0, '57454250', 8],         // RIFF....WEBP
  ['image/bmp',  '424d'],
  ['image/heic', '66747970686569',  4],                 // ftyp + heic
  ['image/heif', '6674797068656966', 4],
  ['image/avif', '6674797061766966', 4],
  // Videos
  ['video/mp4',     '6674797069736f6d', 4],             // ftyp + isom
  ['video/mp4',     '667479706d703432', 4],             // ftyp + mp42
  ['video/webm',    '1a45dfa3'],                        // EBML header
  ['video/quicktime', '667479707174', 4],               // ftyp + qt
];

function _hex(buf, off, len) {
  return buf.slice(off, off + len).toString('hex');
}

/** Returns the detected mime type, or null if no known signature matches. */
export function detectMime(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    for (const sig of SIGS) {
      const [mime, hex1, off1 = 0, hex2, off2] = sig;
      if (_hex(buf, off1, hex1.length / 2) !== hex1) continue;
      if (hex2 != null && _hex(buf, off2, hex2.length / 2) !== hex2) continue;
      return mime;
    }
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

/** Throws (with a friendly message) if the file isn't one of the allowed
 *  media types. Caller should catch and unlink the file on failure. */
export function assertAllowedMedia(filePath, allowed = ['image', 'video']) {
  const mime = detectMime(filePath);
  if (!mime) throw new Error('Unrecognized media type — only common image/video formats are allowed.');
  const top = mime.split('/')[0];
  if (!allowed.includes(top)) throw new Error(`This endpoint does not accept ${top} files.`);
  return mime;
}
