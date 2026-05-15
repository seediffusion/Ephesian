import { Editor, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table, { TableView, createColGroup } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const MESSAGE_PRESENCE_SUMMARY = 100;

const AccessibleTable = Table.extend({
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      accessibleName: {
        default: null,
        parseHTML: element => {
          const caption = element.querySelector(':scope > caption')?.textContent?.trim();
          return caption || element.getAttribute('aria-label') || null;
        },
        renderHTML: () => ({})
      }
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const { colgroup, tableWidth, tableMinWidth } = createColGroup(node, this.options.cellMinWidth);
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      style: tableWidth ? `width: ${tableWidth}` : `min-width: ${tableMinWidth}`
    });
    const caption = node.attrs.accessibleName
      ? [['caption', {}, node.attrs.accessibleName]]
      : [];
    const table = ['table', attrs, ...caption, colgroup, ['tbody', 0]];
    return this.options.renderWrapper ? ['div', { class: 'tableWrapper' }, table] : table;
  }
});

class AccessibleTableView extends TableView {
  constructor(node, cellMinWidth) {
    super(node, cellMinWidth);
    this.updateCaption(node);
  }

  update(node) {
    const ok = super.update(node);
    if (ok) this.updateCaption(node);
    return ok;
  }

  updateCaption(node) {
    const label = String(node.attrs.accessibleName || '').trim();
    if (!label) {
      this.table.removeAttribute('aria-label');
      this.caption?.remove();
      this.caption = null;
      return;
    }
    this.table.removeAttribute('aria-label');
    if (!this.caption) {
      this.caption = document.createElement('caption');
      this.table.insertBefore(this.caption, this.table.firstChild);
    }
    this.caption.textContent = label;
  }
}

