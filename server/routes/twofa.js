import express from 'express';
import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';
import qrcode from 'qrcode';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { db, nowMs } from '../lib/db.js';
import { newId, sha256 } from '../lib/ids.js';
import { config } from '../lib/config.js';
import {
  getSession, readSessionCookie, promoteSession, setSessionCookie
} from '../lib/sessions.js';
import { sendMail } from '../lib/email.js';
import { checkRateLimit, ipOf } from '../lib/ratelimit.js';

const router = express.Router();

function isoBase64URLToBuffer(b64url) {
  return Buffer.from(b64url, 'base64url');
}

function getSessionFromReq(req) {
  const sid = readSessionCookie(req);
  return sid ? getSession(sid) : null;
}

function requireSessionAny(req, res) {
  const session = getSessionFromReq(req);
  if (!session) { res.status(401).json({ error: 'auth_required' }); return null; }
  // Guests have no email, no password, and no way to be re-authenticated next time;
  // exposing 2FA enrolment endpoints to them would be meaningless.
  if (session.user?.isGuest) { res.status(403).json({ error: 'guests_not_allowed' }); return null; }
  return session;
}

function generateBackupCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,10)}`);
  }
  return codes;
}

function totpFor(secretBase32) {
  return new OTPAuth.TOTP({
    issuer: config.appName,
    label: config.appName,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32)
  });
}

// ----- TOTP -----------------------------------------------------------

router.post('/totp/begin-setup', async (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const totp = new OTPAuth.TOTP({
    issuer: config.appName,
    label: session.user.email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret)
  });
  const otpauthUri = totp.toString();
  const qr = await qrcode.toDataURL(otpauthUri);
  // Store secret temporarily on user row until verified.
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?')
    .run(secret, session.userId);
  res.json({ ok: true, secret, otpauthUri, qr });
});

router.post('/totp/confirm', express.json(), (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
  const row = db.prepare('SELECT totp_secret, backup_codes_json FROM users WHERE id = ?')
    .get(session.userId);
  if (!row?.totp_secret) return res.status(400).json({ error: 'no_setup_in_progress' });
  const totp = totpFor(row.totp_secret);
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return res.status(400).json({ error: 'invalid_code' });
  let backupCodes = null;
  if (!row.backup_codes_json) {
    const codes = generateBackupCodes(10);
    backupCodes = codes;
    const stored = JSON.stringify(codes.map(c => ({ h: sha256(c), used: false })));
    db.prepare('UPDATE users SET backup_codes_json = ? WHERE id = ?').run(stored, session.userId);
  }
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(session.userId);
  res.json({ ok: true, backupCodes });
});

router.post('/totp/disable', express.json(), (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?')
    .run(session.userId);
  res.json({ ok: true });
});

// ----- Email-based second factor --------------------------------------

router.post('/email/enable', async (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  if (!session.user.emailVerified) return res.status(400).json({ error: 'email_unverified' });
  db.prepare('UPDATE users SET email_2fa_enabled = 1 WHERE id = ?').run(session.userId);
  res.json({ ok: true });
});

router.post('/email/disable', (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  db.prepare('UPDATE users SET email_2fa_enabled = 0 WHERE id = ?').run(session.userId);
  res.json({ ok: true });
});

router.post('/email/send-challenge', async (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (!session.pending2FA) return res.status(400).json({ error: 'not_pending' });
  const rl = checkRateLimit(`email2fa:${session.userId}`, { max: 5, windowMs: 10 * 60 * 1000 });
  if (!rl.allowed) return res.status(429).json({ error: 'too_many_attempts' });
  const code = String(crypto.randomInt(100000, 1000000));
  const id = newId('et');
  db.prepare(
    `INSERT INTO email_tokens (id, user_id, purpose, code_hash, expires_at, created_at)
     VALUES (?, ?, 'login_2fa', ?, ?, ?)`
  ).run(id, session.userId, sha256(code), nowMs() + 10 * 60 * 1000, nowMs());
  await sendMail({
    to: session.user.email,
    subject: `${config.appName} login code`,
    text:
`Your ${config.appName} login verification code is: ${code}

