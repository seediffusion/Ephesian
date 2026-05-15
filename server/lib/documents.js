import { db, nowMs } from './db.js';
import { newId, randomToken } from './ids.js';
import { config } from './config.js';

export function listDocumentsForUser(userId) {
  const now = nowMs();
  return db.prepare(`
    SELECT d.id, d.title, d.capacity, d.created_at, d.updated_at, d.owner_id,
           (d.owner_id = ?) AS is_owner,
           CASE
             WHEN d.owner_id = ? THEN NULL
             WHEN r.action = 'viewer' THEN 'viewer'
             ELSE s.role
           END AS share_role,
           COALESCE(s.can_moderate, 0) AS can_moderate,
           r.action AS restriction_action,
           r.expires_at AS restriction_expires_at
      FROM documents d
      LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
      LEFT JOIN document_user_restrictions r
        ON r.document_id = d.id
       AND r.user_id = ?
       AND r.expires_at > ?
     WHERE (d.owner_id = ? OR s.user_id = ?)
       AND (d.owner_id = ? OR r.action IS NULL OR r.action <> 'kick')
     ORDER BY d.updated_at DESC
  `).all(userId, userId, userId, userId, now, userId, userId, userId);
}

export function getDocument(docId) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

export function getActiveDocumentRestriction(docId, userId) {
  return db.prepare(`
    SELECT id, document_id, user_id, action, expires_at, created_by, created_at
      FROM document_user_restrictions
     WHERE document_id = ?
       AND user_id = ?
       AND expires_at > ?
     LIMIT 1
  `).get(docId, userId, nowMs()) || null;
}

export function getDocumentAccess(docId, userId, { includeDenied = false } = {}) {
  const row = db.prepare(`
    SELECT d.*,
           (d.owner_id = ?) AS is_owner,
           (SELECT role FROM document_shares WHERE document_id = d.id AND user_id = ?) AS share_role,
           (SELECT can_moderate FROM document_shares WHERE document_id = d.id AND user_id = ?) AS share_can_moderate
      FROM documents d
     WHERE d.id = ?
  `).get(userId, userId, userId, docId);
  if (!row) return null;
  const baseRole = row.is_owner ? 'owner' : (row.share_role || null);
  if (!baseRole) return null;
  const restriction = baseRole === 'owner' ? null : getActiveDocumentRestriction(docId, userId);
  if (restriction?.action === 'kick') {
    if (!includeDenied) return null;
    return {
      document: row,
      role: null,
      baseRole,
      canModerate: false,
      denied: 'temporarily_removed',
      restriction
    };
  }
  const role = restriction?.action === 'viewer' ? 'viewer' : baseRole;
  const canModerate = role === 'owner' || (role === 'editor' && !!row.share_can_moderate);
  return { document: row, role, baseRole, canModerate, restriction };
}

