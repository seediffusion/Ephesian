import crypto from 'node:crypto';
import { db, nowMs } from './db.js';
import { config } from './config.js';
import { newId } from './ids.js';
import cookieLib from 'cookie';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const COOKIE_NAME = 'ephesian_sid';

function signValue(value) {
  const mac = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(value)
    .digest('base64url');
  return `${value}.${mac}`;
}

function verifySigned(signed) {
  if (typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(value)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? value : null;
}

export function createSession({ userId, pending2FA = false, ip = null, userAgent = null }) {
  const id = newId('sess');
  const now = nowMs();
  const expiresAt = now + (pending2FA ? PENDING_TTL_MS : SESSION_TTL_MS);
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, pending_2fa, created_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, expiresAt, pending2FA ? 1 : 0, now, ip, userAgent);
  return { id, expiresAt };
}

export function promoteSession(sessionId) {
  const expiresAt = nowMs() + SESSION_TTL_MS;
  db.prepare(
    'UPDATE sessions SET pending_2fa = 0, expires_at = ? WHERE id = ?'
  ).run(expiresAt, sessionId);
  return expiresAt;
}

export function destroySession(sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(
    `SELECT s.*, u.email, u.display_name, u.email_verified,
            u.totp_enabled, u.email_2fa_enabled
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`
  ).get(sessionId, nowMs());
  if (!row) return null;
  const hasWebauthn = db
    .prepare('SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1')
    .get(row.user_id);
  return {
    id: row.id,
    userId: row.user_id,
    pending2FA: !!row.pending_2fa,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      emailVerified: !!row.email_verified,
      twoFactor: {
        totp: !!row.totp_enabled,
        email: !!row.email_2fa_enabled,
        webauthn: !!hasWebauthn
      }
    }
  };
}

export function setSessionCookie(res, sessionId, expiresAt) {
  const value = signValue(sessionId);
  res.setHeader('Set-Cookie', cookieLib.serialize(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    expires: new Date(expiresAt)
  }));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookieLib.serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    expires: new Date(0)
  }));
}

export function readSessionCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const parsed = cookieLib.parse(raw);
  const signed = parsed[COOKIE_NAME];
  if (!signed) return null;
  return verifySigned(signed);
}

export function attachUser(req, res, next) {
  const sid = readSessionCookie(req);
  const session = sid ? getSession(sid) : null;
  if (sid && !session) clearSessionCookie(res);
  req.session = session;
  req.user = session && !session.pending2FA ? session.user : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth_required' });
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
  }
  next();
}

export function requireVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (!req.user.emailVerified) return res.status(403).json({ error: 'email_unverified' });
  next();
}