This code expires in 10 minutes.`
  });
  res.json({ ok: true });
});

router.post('/email/verify-challenge', express.json(), (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (!session.pending2FA) return res.status(400).json({ error: 'not_pending' });
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
  const codeHash = sha256(code);
  const row = db.prepare(
    `SELECT id FROM email_tokens
      WHERE user_id = ? AND purpose = 'login_2fa' AND code_hash = ?
        AND consumed = 0 AND expires_at > ?`
  ).get(session.userId, codeHash, nowMs());
  if (!row) return res.status(400).json({ error: 'invalid_or_expired' });
  db.prepare('UPDATE email_tokens SET consumed = 1 WHERE id = ?').run(row.id);
  const expiresAt = promoteSession(session.id);
  setSessionCookie(res, session.id, expiresAt);
  res.json({ ok: true });
});

// ----- TOTP verification at login -------------------------------------

router.post('/totp/verify', express.json(), (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (!session.pending2FA) return res.status(400).json({ error: 'not_pending' });
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
  const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?')
    .get(session.userId);
  if (!row?.totp_enabled || !row.totp_secret) return res.status(400).json({ error: 'totp_not_enabled' });
  const totp = totpFor(row.totp_secret);
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return res.status(400).json({ error: 'invalid_code' });
  const expiresAt = promoteSession(session.id);
  setSessionCookie(res, session.id, expiresAt);
  res.json({ ok: true });
});

// ----- Backup codes ---------------------------------------------------

router.post('/backup/verify', express.json(), (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (!session.pending2FA) return res.status(400).json({ error: 'not_pending' });
  const rawCode = String(req.body?.code || '').trim().toUpperCase();
  if (!rawCode) return res.status(400).json({ error: 'invalid_code' });
  const row = db.prepare('SELECT backup_codes_json FROM users WHERE id = ?').get(session.userId);
  if (!row?.backup_codes_json) return res.status(400).json({ error: 'no_backup_codes' });
  const codes = JSON.parse(row.backup_codes_json);
  const target = sha256(rawCode);
  const idx = codes.findIndex(c => c.h === target && !c.used);
  if (idx < 0) return res.status(400).json({ error: 'invalid_code' });
  codes[idx].used = true;
  db.prepare('UPDATE users SET backup_codes_json = ? WHERE id = ?')
    .run(JSON.stringify(codes), session.userId);
  const expiresAt = promoteSession(session.id);
  setSessionCookie(res, session.id, expiresAt);
  res.json({ ok: true, codesRemaining: codes.filter(c => !c.used).length });
});

router.post('/backup/regenerate', (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  const codes = generateBackupCodes(10);
  const stored = JSON.stringify(codes.map(c => ({ h: sha256(c), used: false })));
  db.prepare('UPDATE users SET backup_codes_json = ? WHERE id = ?').run(stored, session.userId);
  res.json({ ok: true, codes });
});

// ----- WebAuthn -------------------------------------------------------

router.post('/webauthn/register/options', async (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  const existing = db.prepare(
    'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?'
  ).all(session.userId);
  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userID: Buffer.from(session.userId),
    userName: session.user.email,
    userDisplayName: session.user.displayName,
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred'
    }
  });
  db.prepare(
    `INSERT INTO webauthn_challenges (session_id, challenge, purpose, user_id, expires_at)
     VALUES (?, ?, 'register', ?, ?)
     ON CONFLICT(session_id) DO UPDATE
        SET challenge = excluded.challenge,
            purpose = excluded.purpose,
            user_id = excluded.user_id,
            expires_at = excluded.expires_at`
  ).run(session.id, options.challenge, session.userId, nowMs() + 5 * 60 * 1000);
  res.json(options);
});

router.post('/webauthn/register/verify', express.json({ limit: '1mb' }), async (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  const row = db.prepare('SELECT * FROM webauthn_challenges WHERE session_id = ?').get(session.id);
  if (!row || row.purpose !== 'register' || row.expires_at < nowMs()) {
    return res.status(400).json({ error: 'no_challenge' });
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: row.challenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: false
    });
  } catch (e) {
    return res.status(400).json({ error: 'verification_failed', message: e.message });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'verification_failed' });
  }
  const reg = verification.registrationInfo;
  const credId = reg.credential?.id ?? reg.credentialID;
  const pubKey = reg.credential?.publicKey ?? reg.credentialPublicKey;
  const counter = reg.credential?.counter ?? reg.counter ?? 0;
  const credIdBuf = Buffer.isBuffer(credId) ? credId
    : (credId instanceof Uint8Array ? Buffer.from(credId)
      : Buffer.from(String(credId), 'base64url'));
  const pubKeyBuf = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey);
  const transports = req.body.response?.response?.transports ?? null;
  const deviceName = String(req.body.deviceName || 'Security key').slice(0, 80);
  db.prepare(
    `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, device_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('wac'), session.userId, credIdBuf, pubKeyBuf, counter,
        transports ? JSON.stringify(transports) : null, deviceName, nowMs());
  db.prepare('DELETE FROM webauthn_challenges WHERE session_id = ?').run(session.id);
  res.json({ ok: true });
});

