import { db, nowMs } from './db.js';

export function checkRateLimit(bucket, { max, windowMs }) {
  const now = nowMs();
  const row = db.prepare('SELECT count, reset_at FROM rate_limits WHERE bucket = ?').get(bucket);
  if (!row || row.reset_at < now) {
    db.prepare(
      `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at`
    ).run(bucket, now + windowMs);
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }
  if (row.count >= max) {
    return { allowed: false, remaining: 0, resetAt: row.reset_at };
  }
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?').run(bucket);
  return { allowed: true, remaining: max - row.count - 1, resetAt: row.reset_at };
}

export function ipOf(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}
