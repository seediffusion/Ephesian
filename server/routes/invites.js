import express from 'express';
import { db, nowMs } from '../lib/db.js';
import {
  getInviteLink, consumeInviteLink, consumeEmailInvite,
  addShareByUserId, pendingEmailInvitesFor, getDocument
} from '../lib/documents.js';

const router = express.Router();

// Anyone can preview, but joining requires being signed in.
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
    requiresLogin: !req.user,
    requiresVerification: !!req.user && !req.user.emailVerified
  });
});

router.post('/link/:token/accept', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (!req.user.emailVerified) return res.status(403).json({ error: 'email_unverified' });
  const inv = consumeInviteLink(req.params.token);
  if (!inv) return res.status(404).json({ error: 'invalid_or_exhausted' });
  if (inv.document_id) addShareByUserId(inv.document_id, req.user.id, inv.role);
  res.json({ ok: true, documentId: inv.document_id });
});

router.post('/email/:token/accept', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (!req.user.emailVerified) return res.status(403).json({ error: 'email_unverified' });
  const row = consumeEmailInvite(req.params.token, req.user.email);
  if (!row) return res.status(404).json({ error: 'invalid_invite' });
  addShareByUserId(row.document_id, req.user.id, row.role);
  res.json({ ok: true, documentId: row.document_id });
});

// On login, auto-claim any pending email invites for this verified email.
router.post('/email/claim-pending', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
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
