import express from 'express';
import crypto from 'node:crypto';
import { db, nowMs } from '../lib/db.js';
import { newId, randomToken, sha256 } from '../lib/ids.js';
import { hashPassword, verifyPassword, passwordStrengthIssues } from '../lib/passwords.js';
import {
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  promoteSession, getSession, readSessionCookie
} from '../lib/sessions.js';
import { sendMail } from '../lib/email.js';
import { config } from '../lib/config.js';
import { checkRateLimit, ipOf } from '../lib/ratelimit.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function userPublic(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    emailVerified: !!user.email_verified
  };
}

async function issueEmailVerification(userId, email) {
  const code = String(crypto.randomInt(100000, 1000000));
  const tokenId = newId('et');
  const codeHash = sha256(code);
  db.prepare(
    `INSERT INTO email_tokens (id, user_id, purpose, code_hash, expires_at, created_at)
     VALUES (?, ?, 'verify_email', ?, ?, ?)`
  ).run(tokenId, userId, codeHash, nowMs() + 30 * 60 * 1000, nowMs());

  const link = `${config.publicOrigin}/verify?uid=${userId}&code=${code}`;
  await sendMail({
    to: email,
    subject: `${config.appName}: confirm your email`,
    text:
`Welcome to ${config.appName}.

Your verification code is: ${code}

Or open this link to confirm your account:
${link}

This code expires in 30 minutes. If you did not create an account, you can ignore this message.`
  });
}

router.post('/register', express.json(), async (req, res) => {
  const rl = checkRateLimit(`register:${ipOf(req)}`, { max: 8, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return res.status(429).json({ error: 'too_many_attempts' });

  const { email, password, displayName } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = (typeof displayName === 'string' ? displayName.trim() : '') || cleanEmail.split('@')[0];
  if (cleanName.length > 80) return res.status(400).json({ error: 'name_too_long' });
  const issues = passwordStrengthIssues(password);
  if (issues.length) return res.status(400).json({ error: 'weak_password', issues });

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail);
  if (exists) return res.status(409).json({ error: 'email_taken' });

  let hash;
  try { hash = await hashPassword(password); }
  catch (e) { return res.status(400).json({ error: 'hash_failed', message: e.message }); }

  const id = newId('usr');
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, email_verified, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(id, cleanEmail, cleanName, hash, nowMs());

  await issueEmailVerification(id, cleanEmail);

  const { id: sid, expiresAt } = createSession({
    userId: id,
    ip: ipOf(req),
    userAgent: req.headers['user-agent'] || null
  });
  setSessionCookie(res, sid, expiresAt);
  res.json({ ok: true, user: { id, email: cleanEmail, displayName: cleanName, emailVerified: false } });
});

router.post('/verify-email', express.json(), async (req, res) => {
  const sid = readSessionCookie(req);
  const session = sid ? getSession(sid) : null;
  const userId = req.body?.userId || session?.userId;
  const code = String(req.body?.code || '').trim();
  if (!userId || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid_input' });

  const codeHash = sha256(code);
  const row = db.prepare(
    `SELECT * FROM email_tokens
      WHERE user_id = ? AND purpose = 'verify_email' AND code_hash = ?
        AND consumed = 0 AND expires_at > ?`
  ).get(userId, codeHash, nowMs());
  if (!row) return res.status(400).json({ error: 'invalid_or_expired' });

  db.prepare('UPDATE email_tokens SET consumed = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
  res.json({ ok: true });
});

router.post('/resend-verification', async (req, res) => {
  const sid = readSessionCookie(req);
  const session = sid ? getSession(sid) : null;
  if (!session) return res.status(401).json({ error: 'auth_required' });
  const rl = checkRateLimit(`resend:${session.userId}`, { max: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return res.status(429).json({ error: 'too_many_attempts' });
  const user = db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(session.userId);
  if (!user) return res.status(401).json({ error: 'auth_required' });
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });
  await issueEmailVerification(user.id, user.email);
  res.json({ ok: true });
});

router.post('/login', express.json(), async (req, res) => {
  const ip = ipOf(req);
  const rl = checkRateLimit(`login:${ip}`, { max: 20, windowMs: 15 * 60 * 1000 });
  if (!rl.allowed) return res.status(429).json({ error: 'too_many_attempts' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email) || !password) return res.status(400).json({ error: 'invalid_input' });

  const user = db.prepare(
    `SELECT id, email, display_name, password_hash, email_verified,
            totp_enabled, email_2fa_enabled
       FROM users WHERE email = ?`
  ).get(email);
  const ok = user ? await verifyPassword(user.password_hash, password) : false;
  if (!user || !ok) return res.status(401).json({ error: 'invalid_credentials' });

  const hasWebauthn = !!db
    .prepare('SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1')
    .get(user.id);
  const needs2FA = user.totp_enabled || user.email_2fa_enabled || hasWebauthn;

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowMs(), user.id);

  const { id: sid, expiresAt } = createSession({
    userId: user.id,
    pending2FA: needs2FA,
    ip,
    userAgent: req.headers['user-agent'] || null
  });
  setSessionCookie(res, sid, expiresAt);

  res.json({
    ok: true,
    user: userPublic(user),
    requires2FA: needs2FA,
    factors: {
      totp: !!user.totp_enabled,
      email: !!user.email_2fa_enabled,
      webauthn: hasWebauthn
    }
  });
});

router.post('/logout', (req, res) => {
  const sid = readSessionCookie(req);
  if (sid) destroySession(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: req.user, pending2FA: !!req.session?.pending2FA });
});

router.post('/change-password', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'auth_required' });
  const ok = await verifyPassword(user.password_hash, currentPassword || '');
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
  const issues = passwordStrengthIssues(newPassword);
  if (issues.length) return res.status(400).json({ error: 'weak_password', issues });
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

export { router as authRouter, issueEmailVerification };
