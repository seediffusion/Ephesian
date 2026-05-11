import crypto from 'node:crypto';

export function newId(prefix = '') {
  const buf = crypto.randomBytes(16);
  const hex = buf.toString('hex');
  return prefix ? `${prefix}_${hex}` : hex;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function constantTimeEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
