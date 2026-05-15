import express from 'express';
import { db, nowMs } from '../lib/db.js';
import {
  listDocumentsForUser, getDocumentAccess, createDocument, getDocument,
  setDocumentTitle, setDocumentCapacity, deleteDocument,
  listShares, addShareByUserId, removeShare,
  getShare, setShareCanModerate,
  setDocumentUserRestriction, clearDocumentUserRestriction,
  createInviteLink, listInviteLinks, revokeInviteLink,
  createEmailInvite, consumeEmailInvite, consumeInviteLink,
  effectiveCapacity, getYDocState, saveYDocState
} from '../lib/documents.js';
import { applyDocumentModeration, docCapacityInUse, refreshDocumentUserAccess } from '../lib/collab.js';
import { config } from '../lib/config.js';
import { sendMail } from '../lib/email.js';
import * as Y from 'yjs';

const router = express.Router();
const MIN_MODERATION_DURATION_MS = 60 * 1000;
const MAX_MODERATION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

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

function requireDocumentModerator(req, res) {
  const u = requireVerifiedUser(req, res); if (!u) return null;
  const a = getDocumentAccess(req.params.id, u.id, { includeDenied: true });
  if (!a) { res.status(404).json({ error: 'not_found' }); return null; }
  if (a.denied) {
    res.status(403).json({
      error: a.denied,
      restriction: publicRestriction(a.restriction)
    });
    return null;
  }
  if (!a.canModerate) { res.status(403).json({ error: 'forbidden' }); return null; }
  return { user: u, doc: a.document, access: a };
}

function publicRestriction(restriction) {
  if (!restriction) return null;
  return {
    action: restriction.action,
    expiresAt: restriction.expires_at
  };
}

function parseModerationDuration(body) {
  const minutes = Number(body?.durationMinutes);
  if (!Number.isFinite(minutes)) return null;
  const ms = Math.round(minutes * 60 * 1000);
  if (ms < MIN_MODERATION_DURATION_MS || ms > MAX_MODERATION_DURATION_MS) return null;
  return ms;
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
  const a = getDocumentAccess(req.params.id, u.id, { includeDenied: true });
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (a.denied) {
    return res.status(403).json({
      error: a.denied,
      restriction: publicRestriction(a.restriction)
    });
  }
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
    role: a.role,
    baseRole: a.baseRole,
    permissions: {
      canModerate: !!a.canModerate,
      canGrantModeration: a.role === 'owner',
      canShare: a.role === 'owner'
    },
    restriction: publicRestriction(a.restriction)
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
  const ctx = requireDocumentModerator(req, res); if (!ctx) return;
  const isOwner = ctx.access.role === 'owner';
  res.json({
    shares: listShares(ctx.doc.id),
    invites: isOwner ? listInviteLinks(ctx.doc.id) : [],
    permissions: {
      canModerate: true,
      canGrantModeration: isOwner,
      canShare: isOwner
    }
  });
});

router.delete('/:id/shares/:userId', (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  removeShare(ctx.doc.id, req.params.userId);
  refreshDocumentUserAccess(ctx.doc.id, req.params.userId);
  res.json({ ok: true });
});

router.patch('/:id/shares/:userId/permissions', express.json(), (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  if (req.params.userId === ctx.doc.owner_id) {
    return res.status(400).json({ error: 'owner_has_permissions' });
  }
  if (req.body?.canModerate) {
    const targetAccess = getDocumentAccess(ctx.doc.id, req.params.userId, { includeDenied: true });
    if (targetAccess?.role !== 'editor') {
      return res.status(400).json({ error: 'viewers_cannot_moderate' });
    }
  }
  const result = setShareCanModerate(ctx.doc.id, req.params.userId, !!req.body?.canModerate);
  if (!result.ok) {
    return res.status(result.reason === 'not_found' ? 404 : 400).json({ error: result.reason });
  }
  refreshDocumentUserAccess(ctx.doc.id, req.params.userId);
  res.json({ ok: true });
});

router.post('/:id/moderation', express.json(), (req, res) => {
  const ctx = requireDocumentModerator(req, res); if (!ctx) return;
  const targetUserId = String(req.body?.userId || '');
  const action = req.body?.action === 'viewer' ? 'viewer' : req.body?.action === 'kick' ? 'kick' : null;
  const durationMs = parseModerationDuration(req.body);
  if (!targetUserId || !action || !durationMs) {
    return res.status(400).json({
      error: 'invalid_input',
      minDurationMinutes: MIN_MODERATION_DURATION_MS / 60000,
      maxDurationMinutes: MAX_MODERATION_DURATION_MS / 60000
    });
  }
  if (targetUserId === ctx.user.id) return res.status(400).json({ error: 'cannot_target_self' });

  const targetAccess = getDocumentAccess(ctx.doc.id, targetUserId, { includeDenied: true });
  const targetShare = getShare(ctx.doc.id, targetUserId);
  if (!targetAccess && !targetShare) return res.status(404).json({ error: 'target_not_found' });
  if (targetAccess?.denied && action !== 'kick') {
    return res.status(400).json({ error: 'target_temporarily_removed' });
  }
  if (targetAccess?.baseRole === 'owner' || targetUserId === ctx.doc.owner_id) {
    return res.status(400).json({ error: 'cannot_target_owner' });
  }
  const targetBaseRole = targetAccess?.baseRole || targetShare?.role;
  if (action === 'viewer' && targetBaseRole !== 'editor') {
    return res.status(400).json({ error: 'target_not_editor' });
  }

  const restriction = setDocumentUserRestriction(ctx.doc.id, targetUserId, {
    action,
    expiresAt: nowMs() + durationMs,
    createdBy: ctx.user.id
  });
  applyDocumentModeration(ctx.doc.id, targetUserId, restriction);
  res.json({ ok: true, restriction: publicRestriction(restriction) });
});

router.delete('/:id/moderation/:userId', (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  clearDocumentUserRestriction(ctx.doc.id, req.params.userId);
  refreshDocumentUserAccess(ctx.doc.id, req.params.userId);
  res.json({ ok: true });
});

router.post('/:id/invite-email', express.json(), async (req, res) => {
  const ctx = requireOwner(req, res); if (!ctx) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
  // Mirrors invite-link: default to allowing guests, owners can opt out per-invite.
  const allowGuests = req.body?.allowGuests === false ? false : true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingUser) {
    if (existingUser.id === ctx.doc.owner_id) {
      return res.status(400).json({ error: 'cannot_invite_owner' });
    }
    addShareByUserId(ctx.doc.id, existingUser.id, role);
    refreshDocumentUserAccess(ctx.doc.id, existingUser.id);
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
    invitedBy: ctx.user.id,
    allowGuests
  });
  const link = `${config.publicOrigin}/invite/email/${token}`;
  const guestNote = allowGuests
    ? '\nYou can also join immediately as a guest from that link, without creating an account.'
    : '';
  await sendMail({
    to: email,
    subject: `${ctx.user.displayName} invited you to collaborate on ${config.appName}`,
    text:
`${ctx.user.displayName} (${ctx.user.email}) invited you to collaborate on "${ctx.doc.title}".

Open this link to accept:
${link}${guestNote}`
  });
  res.json({ ok: true, mode: 'invite_email', allowGuests });
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