export class CollabSession {
  constructor({
    docId,
    mountEl,
    user,
    role,
    onPresence,
    onStatus,
    onCapacityReached,
    onRoleChanged,
    onAccessRevoked
  }) {
    this.docId = docId;
    this.user = user;
    this.role = role;
    this.onPresence = onPresence;
    this.onStatus = onStatus;
    this.onCapacityReached = onCapacityReached;
    this.onRoleChanged = onRoleChanged;
    this.onAccessRevoked = onAccessRevoked;
    this.ydoc = new Y.Doc();
    this.persistence = new IndexeddbPersistence('ephesian-' + docId, this.ydoc);
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.displayName || user.email,
      color: colorFor(user.id)
    });
    this.ws = null;
    this.shouldReconnect = true;
    this.reconnectDelay = 1000;
    this.revokedPayload = null;
    this.revokedNotified = false;
    this.editor = null;
    this.mountEl = mountEl;
    this._initEditor();
    this._connect();

    this.persistence.on('synced', () => {
      // local content loaded
      onStatus && onStatus({ state: 'local-ready' });
    });
  }

  _initEditor() {
    const editable = this.role !== 'viewer';
    this.editor = new Editor({
      element: this.mountEl,
      editable,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': editable ? 'Document content. Rich text editor.' : 'Document content. Read-only.',
          'aria-readonly': editable ? 'false' : 'true'
        }
      },
      extensions: [
        StarterKit.configure({ history: false }), // history is owned by Collaboration
        Underline,
        Link.configure({ openOnClick: true, autolink: true, linkOnPaste: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        AccessibleTable.configure({
          resizable: true,
          View: AccessibleTableView
        }),
        TableRow,
        TableHeader.configure({ HTMLAttributes: { scope: 'col' } }),
        TableCell,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Image.configure({ inline: false }),
        Placeholder.configure({ placeholder: 'Start typing your document…' }),
        Collaboration.configure({ document: this.ydoc }),
        CollaborationCursor.configure({
          provider: { awareness: this.awareness },
          user: { name: this.user.displayName || this.user.email, color: colorFor(this.user.id) }
        })
      ]
    });
    this._syncEditorAccess();
  }

  _syncEditorAccess() {
    if (!this.editor) return;
    const editable = this.role !== 'viewer';
    this.editor.setEditable(editable);
    const dom = this.editor.view?.dom;
    if (dom) {
      dom.setAttribute('aria-readonly', editable ? 'false' : 'true');
      dom.setAttribute('aria-label', editable ? 'Document content. Rich text editor.' : 'Document content. Read-only.');
    }
  }

  _notifyAccessRevoked(payload) {
    if (this.revokedNotified) return;
    this.revokedNotified = true;
    this.onAccessRevoked && this.onAccessRevoked(payload || { reason: 'temporarily_removed' });
  }

  _connect() {
    if (!this.shouldReconnect) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/doc/${encodeURIComponent(this.docId)}`;
    this.onStatus && this.onStatus({ state: 'connecting' });
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { this._scheduleReconnect(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      this.onStatus && this.onStatus({ state: 'connected' });
      // syncStep1 → server
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, this.ydoc);
      ws.send(encoding.toUint8Array(enc));
      // ask for current awareness
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_QUERY_AWARENESS);
      ws.send(encoding.toUint8Array(aenc));
      // publish our awareness
      const localStates = this.awareness.getStates();
      if (localStates.size) {
        const ue = encoding.createEncoder();
        encoding.writeVarUint(ue, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(ue, awarenessProtocol.encodeAwarenessUpdate(
          this.awareness, [this.awareness.clientID]
        ));
        ws.send(encoding.toUint8Array(ue));
      }
    });

    ws.addEventListener('message', (event) => {
      const data = new Uint8Array(event.data);
      this._handleMessage(data);
    });

    ws.addEventListener('close', (e) => {
      this.ws = null;
      if (e.code === 4003) {
        this.shouldReconnect = false;
        this.onCapacityReached && this.onCapacityReached();
        return;
      }
      if (e.code === 4004) {
        this.shouldReconnect = false;
        this._notifyAccessRevoked(this.revokedPayload);
        return;
      }
      this.onStatus && this.onStatus({ state: 'offline' });
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // close will follow
    });

    // Pipe local Y.Doc updates → server.
    this._docUpdateHandler = (update, origin) => {
      if (origin === this) return; // don't echo our own
      if (this.role === 'viewer') return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeUpdate(enc, update);
        this.ws.send(encoding.toUint8Array(enc));
      }
    };
    this.ydoc.on('update', this._docUpdateHandler);

    this._awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      if (origin === 'remote') return;
      const changed = [...added, ...updated, ...removed];
      if (!changed.length) return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.ws.send(encoding.toUint8Array(enc));
      }
    };
    this.awareness.on('update', this._awarenessUpdateHandler);
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    setTimeout(() => this._connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000);
  }

  _handleMessage(data) {
    try {
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      switch (type) {
        case MESSAGE_SYNC: {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(dec, enc, this.ydoc, this);
          if (encoding.length(enc) > 1 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(encoding.toUint8Array(enc));
          }
          break;
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), 'remote');
          break;
        }
        case MESSAGE_PRESENCE_SUMMARY: {
          const payload = JSON.parse(decoding.readVarString(dec));
          if (payload.type === 'presence') {
            this.onPresence && this.onPresence(payload);
          } else if (payload.type === 'hello') {
            this.helloPayload = payload;
          } else if (payload.type === 'capacity_reached') {
            this.onCapacityReached && this.onCapacityReached(payload);
          } else if (payload.type === 'role_changed') {
            this.role = payload.role;
            this._syncEditorAccess();
            this.onRoleChanged && this.onRoleChanged(payload);
          } else if (payload.type === 'access_revoked') {
            this.revokedPayload = payload;
            this.shouldReconnect = false;
            this._notifyAccessRevoked(payload);
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(4004, 'temporarily_removed');
          }
          break;
        }
      }
    } catch (e) {
      console.error('[editor] message decode error', e);
    }
  }

  importHtml(html) {
    if (!this.editor) return;
    if (this.role === 'viewer') return;
    this.editor.commands.setContent(html, true);
  }

  getHtml() {
    return this.editor ? this.editor.getHTML() : '';
  }

  destroy() {
    this.shouldReconnect = false;
    if (this.ydoc && this._docUpdateHandler) this.ydoc.off('update', this._docUpdateHandler);
    if (this.awareness && this._awarenessUpdateHandler) this.awareness.off('update', this._awarenessUpdateHandler);
    if (this.editor) this.editor.destroy();
    if (this.ws) { try { this.ws.close(); } catch {} }
    if (this.persistence) { try { this.persistence.destroy(); } catch {} }
  }
}

function colorFor(userId) {
  // Medium-dark colors keep white cursor labels and avatar initials readable
  // while still contrasting with both light and dark editor surfaces.
  const palette = ['#dc2626','#c026d3','#047857','#047481','#0e7490','#15803d','#b45309','#db2777','#9333ea','#2563eb'];
  let h = 0;
  for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