router.get('/webauthn/credentials', (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  const rows = db.prepare(
    'SELECT id, device_name, created_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC'
  ).all(session.userId);
  res.json({ credentials: rows });
});

router.delete('/webauthn/credentials/:id', (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (session.pending2FA) return res.status(403).json({ error: 'verify_login_first' });
  db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')
    .run(req.params.id, session.userId);
  res.json({ ok: true });
});

router.post('/webauthn/auth/options', async (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (!session.pending2FA) return res.status(400).json({ error: 'not_pending' });
  const creds = db.prepare(
    'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?'
  ).all(session.userId);
  if (!creds.length) return res.status(400).json({ error: 'no_credentials' });
  const options = await generateAuthenticationOptions({
    rpID: config.webauthn.rpId,
    userVerification: 'preferred',
    allowCredentials: creds.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined
    }))
  });
  db.prepare(
    `INSERT INTO webauthn_challenges (session_id, challenge, purpose, user_id, expires_at)
     VALUES (?, ?, 'auth', ?, ?)
     ON CONFLICT(session_id) DO UPDATE
        SET challenge = excluded.challenge,
            purpose = excluded.purpose,
            user_id = excluded.user_id,
            expires_at = excluded.expires_at`
  ).run(session.id, options.challenge, session.userId, nowMs() + 5 * 60 * 1000);
  res.json(options);
});

router.post('/webauthn/auth/verify', express.json({ limit: '1mb' }), async (req, res) => {
  const session = requireSessionAny(req, res); if (!session) return;
  if (!session.pending2FA) return res.status(400).json({ error: 'not_pending' });
  const row = db.prepare('SELECT * FROM webauthn_challenges WHERE session_id = ?').get(session.id);
  if (!row || row.purpose !== 'auth' || row.expires_at < nowMs()) {
    return res.status(400).json({ error: 'no_challenge' });
  }
  const credIdRaw = req.body.response?.id;
  if (!credIdRaw) return res.status(400).json({ error: 'invalid_response' });
  const credIdBuf = isoBase64URLToBuffer(credIdRaw);
  const stored = db.prepare(
    `SELECT credential_id, public_key, counter, transports
       FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?`
  ).get(session.userId, credIdBuf);
  if (!stored) return res.status(400).json({ error: 'unknown_credential' });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: row.challenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpId,
      credential: {
        id: stored.credential_id,
        publicKey: stored.public_key,
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined
      },
      requireUserVerification: false
    });
  } catch (e) {
    return res.status(400).json({ error: 'verification_failed', message: e.message });
  }
  if (!verification.verified) return res.status(400).json({ error: 'verification_failed' });

  const newCounter = verification.authenticationInfo?.newCounter ?? stored.counter;
  db.prepare(
    'UPDATE webauthn_credentials SET counter = ? WHERE user_id = ? AND credential_id = ?'
  ).run(newCounter, session.userId, credIdBuf);
  db.prepare('DELETE FROM webauthn_challenges WHERE session_id = ?').run(session.id);

  const expiresAt = promoteSession(session.id);
  setSessionCookie(res, session.id, expiresAt);
  res.json({ ok: true });
});

export { router as twofaRouter };
