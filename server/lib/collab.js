import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { getDocumentAccess, saveYDocState, getYDocState, touchDocument, effectiveCapacity } from './documents.js';
import { readSessionCookie, getSession } from './sessions.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;
const MESSAGE_PRESENCE_SUMMARY = 100;

const PING_TIMEOUT_MS = 30_000;
const PERSIST_DEBOUNCE_MS = 1500;

class CollabDoc {
  constructor(docId) {
    this.id = docId;
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalState(null);
    /** @type {Map<WebSocket, {userId, displayName, role, color, awarenessIds: Set<number>}>} */
    this.conns = new Map();
    this.persistTimer = null;

    const existing = getYDocState(docId);
    if (existing) {
      try { Y.applyUpdate(this.ydoc, existing); }
      catch (e) { console.error('[collab] failed to load state for', docId, e.message); }
    }

    this.ydoc.on('update', (update, origin) => {
      this.broadcastSync(update, origin);
      this.schedulePersist();
    });

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = [...added, ...updated, ...removed];
      if (origin && this.conns.has(origin)) {
        const meta = this.conns.get(origin);
        for (const id of added) meta.awarenessIds.add(id);
        for (const id of updated) meta.awarenessIds.add(id);
        for (const id of removed) meta.awarenessIds.delete(id);
      }
      const buf = encoding.createEncoder();
      encoding.writeVarUint(buf, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(buf,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const payload = encoding.toUint8Array(buf);
      for (const ws of this.conns.keys()) {
        if (ws !== origin && ws.readyState === ws.OPEN) ws.send(payload);
      }
      this.broadcastPresenceSummary();
    });
  }

  broadcastSync(update, origin) {
    const buf = encoding.createEncoder();
    encoding.writeVarUint(buf, MESSAGE_SYNC);
    syncProtocol.writeUpdate(buf, update);
    const payload = encoding.toUint8Array(buf);
    for (const ws of this.conns.keys()) {
      if (ws !== origin && ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const state = Buffer.from(Y.encodeStateAsUpdate(this.ydoc));
        saveYDocState(this.id, state);
        touchDocument(this.id);
      } catch (e) {
        console.error('[collab] persist failed for', this.id, e.message);
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  flush() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    const state = Buffer.from(Y.encodeStateAsUpdate(this.ydoc));
    saveYDocState(this.id, state);
  }

  countParticipants() {
    const seen = new Set();
    for (const meta of this.conns.values()) seen.add(meta.userId);
    return seen.size;
  }

  broadcastPresenceSummary() {
    const participants = [];
    const seen = new Set();
    for (const meta of this.conns.values()) {
      if (seen.has(meta.userId)) continue;
      seen.add(meta.userId);
      participants.push({
        userId: meta.userId,
        displayName: meta.displayName,
        role: meta.role,
        color: meta.color
      });
    }
    const summary = JSON.stringify({
      type: 'presence',
      participants,
      capacity: this.capacity || 0
    });
    const buf = encoding.createEncoder();
    encoding.writeVarUint(buf, MESSAGE_PRESENCE_SUMMARY);
    encoding.writeVarString(buf, summary);
    const payload = encoding.toUint8Array(buf);
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

const docs = new Map();
function getOrCreateDoc(docId) {
  let d = docs.get(docId);
  if (!d) { d = new CollabDoc(docId); docs.set(docId, d); }
  return d;
}

export function docCapacityInUse(docId) {
  const d = docs.get(docId);
  return d ? d.countParticipants() : 0;
}

function colorFor(userId) {
  const palette = ['#e57373','#ba68c8','#7986cb','#4dd0e1','#81c784','#ffb74d','#a1887f','#90a4ae','#f06292','#9575cd'];
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(data);
}

function sendSyncStep1(ws, doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc.ydoc);
  send(ws, encoding.toUint8Array(enc));
}

function sendInitialAwareness(ws, doc) {
  const states = doc.awareness.getStates();
  if (states.size === 0) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    enc,
    awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()])
  );
  send(ws, encoding.toUint8Array(enc));
}