export function createDocument({ ownerId, title = 'Untitled', capacity = 0 }) {
  const id = newId('doc');
  const now = nowMs();
  db.prepare(
    `INSERT INTO documents (id, owner_id, title, capacity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, ownerId, title, Number(capacity) || 0, now, now);
  return getDocument(id);
}

export function touchDocument(docId) {
  db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(nowMs(), docId);
}

export function saveYDocState(docId, state) {
  db.prepare('UPDATE documents SET ydoc_state = ?, updated_at = ? WHERE id = ?')
    .run(state, nowMs(), docId);
}

export function getYDocState(docId) {
  const row = db.prepare('SELECT ydoc_state FROM documents WHERE id = ?').get(docId);
  return row?.ydoc_state || null;
}

export function deleteDocument(docId) {
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
}

export function setDocumentTitle(docId, title) {
  db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?')
    .run(String(title).slice(0, 200) || 'Untitled', nowMs(), docId);
}

export function setDocumentCapacity(docId, capacity) {
  db.prepare('UPDATE documents SET capacity = ?, updated_at = ? WHERE id = ?')
    .run(Math.max(0, Math.floor(Number(capacity) || 0)), nowMs(), docId);
}

export function effectiveCapacity(doc) {
  if (doc.capacity && doc.capacity > 0) return doc.capacity;
  return config.defaultDocumentCapacity || 0;
}

export function listShares(docId) {
  const now = nowMs();
  return db.prepare(`
    SELECT s.id,
           s.user_id,
           s.role,
           CASE WHEN r.action = 'viewer' THEN 'viewer' ELSE s.role END AS effective_role,
           s.can_moderate,
           s.created_at,
           u.email,
           u.display_name,
           u.is_guest,
           r.action AS restriction_action,
           r.expires_at AS restriction_expires_at
      FROM document_shares s JOIN users u ON u.id = s.user_id
      LEFT JOIN document_user_restrictions r
        ON r.document_id = s.document_id
       AND r.user_id = s.user_id
       AND r.expires_at > ?
     WHERE s.document_id = ?
     ORDER BY s.created_at ASC
  `).all(now, docId);
}

export function addShareByUserId(docId, userId, role = 'editor') {
  const cleanRole = role === 'viewer' ? 'viewer' : 'editor';
  db.prepare(
    `INSERT INTO document_shares (id, document_id, user_id, role, can_moderate, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id, user_id) DO UPDATE SET
       role = excluded.role,
       can_moderate = CASE
         WHEN excluded.role = 'viewer' THEN 0
         ELSE document_shares.can_moderate
       END`
  ).run(newId('shr'), docId, userId, cleanRole, 0, nowMs());
}

export function removeShare(docId, userId) {
  db.prepare('DELETE FROM document_user_restrictions WHERE document_id = ? AND user_id = ?')
    .run(docId, userId);
  db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?')
    .run(docId, userId);
}

export function getShare(docId, userId) {
  return db.prepare('SELECT * FROM document_shares WHERE document_id = ? AND user_id = ?')
    .get(docId, userId) || null;
}

export function setShareCanModerate(docId, userId, canModerate) {
  const share = getShare(docId, userId);
  if (!share) return { ok: false, reason: 'not_found' };
  if (canModerate && share.role !== 'editor') {
    return { ok: false, reason: 'viewers_cannot_moderate' };
  }
  db.prepare(`
    UPDATE document_shares
       SET can_moderate = ?
     WHERE document_id = ?
       AND user_id = ?
  `).run(canModerate && share.role === 'editor' ? 1 : 0, docId, userId);
  return { ok: true };
}

export function setDocumentUserRestriction(docId, userId, { action, expiresAt, createdBy }) {
  const cleanAction = action === 'viewer' ? 'viewer' : 'kick';
  const id = newId('dur');
  const now = nowMs();
  db.prepare(`
    INSERT INTO document_user_restrictions
      (id, document_id, user_id, action, expires_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id, user_id) DO UPDATE SET
      action = excluded.action,
      expires_at = excluded.expires_at,
      created_by = excluded.created_by,
      created_at = excluded.created_at
  `).run(id, docId, userId, cleanAction, expiresAt, createdBy || null, now);
  return getActiveDocumentRestriction(docId, userId);
}

export function clearDocumentUserRestriction(docId, userId) {
  db.prepare('DELETE FROM document_user_restrictions WHERE document_id = ? AND user_id = ?')
    .run(docId, userId);
}

export function createInviteLink(docId, { role = 'editor', maxUses = 0, expiresAt = null, allowGuests = true } = {}) {
  const token = randomToken(24);
  db.prepare(
    `INSERT INTO invite_links (token, document_id, role, created_at, expires_at, max_uses, uses, revoked, allow_guests)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(token, docId, role, nowMs(), expiresAt, Math.max(0, Math.floor(maxUses)), allowGuests ? 1 : 0);
  return token;
}

export function getInviteLink(token) {
  return db.prepare('SELECT * FROM invite_links WHERE token = ?').get(token);
}

export function consumeInviteLink(token) {
  const row = getInviteLink(token);
  if (!row || row.revoked) return null;
  if (row.expires_at && row.expires_at < nowMs()) return null;
  if (row.max_uses && row.uses >= row.max_uses) return null;
  db.prepare('UPDATE invite_links SET uses = uses + 1 WHERE token = ?').run(token);
  return row;
}

export function listInviteLinks(docId) {
  return db.prepare(
    'SELECT * FROM invite_links WHERE document_id = ? ORDER BY created_at DESC'
  ).all(docId);
}

export function revokeInviteLink(token) {
  db.prepare('UPDATE invite_links SET revoked = 1 WHERE token = ?').run(token);
}

export function createEmailInvite({ docId, email, role = 'editor', invitedBy, allowGuests = true }) {
  const token = randomToken(24);
  db.prepare(
    `INSERT INTO email_invites (id, document_id, email, role, invited_by, created_at, consumed, token, allow_guests)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(newId('einv'), docId, String(email).toLowerCase(), role, invitedBy, nowMs(), token, allowGuests ? 1 : 0);
  return token;
}

export function getEmailInvite(token) {
  return db.prepare('SELECT * FROM email_invites WHERE token = ?').get(token);
}

export function consumeEmailInvite(token, userEmail) {
  const row = db.prepare('SELECT * FROM email_invites WHERE token = ?').get(token);
  if (!row || row.consumed) return null;
  if (row.email.toLowerCase() !== String(userEmail).toLowerCase()) return null;
  db.prepare('UPDATE email_invites SET consumed = 1 WHERE id = ?').run(row.id);
  return row;
}

export function pendingEmailInvitesFor(email) {
  return db.prepare(
    `SELECT * FROM email_invites WHERE email = ? AND consumed = 0`
  ).all(String(email).toLowerCase());
}
