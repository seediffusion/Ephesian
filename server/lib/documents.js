import { db, nowMs } from './db.js';
import { newId, randomToken } from './ids.js';
import { config } from './config.js';

export function listDocumentsForUser(userId) {
  return db.prepare(`
    SELECT d.id, d.title, d.capacity, d.created_at, d.updated_at, d.owner_id,
           (d.owner_id = ?) AS is_owner,
           (SELECT role FROM document_shares WHERE document_id = d.id AND user_id = ?) AS share_role
      FROM documents d
      LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
     WHERE d.owner_id = ? OR s.user_id = ?
     ORDER BY d.updated_at DESC
  `).all(userId, userId, userId, userId, userId);
}

export function getDocument(docId) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

export function getDocumentAccess(docId, userId) {
  const row = db.prepare(`
    SELECT d.*,
           (d.owner_id = ?) AS is_owner,
           (SELECT role FROM document_shares WHERE document_id = d.id AND user_id = ?) AS share_role
      FROM documents d
     WHERE d.id = ?
  `).get(userId, userId, docId);
  if (!row) return null;
  const access = row.is_owner ? 'owner' : (row.share_role || null);
  if (!access) return null;
  return { document: row, role: access };
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
  return db.prepare(`
    SELECT s.id, s.user_id, s.role, s.created_at, u.email, u.display_name
      FROM document_shares s JOIN users u ON u.id = s.user_id
     WHERE s.document_id = ?
     ORDER BY s.created_at ASC
  `).all(docId);
}

export function addShareByUserId(docId, userId, role = 'editor') {
  db.prepare(
    `INSERT INTO document_shares (id, document_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(document_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(newId('shr'), docId, userId, role, nowMs());
}

export function removeShare(docId, userId) {
  db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?')
    .run(docId, userId);
}

export function createInviteLink(docId, { role = 'editor', maxUses = 0, expiresAt = null } = {}) {
  const token = randomToken(24);
  db.prepare(
    `INSERT INTO invite_links (token, document_id, role, created_at, expires_at, max_uses, uses, revoked)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`
  ).run(token, docId, role, nowMs(), expiresAt, Math.max(0, Math.floor(maxUses)));
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

export function createEmailInvite({ docId, email, role = 'editor', invitedBy }) {
  const token = randomToken(24);
  db.prepare(
    `INSERT INTO email_invites (id, document_id, email, role, invited_by, created_at, consumed, token)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(newId('einv'), docId, String(email).toLowerCase(), role, invitedBy, nowMs(), token);
  return token;
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
