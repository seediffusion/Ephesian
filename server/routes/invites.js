import express from 'express';
import { db, nowMs } from '../lib/db.js';
import {
  getInviteLink, consumeInviteLink, consumeEmailInvite,
  addShareByUserId, pendingEmailInvitesFor, getDocument, getEmailInvite
} from '../lib/documents.js';
import { createSession, setSessionCookie } from '../lib/sessions.js';
import { newId, randomToken } from '../lib/ids.js';
import { checkRateLimit, ipOf } from '../lib/ratelimit.js';

const router = express.Router();

// Anyone can preview. Joining requires either being signed in or, for guest-friendly
// links, supplying a display name in POST /link/:token/guest.
router.get('/link/:token', (req, res) => {
  const inv = getInviteLink(req.params.token);
  if (!inv || inv.revoked) return res.status(404).json({ error: 'invalid_invite' });
  if (inv.expires_at && inv.expires_at < nowMs()) return res.status(410).json({ error: 'expired' });
  if (inv.max_uses && inv.uses >= inv.max_uses) return res.status(410).json({ error: 'exhausted' });
  const doc = getDocument(inv.document_id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  res.json({
    document: { id: doc.id, title: doc.title },
    role: inv.role,
    allowGuests: !!inv.allow_guests,
    requiresLogin: !req.user,
    requiresVerification: !!req.user && !req.user.emailVerified && !req.user.isGuest
  });
});

router.post('/link/:token/accept', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (!req.user.emailVerified && !req.user.isGuest) return res.status(403).json({ error: 'email_unverified' });
  const inv = consumeInviteLink(req.params.token);
  if (!inv) return res.status(404).json({ error: 'invalid_or_exhausted' });
  if (inv.document_id) addShareByUserId(inv.document_id, req.user.id, inv.role);
  res.json({ ok: true, documentId: inv.document_id });
});