function handleMessage(ws, doc, data, meta) {
  try {
    const dec = decoding.createDecoder(data);
    const enc = encoding.createEncoder();
    const messageType = decoding.readVarUint(dec);
    switch (messageType) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        if (meta.role === 'viewer') {
          // Viewers cannot push changes — respond with sync step but ignore updates.
          const subType = decoding.readVarUint(dec);
          if (subType === 0) { // syncStep1
            const sv = decoding.readVarUint8Array(dec);
            syncProtocol.writeSyncStep2(enc, doc.ydoc, sv);
            if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
          }
          return;
        }
        syncProtocol.readSyncMessage(dec, enc, doc.ydoc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(dec), ws);
        break;
      }
      case MESSAGE_QUERY_AWARENESS: {
        sendInitialAwareness(ws, doc);
        break;
      }
      default:
        // ignore
    }
  } catch (e) {
    console.error('[collab] message error:', e.message);
  }
}

function closeWith(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}

export function attachCollabServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = request.url || '';
    if (!url.startsWith('/ws/doc/')) return;

    const docId = url.replace(/^\/ws\/doc\//, '').split('?')[0];
    request.headers.cookie = request.headers.cookie || '';

    const sid = readSessionCookie(request);
    const session = sid ? getSession(sid) : null;
    if (!session || session.pending2FA) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!session.user.emailVerified) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const access = getDocumentAccess(docId, session.userId);
    if (!access) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const role = access.role;
      const cap = effectiveCapacity(access.document);
      const doc = getOrCreateDoc(docId);
      doc.capacity = cap;

      // If the user is already connected, they're "rejoining" — don't count against capacity.
      const alreadyPresent = [...doc.conns.values()].some(m => m.userId === session.userId);
      if (cap > 0 && !alreadyPresent && doc.countParticipants() >= cap) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_PRESENCE_SUMMARY);
        encoding.writeVarString(enc, JSON.stringify({
          type: 'capacity_reached',
          capacity: cap,
          current: doc.countParticipants()
        }));
        send(ws, encoding.toUint8Array(enc));
        closeWith(ws, 4003, 'capacity_reached');
        return;
      }

      const meta = {
        userId: session.userId,
        displayName: session.user.displayName,
        role,
        color: colorFor(session.userId),
        awarenessIds: new Set()
      };
      doc.conns.set(ws, meta);

      let isAlive = true;
      ws.on('pong', () => { isAlive = true; });
      const ping = setInterval(() => {
        if (!isAlive) { closeWith(ws, 1001, 'ping_timeout'); return; }
        isAlive = false;
        try { ws.ping(); } catch {}
      }, PING_TIMEOUT_MS);

      ws.on('message', (data, isBinary) => {
        if (!isBinary) return; // we only speak the binary y-protocol + presence
        handleMessage(ws, doc, new Uint8Array(data), meta);
      });

      ws.on('close', () => {
        clearInterval(ping);
        const closingMeta = doc.conns.get(ws);
        doc.conns.delete(ws);
        if (closingMeta && closingMeta.awarenessIds.size > 0) {
          awarenessProtocol.removeAwarenessStates(
            doc.awareness,
            [...closingMeta.awarenessIds],
            ws
          );
        }
        doc.broadcastPresenceSummary();
        if (doc.conns.size === 0) {
          doc.flush();
        }
      });

      ws.on('error', () => { /* swallow */ });

      sendSyncStep1(ws, doc);
      sendInitialAwareness(ws, doc);
      doc.broadcastPresenceSummary();

      // Send a JSON "hello" with role/color so the client can theme itself.
      const helloEnc = encoding.createEncoder();
      encoding.writeVarUint(helloEnc, MESSAGE_PRESENCE_SUMMARY);
      encoding.writeVarString(helloEnc, JSON.stringify({
        type: 'hello',
        you: meta,
        capacity: cap
      }));
      send(ws, encoding.toUint8Array(helloEnc));
    });
  });

  function flushAll() {
    for (const doc of docs.values()) {
      try { doc.flush(); } catch {}
    }
  }
  process.on('SIGINT', () => { flushAll(); process.exit(0); });
  process.on('SIGTERM', () => { flushAll(); process.exit(0); });
}
