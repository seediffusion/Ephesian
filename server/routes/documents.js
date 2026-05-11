import express from 'express';
import { db, nowMs } from '../lib/db.js';
import {
  listDocumentsForUser, getDocumentAccess, createDocument, getDocument,
  setDocumentTitle, setDocumentCapacity, deleteDocument,
  listShares, addShareByUserId, removeShare,
  createInviteLink, listInviteLinks, revokeInviteLink,
  createEmailInvite, consumeEmailInvite, consumeInviteLink,
  effectiveCapacity, getYDocState, saveYDocState
} from '../lib/documents.js';
import { docCapacityInUse } from '../lib/collab.js';
import { config } from '../lib/config.js';
import { sendMail } from '../lib/email.js';
import * as Y from 'yjs';

const router = express.Router();

function requireUser(req, res) {
  if (!req.user) { res.status(401).json({ error: 'auth_required' }); return null; }
  return req.user;
}

function requireVerifiedUser(req, res) {
  const u = requireUser(req, res); if (!u) return null;
  if (!u.emailVerified) { res.status(403).json({ error: 'email_unverified' }); return null; }
  return u;
}

// Operations that mutate document ownership/sharing/2FA make no sense for guests.
function requireFullAccount(req, res) {
  const u = requireVerifiedUser(req, res); if (!u) return null;
  if (u.isGuest) { res.status(403).json({ error: 'guests_not_allowed' }); return null; }
  return u;
}

function requireOwner(req, res) {
  const u = requireFullAccount(req, res); if (!u) return null;
  const a = getDocumentAccess(req.params.id, u.id);
  if (!a) { res.status(404).json({ error: 'not_found' }); return null; }
  if (a.role !== 'owner') { res.status(403).json({ error: 'forbidden' }); return null; }
  return { user: u, doc: a.document };
}

router.get('/', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  res.json({ documents: listDocumentsForUser(u.id) });
});

router.post('/', express.json(), (req, res) => {
  const u = requireFullAccount(req, res); if (!u) return;
  const title = String(req.body?.title || 'Untitled').slice(0, 200);
  const capacity = Math.max(0, Math.floor(Number(req.body?.capacity) || 0));
  const doc = createDocument({ ownerId: u.id, title, capacity });
  res.json({ document: doc });
});

router.get('/:id', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const a = getDocumentAccess(req.params.id, u.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  res.json({
    document: {
      id: a.document.id,
      title: a.document.title,
      ownerId: a.document.owner_id,
      capacity: a.document.capacity,
      effectiveCapacity: effectiveCapacity(a.document),
      currentParticipants: docCapacityInUse(a.document.id),
      createdAt: a.document.created_at,
      updatedAt: a.document.updated_at
    },
    role: a.role
  });
});

router.patch('/:id', express.json(), (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  if (typeof req.body?.title === 'string') setDocumentTitle(ctx.doc.id, req.body.title);
  if (req.body?.capacity !== undefined) setDocumentCapacity(ctx.doc.id, req.body.capacity);
  const updated = getDocument(ctx.doc.id);
  res.json({
    document: {
      id: updated.id,
      title: updated.title,
      capacity: updated.capacity,
      effectiveCapacity: effectiveCapacity(updated),
      updatedAt: updated.updated_at
    }
  });
});

router.delete('/:id', (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  deleteDocument(ctx.doc.id);
  res.json({ ok: true });
});

// --- Sharing ---------------------------------------------------------

router.get('/:id/shares', (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  res.json({
    shares: listShares(ctx.doc.id),
    invites: listInviteLinks(ctx.doc.id)
  });
});

router.delete('/:id/shares/:userId', (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  removeShare(ctx.doc.id, req.params.userId);
  res.json({ ok: true });
});

router.post('/:id/invite-email', express.json(), async (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingUser) {
    if (existingUser.id === ctx.doc.owner_id) {
      return res.status(400).json({ error: 'cannot_invite_owner' });
    }
    addShareByUserId(ctx.doc.id, existingUser.id, role);
    await sendMail({
      to: email,
      subject: `${ctx.user.displayName} shared a document with you on ${config.appName}`,
      text:
`${ctx.user.displayName} (${ctx.user.email}) shared "${ctx.doc.title}" with you on ${config.appName}.

Open it here: ${config.publicOrigin}/d/${ctx.doc.id}`
    });
    return res.json({ ok: true, mode: 'direct' });
  }

  const token = createEmailInvite({
    docId: ctx.doc.id,
    email,
    role,
    invitedBy: ctx.user.id
  });
  const link = `${config.publicOrigin}/invite/email/${token}`;
  await sendMail({
    to: email,
    subject: `${ctx.user.displayName} invited you to collaborate on ${config.appName}`,
    text:
`${ctx.user.displayName} (${ctx.user.email}) invited you to collaborate on "${ctx.doc.title}".

Accept by signing up at ${config.appName} with this email address:
${link}`
  });
  res.json({ ok: true, mode: 'invite_email' });
});

router.post('/:id/invite-link', express.json(), (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
  const maxUses = Math.max(0, Math.floor(Number(req.body?.maxUses) || 0));
  const expiresAt = req.body?.expiresAt ? Number(req.body.expiresAt) : null;
  // Default: allow joining as a guest (the project's friction-free path).
  // Owners can opt out per-link by passing allowGuests: false explicitly.
  const allowGuests = req.body?.allowGuests === false ? false : true;
  const token = createInviteLink(ctx.doc.id, { role, maxUses, expiresAt, allowGuests });
  res.json({
    ok: true,
    token,
    url: `${config.publicOrigin}/invite/link/${token}`,
    maxUses,
    role,
    expiresAt,
    allowGuests
  });
});

router.delete('/:id/invite-link/:token', (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  revokeInviteLink(req.params.token);
  res.json({ ok: true });
});

export { router as documentsRouter };