// Accept the invite as a guest. Creates a one-shot user row with a synthetic email,
// adds them to the document, and signs their session in. No password and no email
// verification needed because the guest's identity is scoped to this session only.
router.post('/link/:token/guest', express.json(), (req, res) => {
  const ip = ipOf(req);
  const rl = checkRateLimit(`guest:${ip}`, { max: 30, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return res.status(429).json({ error: 'too_many_attempts' });

  let displayName = String(req.body?.displayName || '').trim();
  // Strip ASCII control characters. Keep printable Unicode, including spaces and punctuation.
  displayName = displayName.split('').filter(ch => {
    const c = ch.charCodeAt(0);
    return c >= 0x20 && c !== 0x7f;
  }).join('').slice(0, 60).trim();
  if (!displayName) return res.status(400).json({ error: 'display_name_required' });

  const inv = getInviteLink(req.params.token);
  if (!inv || inv.revoked) return res.status(404).json({ error: 'invalid_invite' });
  if (!inv.allow_guests) return res.status(403).json({ error: 'guests_not_allowed' });
  if (inv.expires_at && inv.expires_at < nowMs()) return res.status(410).json({ error: 'expired' });
  if (inv.max_uses && inv.uses >= inv.max_uses) return res.status(410).json({ error: 'exhausted' });

  const doc = getDocument(inv.document_id);
  if (!doc) return res.status(404).json({ error: 'not_found' });

  const guestId = newId('gst');
  const syntheticEmail = `guest+${randomToken(8)}@guests.ephesian.local`;
  const now = nowMs();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, email_verified, is_guest, created_at)
       VALUES (?, ?, ?, '', 1, 1, ?)`
    ).run(guestId, syntheticEmail, displayName, now);
    db.prepare('UPDATE invite_links SET uses = uses + 1 WHERE token = ?').run(req.params.token);
    addShareByUserId(inv.document_id, guestId, inv.role);
  });
  tx();

  const { id: sid, expiresAt } = createSession({
    userId: guestId,
    pending2FA: false,
    ip,
    userAgent: req.headers['user-agent'] || null
  });
  setSessionCookie(res, sid, expiresAt);

  res.json({
    ok: true,
    documentId: inv.document_id,
    user: { id: guestId, displayName, isGuest: true }
  });
});

// Preview an email invite (no consumption). Available to anyone with the token
// so we can offer them sign in / create account / guest paths in the UI. We
// deliberately do NOT echo the recipient email back to anonymous requesters
// to avoid leaking it from a forwarded link.
router.get('/email/:token', (req, res) => {
  const inv = getEmailInvite(req.params.token);
  if (!inv || inv.consumed) return res.status(404).json({ error: 'invalid_invite' });
  const doc = getDocument(inv.document_id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  res.json({
    document: { id: doc.id, title: doc.title },
    role: inv.role,
    allowGuests: !!inv.allow_guests
  });
});

router.post('/email/:token/accept', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (req.user.isGuest) return res.status(403).json({ error: 'guests_not_allowed' });
  if (!req.user.emailVerified) return res.status(403).json({ error: 'email_unverified' });
  const row = consumeEmailInvite(req.params.token, req.user.email);
  if (!row) return res.status(404).json({ error: 'invalid_invite' });
  addShareByUserId(row.document_id, req.user.id, row.role);
  res.json({ ok: true, documentId: row.document_id });
});

// Accept the email invite as a guest. Mirrors the link-invite guest path,
// but operates against the email_invites row and respects its allow_guests flag.
router.post('/email/:token/guest', express.json(), (req, res) => {
  const ip = ipOf(req);
  const rl = checkRateLimit(`guest:${ip}`, { max: 30, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return res.status(429).json({ error: 'too_many_attempts' });

  let displayName = String(req.body?.displayName || '').trim();
  displayName = displayName.split('').filter(ch => {
    const c = ch.charCodeAt(0);
    return c >= 0x20 && c !== 0x7f;
  }).join('').slice(0, 60).trim();
  if (!displayName) return res.status(400).json({ error: 'display_name_required' });

  const inv = getEmailInvite(req.params.token);
  if (!inv || inv.consumed) return res.status(404).json({ error: 'invalid_invite' });
  if (!inv.allow_guests) return res.status(403).json({ error: 'guests_not_allowed' });

  const doc = getDocument(inv.document_id);
  if (!doc) return res.status(404).json({ error: 'not_found' });

  const guestId = newId('gst');
  const syntheticEmail = `guest+${randomToken(8)}@guests.ephesian.local`;
  const now = nowMs();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, email_verified, is_guest, created_at)
       VALUES (?, ?, ?, '', 1, 1, ?)`
    ).run(guestId, syntheticEmail, displayName, now);
    db.prepare('UPDATE email_invites SET consumed = 1 WHERE id = ?').run(inv.id);
    addShareByUserId(inv.document_id, guestId, inv.role);
  });
  tx();

  const { id: sid, expiresAt } = createSession({
    userId: guestId,
    pending2FA: false,
    ip,
    userAgent: req.headers['user-agent'] || null
  });
  setSessionCookie(res, sid, expiresAt);

  res.json({
    ok: true,
    documentId: inv.document_id,
    user: { id: guestId, displayName, isGuest: true }
  });
});

// On login, auto-claim any pending email invites for this verified email.
router.post('/email/claim-pending', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (req.user.isGuest) return res.json({ ok: true, claimed: 0 });
  if (!req.user.emailVerified) return res.json({ ok: true, claimed: 0 });
  const pending = pendingEmailInvitesFor(req.user.email);
  let claimed = 0;
  const tx = db.transaction(() => {
    for (const inv of pending) {
      addShareByUserId(inv.document_id, req.user.id, inv.role);
      db.prepare('UPDATE email_invites SET consumed = 1 WHERE id = ?').run(inv.id);
      claimed++;
    }
  });
  tx();
  res.json({ ok: true, claimed });
});

export { router as invitesRouter };
