import { h, busy, toast, openModal, confirm, announceRoute, announce, nextId, icon, srOnly } from '../ui.js';
import { api, downloadFile, fetchMe, meUser } from '../api.js';
import { navigate } from '../router.js';
import { CollabSession } from '../editor.js';

let currentSession = null;

window.addEventListener('beforeunload', () => {
  if (currentSession) try { currentSession.destroy(); } catch {}
});

export async function renderEditorPage(main, params) {
  await fetchMe(true);
  const user = meUser();
  if (!user) { navigate('/login?next=' + encodeURIComponent('/d/' + params.id)); return; }

  let info;
  try {
    info = await api('/api/documents/' + params.id);
  } catch (e) {
    if (e.status === 403 && e.data?.error === 'temporarily_removed') {
      main.innerHTML = '';
      showTemporaryRemoval(main, { id: params.id, title: 'this document' }, e.data.restriction || {});
      return;
    }
    main.innerHTML = '';
    main.appendChild(h('div', { class: 'callout danger', role: 'alert' }, [
      e.status === 404 ? 'This document does not exist or has not been shared with you.' :
      e.status === 403 ? 'You do not have permission to open this document.' :
                         'Could not open this document.'
    ]));
    announceRoute('Document — error');
    return;
  }
  const { document: doc, role } = info;
  const permissions = info.permissions || {};
  let activeRole = role;
  const isOwner = role === 'owner';
  const canModerate = !!permissions.canModerate;

  main.innerHTML = '';

  const headingId = nextId('editor-heading');
  const shell = h('section', { class: 'editor-shell', 'aria-labelledby': headingId });
  main.appendChild(shell);

  // Visually hidden h1 — sighted users see the title input; AT users still get a heading
  // for landmark navigation. The input's accessible name conveys editability separately.
  shell.appendChild(h('h1', { id: headingId, class: 'sr-only' }, [doc.title || 'Untitled']));

  const titleInputId = nextId('doc-title-input');
  const titleInput = h('input', {
    class: 'title-input',
    type: 'text',
    id: titleInputId,
    value: doc.title,
    'aria-label': 'Document title',
    readonly: !isOwner
  });
  let titleSaveTimer = null;
  titleInput.addEventListener('input', () => {
    if (!isOwner) return;
    const t = titleInput.value || 'Untitled';
    document.title = `${t} · Ephesian`;
    document.getElementById(headingId).textContent = t;
    clearTimeout(titleSaveTimer);
    titleSaveTimer = setTimeout(async () => {
      try { await api('/api/documents/' + doc.id, { method: 'PATCH', body: { title: titleInput.value } }); }
      catch {}
    }, 500);
  });

  const statusDot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const statusLabel = h('span', {}, ['Connecting']);
  // The visible label updates immediately on every state change; the polite live region
  // (next sibling) is only updated when a state persists for >1.2s, avoiding spam when
  // the WebSocket flaps. role="group" on the visible container so SR doesn't double-announce.
  const statusAnnouncer = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  const status = h('div', {
    class: 'editor-status',
    role: 'group',
    'aria-label': 'Connection status'
  }, [statusDot, statusLabel, statusAnnouncer]);
  let statusAnnounceTimer = null;
  let lastAnnouncedState = null;

  const presenceHeadingId = nextId('presence');
  const presenceList = h('ul', {
    class: 'presence list-reset',
    role: 'list',
    'aria-labelledby': presenceHeadingId
  });
  const presenceHeading = h('span', {
    id: presenceHeadingId,
    class: 'sr-only'
  }, ['Collaborators currently in this document']);
  const presenceLive = h('div', {
    class: 'sr-only',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true'
  });
  const presenceWrap = h('div', {
    class: 'presence-wrap',
    style: { display: 'flex', alignItems: 'center', gap: '0.4rem' }
  }, [presenceHeading, presenceList, presenceLive]);

  const shareBtn = canModerate
    ? h('button', {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        'aria-haspopup': 'dialog',
        onclick: () => openShareDialog(doc)
      }, [isOwner ? 'Share' : 'Manage users'])
    : null;

  const exportBtn = h('button', {
    type: 'button',
    class: 'btn btn-sm',
    onclick: () => openExportMenu(doc),
    'aria-haspopup': 'dialog'
  }, ['Export', icon(' ▾')]);
  const importBtn = (role !== 'viewer')
    ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => doImport(doc) }, ['Import a file']) : null;
  const backBtn = h('a', {
    class: 'btn btn-ghost btn-sm',
    href: '/dashboard',
    'data-link': ''
  }, [icon('← '), 'All documents']);

  const roleTag = h('span', { class: 'tag' }, [activeRole.charAt(0).toUpperCase() + activeRole.slice(1)]);
  shell.appendChild(h('div', { class: 'editor-meta' }, [
    backBtn, titleInput,
    roleTag,
    status,
    h('div', { style: { flex: '1' }, 'aria-hidden': 'true' }),
    presenceWrap,
    importBtn, exportBtn, shareBtn
  ].filter(Boolean)));

  // ---- Toolbar (only for editors/owners — viewers see no formatting controls because the editor is read-only) ----
  let canEdit = activeRole !== 'viewer';
  let toolbar = null;
  if (canEdit) {
    const toolbarHeadingId = nextId('tbar');
    shell.appendChild(h('span', { id: toolbarHeadingId, class: 'sr-only' }, ['Formatting toolbar']));
    toolbar = h('div', {
      class: 'editor-toolbar',
      role: 'toolbar',
      'aria-labelledby': toolbarHeadingId,
      'aria-orientation': 'horizontal'
    });
    shell.appendChild(toolbar);
  }

  // ---- Surface ----
  // The contenteditable inside (editor.js editorProps) carries its own role/aria-label,
  // including the read-only state for viewers. The wrapper label here is decorative —
  // we keep it only to give the section a stable name and we adjust the wording so
  // viewers (who have no toolbar above) don't hear an instruction that doesn't apply.
  const surfaceLabelId = nextId('surface-lbl');
  const surfaceLabel = h('span', { id: surfaceLabelId, class: 'sr-only' }, [
    canEdit
      ? 'Document content. Use the formatting toolbar above for rich-text controls.'
      : 'Document content. This document is read-only for your account.'
  ]);
  shell.appendChild(surfaceLabel);
  const surface = h('div', {
    class: 'editor-surface',
    'aria-labelledby': surfaceLabelId
  });
  shell.appendChild(surface);

  if (currentSession) { try { currentSession.destroy(); } catch {} currentSession = null; }
  const session = new CollabSession({
    docId: doc.id,
    mountEl: surface,
    user,
    role,
    onStatus: (s) => {
      statusDot.classList.remove('connected', 'offline', 'error');
      let visible = '', spoken = '';
      if (s.state === 'connected') {
        statusDot.classList.add('connected');
        visible = 'Connected. Changes auto-save.';
        spoken = 'Connected.';
      } else if (s.state === 'offline') {
        statusDot.classList.add('offline');
        visible = 'Offline. Changes saved on this device only.';
        spoken = 'You are offline. Changes are being saved on this device only.';
      } else if (s.state === 'connecting') {
        visible = 'Connecting…';
        spoken = ''; // never announce transient connecting
      } else if (s.state === 'local-ready') {
        visible = 'Loaded from local backup.';
        spoken = '';
      }
      statusLabel.textContent = visible;
      // Debounce the spoken announcement: only fire if the same state persists 1.2s.
      // This prevents WebSocket flap from spamming the screen reader.
      if (statusAnnounceTimer) clearTimeout(statusAnnounceTimer);
      if (spoken && s.state !== lastAnnouncedState) {
        statusAnnounceTimer = setTimeout(() => {
          statusAnnouncer.textContent = '';
          // Defer one tick so the live region notices the change.
          setTimeout(() => { statusAnnouncer.textContent = spoken; }, 30);
          lastAnnouncedState = s.state;
        }, 1200);
      }
    },
    onPresence: (p) => {
      const limit = p.capacity || 0;
      const seen = new Map();
      for (const u of p.participants) seen.set(u.userId, u);
      const list = [...seen.values()];
      const prevIds = Array.from(presenceList.children).map(li => li.dataset.uid);
      const currentIds = list.map(u => u.userId);
      const joined = currentIds.filter(id => !prevIds.includes(id))
        .map(id => list.find(u => u.userId === id)?.displayName)
        .filter(Boolean);
      const left = prevIds.filter(id => !currentIds.includes(id));

      presenceList.innerHTML = '';
      const shown = list.slice(0, 6);
      for (const u of shown) {
        const initials = (u.displayName || '?').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
        const roleTxt = u.role ? ` (${u.role}${u.isGuest ? ', guest' : ''})` : (u.isGuest ? ' (guest)' : '');
        const children = [
          h('span', { 'aria-hidden': 'true' }, [initials]),
          srOnly(`${u.displayName}${roleTxt}`)
        ];
        if (u.isGuest) {
          // Real element (not ::after) so AT reliably excludes it via aria-hidden.
          children.push(h('span', { class: 'guest-badge', 'aria-hidden': 'true' }, ['G']));
        }
        presenceList.appendChild(h('li', {
          'data-uid': u.userId,
          class: 'presence-avatar' + (u.isGuest ? ' is-guest' : ''),
          style: { backgroundColor: u.color || '#666' },
          title: u.displayName + roleTxt
        }, children));
      }
      if (list.length > 6) {
        presenceList.appendChild(h('li', {
          class: 'presence-avatar',
          style: { backgroundColor: '#475569' }
        }, [
          h('span', { 'aria-hidden': 'true' }, ['+' + (list.length - 6)]),
          srOnly(`and ${list.length - 6} more`)
        ]));
      }
      const capacityText = limit > 0
        ? `${list.length} of ${limit} collaborators online`
        : `${list.length} collaborator${list.length === 1 ? '' : 's'} online`;
      let countTag = presenceWrap.querySelector('.presence-count');
      if (!countTag) {
        countTag = h('span', { class: 'tag presence-count' }, [capacityText]);
        presenceWrap.appendChild(countTag);
      } else {
        countTag.textContent = capacityText;
      }
      // Polite announce: who joined / left. Pluralise naturally.
      let msg = '';
      if (joined.length === 1) msg = `${joined[0]} joined.`;
      else if (joined.length === 2) msg = `${joined[0]} and ${joined[1]} joined.`;
      else if (joined.length > 2) msg = `${joined.slice(0, -1).join(', ')}, and ${joined[joined.length - 1]} joined.`;
      else if (left.length === 1) msg = 'One collaborator left.';
      else if (left.length > 1) msg = `${left.length} collaborators left.`;
      if (msg) {
        // Clear first so identical consecutive messages are still re-announced.
        presenceLive.textContent = '';
        setTimeout(() => { presenceLive.textContent = msg; }, 30);
      }
    },
    onCapacityReached: () => {
      session.destroy();
      main.innerHTML = '';
      const fullHeading = nextId('full-h');
      const card = h('section', { class: 'card callout warning', 'aria-labelledby': fullHeading, tabindex: '-1' }, [
        h('h1', { id: fullHeading }, ['This document is full']),
        h('p', {}, [
          'The owner has limited this document to ',
          h('strong', {}, [String(doc.effectiveCapacity || '')]),
          ' simultaneous collaborators. Try again later, or ask the owner to raise the limit.'
        ]),
        h('a', { href: '/dashboard', 'data-link': '', class: 'btn' }, ['Back to your documents'])
      ]);
      main.appendChild(card);
      announceRoute('This document is full');
      setTimeout(() => card.focus(), 0);
    },
    onRoleChanged: (payload) => {
      activeRole = payload.role || activeRole;
      canEdit = activeRole !== 'viewer';
      roleTag.textContent = activeRole.charAt(0).toUpperCase() + activeRole.slice(1);
      surfaceLabel.textContent = canEdit
        ? 'Document content. Use the formatting toolbar above for rich-text controls.'
        : 'Document content. This document is read-only for your account.';
      if (canEdit && !toolbar) {
        toast('Editing permissions restored.', 'success');
        setTimeout(() => renderEditorPage(main, params), 0);
        return;
      }
      if (!canEdit) {
        if (toolbar) { toolbar.remove(); toolbar = null; }
        if (importBtn?.isConnected) importBtn.remove();
        if (shareBtn?.isConnected) shareBtn.remove();
        const until = payload.expiresAt ? ` until ${new Date(payload.expiresAt).toLocaleString()}` : '';
        toast(`You are now a viewer${until}.`, 'warning');
        announce(`You are now a viewer${until}. Editing is disabled.`);
      }
    },
    onAccessRevoked: (payload) => {
      showTemporaryRemoval(main, doc, payload || {});
    }
  });
  currentSession = session;

  const pending = sessionStorage.getItem('ephesian.pendingImport:' + doc.id);
  if (pending) {
    sessionStorage.removeItem('ephesian.pendingImport:' + doc.id);
    setTimeout(() => session.importHtml(pending), 300);
  }

  if (toolbar) buildToolbar(toolbar, session);

  document.title = (doc.title || 'Untitled') + ' · Ephesian';
  announceRoute((doc.title || 'Untitled') + ' — document opened');
}

function showTemporaryRemoval(main, doc, payload = {}) {
  if (currentSession) {
    const closing = currentSession;
    currentSession = null;
    try { closing.destroy(); } catch {}
  }
  main.innerHTML = '';
  const removedHeading = nextId('removed-h');
  const until = payload.expiresAt ? new Date(payload.expiresAt).toLocaleString() : '';
  const card = h('section', { class: 'card callout warning', 'aria-labelledby': removedHeading, tabindex: '-1' }, [
    h('h1', { id: removedHeading }, ['You have been removed temporarily']),
    h('p', {}, [
      until
        ? `You cannot open "${doc.title || 'this document'}" again until ${until}.`
        : `You cannot open "${doc.title || 'this document'}" right now.`
    ]),
    h('a', { href: '/dashboard', 'data-link': '', class: 'btn' }, ['Back to your documents'])
  ]);
  main.appendChild(card);
  announceRoute('Document access paused');
  setTimeout(() => card.focus(), 0);
}

function buildToolbar(toolbar, session) {
  const editor = session.editor;
  // Each item: name (for aria-label), glyph (visible decoration), command, optional active() predicate.
  const items = [
    { type: 'btn', name: 'Bold (Ctrl+B)', glyph: 'B',
      cmd: () => editor.chain().focus().toggleBold().run(),
      active: () => editor.isActive('bold') },
    { type: 'btn', name: 'Italic (Ctrl+I)', glyph: 'I',
      cmd: () => editor.chain().focus().toggleItalic().run(),
      active: () => editor.isActive('italic') },
    { type: 'btn', name: 'Underline (Ctrl+U)', glyph: 'U',
      cmd: () => editor.chain().focus().toggleUnderline().run(),
      active: () => editor.isActive('underline') },
    { type: 'btn', name: 'Strikethrough', glyph: 'S',
      cmd: () => editor.chain().focus().toggleStrike().run(),
      active: () => editor.isActive('strike') },
    { type: 'btn', name: 'Inline code', glyph: '< >',
      cmd: () => editor.chain().focus().toggleCode().run(),
      active: () => editor.isActive('code') },
    { type: 'sep' },
    { type: 'btn', name: 'Heading level 1', glyph: 'H1',
      cmd: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      active: () => editor.isActive('heading', { level: 1 }) },
    { type: 'btn', name: 'Heading level 2', glyph: 'H2',
      cmd: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      active: () => editor.isActive('heading', { level: 2 }) },
    { type: 'btn', name: 'Heading level 3', glyph: 'H3',
      cmd: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      active: () => editor.isActive('heading', { level: 3 }) },
    { type: 'btn', name: 'Paragraph', glyph: 'P',
      cmd: () => editor.chain().focus().setParagraph().run(),
      active: () => editor.isActive('paragraph') },
    { type: 'sep' },
    { type: 'btn', name: 'Bullet list', glyph: 'List',
      cmd: () => editor.chain().focus().toggleBulletList().run(),
      active: () => editor.isActive('bulletList') },
    { type: 'btn', name: 'Numbered list', glyph: '1. List',
      cmd: () => editor.chain().focus().toggleOrderedList().run(),
      active: () => editor.isActive('orderedList') },
    { type: 'btn', name: 'Task list', glyph: 'Tasks',
      cmd: () => editor.chain().focus().toggleTaskList().run(),
      active: () => editor.isActive('taskList') },
    { type: 'btn', name: 'Blockquote', glyph: 'Quote',
      cmd: () => editor.chain().focus().toggleBlockquote().run(),
      active: () => editor.isActive('blockquote') },
    { type: 'btn', name: 'Horizontal rule', glyph: 'Rule',
      cmd: () => editor.chain().focus().setHorizontalRule().run() },
    { type: 'sep' },
    { type: 'btn', name: 'Undo (Ctrl+Z)', glyph: 'Undo',
      cmd: () => editor.chain().focus().undo().run() },
    { type: 'btn', name: 'Redo (Ctrl+Shift+Z)', glyph: 'Redo',
      cmd: () => editor.chain().focus().redo().run() },
    { type: 'btn', name: 'Insert or remove link', glyph: 'Link',
      cmd: () => promptLink(editor) },
    { type: 'btn', name: 'Insert table', glyph: 'Table',
      cmd: () => promptTable(editor) }
  ];

  toolbar.innerHTML = '';
  const stateful = [];
  const buttons = [];
  for (const it of items) {
    if (it.type === 'sep') {
      toolbar.appendChild(h('span', { class: 'sep', 'aria-hidden': 'true' }));
      continue;
    }
    const b = h('button', {
      type: 'button',
      'aria-label': it.name,
      title: it.name,
      tabindex: '-1',
      onclick: it.cmd
    }, [icon(it.glyph)]);
    if (it.active) stateful.push({ b, active: it.active });
    buttons.push(b);
    toolbar.appendChild(b);
  }
  // Make the first button the initial tab stop (roving tabindex).
  if (buttons.length) buttons[0].setAttribute('tabindex', '0');

  // Arrow-key navigation per ARIA Toolbar pattern.
  toolbar.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let target = -1;
    if (e.key === 'ArrowRight') target = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft') target = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = buttons.length - 1;
    if (target >= 0) {
      e.preventDefault();
      buttons[i].setAttribute('tabindex', '-1');
      buttons[target].setAttribute('tabindex', '0');
      buttons[target].focus();
    }
  });
  // Clicking a button also makes it the roving tab stop.
  toolbar.addEventListener('focusin', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    for (const b of buttons) b.setAttribute('tabindex', '-1');
    t.setAttribute('tabindex', '0');
  });

  function refresh() {
    for (const { b, active } of stateful) {
      const on = active();
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  editor.on('selectionUpdate', refresh);
  editor.on('transaction', refresh);
  refresh();

  // ----- Spoken feedback when a block-level format changes -----
  // Browsers do not announce contenteditable block-role changes (paragraph → heading
  // and similar) when the user applies them via toolbar OR keyboard shortcut. We hook
  // the ProseMirror transaction stream — which is the single funnel for both paths —
  // and pipe a short message through the existing polite live region.
  function formatSignature(state) {
    const $head = state.selection.$head;
    const parts = [];
    for (let d = 1; d <= $head.depth; d++) {
      const node = $head.node(d);
      const t = node.type.name;
      if (t === 'heading') parts.push(`h${node.attrs.level || 1}`);
      else parts.push(t);
    }
    return parts.join('/');
  }
  function formatHumanName(state) {
    const $head = state.selection.$head;
    // Walk from innermost outwards; the most specific wrapper wins.
    for (let d = $head.depth; d >= 1; d--) {
      const node = $head.node(d);
      switch (node.type.name) {
        case 'heading': return `Heading level ${node.attrs.level || 1}`;
        case 'codeBlock': return 'Code block';
        case 'blockquote': return 'Block quote';
        case 'taskList': return 'Task list';
        case 'bulletList': return 'Bullet list';
        case 'orderedList': return 'Numbered list';
      }
    }
    return 'Paragraph';
  }
  let lastBlockSig = formatSignature(editor.state);
  editor.on('transaction', ({ transaction }) => {
    const sig = formatSignature(editor.state);
    if (transaction.docChanged && sig !== lastBlockSig) {
      announce(`${formatHumanName(editor.state)} applied`);
    }
    lastBlockSig = sig;
  });
}

function promptLink(editor) {
  const urlId = nextId('link-url');
  const url = h('input', { type: 'url', id: urlId, placeholder: 'https://…', autocomplete: 'url' });
  const ok = h('button', {
    type: 'button', class: 'btn btn-primary',
    onclick: () => {
      const href = url.value.trim();
      if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      else editor.chain().focus().unsetLink().run();
      m.close();
    }
  }, ['Apply']);
  const remove = h('button', {
    type: 'button', class: 'btn btn-danger',
    onclick: () => { editor.chain().focus().unsetLink().run(); m.close(); }
  }, ['Remove link']);
  const cancel = h('button', {
    type: 'button', class: 'btn', onclick: () => m.close()
  }, ['Cancel']);
  const m = openModal({
    title: 'Insert or remove link',
    body: h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: urlId }, ['Link URL']),
      url,
      h('p', { class: 'field-help' }, ['Leave the URL blank and use "Remove link" to clear the link from the current selection.'])
    ]),
    footer: [cancel, remove, ok]
  });
}

function promptTable(editor) {
  const nameId = nextId('table-name');
  const errId = nextId('table-name-error');
  const nameInput = h('input', {
    type: 'text',
    id: nameId,
    maxlength: '120',
    autocomplete: 'off',
    required: true,
    'aria-describedby': errId
  });
  const err = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });

  const insert = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    onclick: () => form.requestSubmit()
  }, ['Insert table']);
  const cancel = h('button', {
    type: 'button',
    class: 'btn',
    onclick: () => m.close()
  }, ['Cancel']);
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      err.hidden = true;
      nameInput.removeAttribute('aria-invalid');
      const name = nameInput.value.trim();
      if (!name) {
        err.textContent = 'Enter a table name.';
        err.hidden = false;
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.focus();
        return;
      }
      editor.chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .updateAttributes('table', { accessibleName: name })
        .run();
      m.close();
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: nameId }, ['Table name']),
      nameInput
    ]),
    err
  ]);
  const m = openModal({
    title: 'Insert table',
    body: form,
    footer: [cancel, insert],
    initialFocus: nameInput
  });
}

function openExportMenu(doc) {
  const html = currentSession?.getHtml() || '';
  const formats = [
    { ext: 'docx', label: 'Microsoft Word (.docx)' },
    { ext: 'html', label: 'HTML (.html)' },
    { ext: 'md', label: 'Markdown (.md)' },
    { ext: 'txt', label: 'Plain text (.txt)' }
  ];
  const m = openModal({
    title: `Export "${doc.title}"`,
    body: h('div', {}, [
      h('p', { class: 'field-help' }, ['Choose a download format. Your current document is sent to the server for conversion.']),
      h('ul', { class: 'list-reset', style: { display: 'grid', gap: '0.5rem' } }, formats.map(f =>
        h('li', {}, [
          h('button', {
            type: 'button',
            class: 'btn btn-block',
            'aria-label': `Download as ${f.label}`,
            onclick: async (e) => {
              try {
                busy(e.currentTarget, true);
                await downloadFile('/api/documents/' + doc.id + '/export?format=' + f.ext, {
                  method: 'POST', body: { html },
                  filename: (doc.title || 'document').replace(/[^a-z0-9-_ ]+/gi, '_') + '.' + f.ext
                });
                m.close();
                toast(`Downloaded ${f.label}.`, 'success');
              } catch (err) {
                toast('Export failed: ' + (err.message || ''), 'error');
              } finally { busy(e.currentTarget, false); }
            }
          }, [f.label])
        ])
      ))
    ])
  });
}

function doImport(doc) {
  const input = window.document.createElement('input');
  input.type = 'file';
  input.accept = '.docx,.html,.htm,.md,.markdown,.txt';
  input.setAttribute('aria-label', 'Choose a document file to import');
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    if (!await confirm(
      'Import file?',
      'This will replace the current document content. Other collaborators will see the change. Continue?',
      { confirmLabel: 'Replace and import', kind: 'danger' }
    )) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await api('/api/documents/' + doc.id + '/import', { method: 'POST', body: fd });
      currentSession?.importHtml(r.html);
      toast(`Imported "${f.name}".`, 'success');
    } catch (e) {
      toast('Import failed: ' + (e.message || 'error'), 'error');
    }
  };
  input.click();
}

function openTemporaryActionDialog(doc, share, action, onDone) {
  const name = share.display_name || share.email;
  const durationId = nextId('moderation-duration');
  const errId = nextId('moderation-duration-error');
  const duration = h('input', {
    type: 'text',
    id: durationId,
    value: '15',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    maxlength: '5',
    autocomplete: 'off',
    required: true,
    'aria-describedby': errId
  });
  const err = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  const title = action === 'kick' ? `Remove ${name} temporarily` : `Make ${name} a viewer temporarily`;
  const submitLabel = action === 'kick' ? 'Remove temporarily' : 'Make viewer temporarily';
  const submit = h('button', {
    type: 'button',
    class: action === 'kick' ? 'btn btn-danger' : 'btn btn-primary',
    onclick: () => form.requestSubmit()
  }, [submitLabel]);
  const cancel = h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, ['Cancel']);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      duration.removeAttribute('aria-invalid');
      const minutes = Number(duration.value);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43200) {
        err.textContent = 'Enter a duration from 1 to 43200 minutes.';
        err.hidden = false;
        duration.setAttribute('aria-invalid', 'true');
        duration.focus();
        return;
      }
      busy(submit, true);
      try {
        const r = await api('/api/documents/' + doc.id + '/moderation', {
          method: 'POST',
          body: { userId: share.user_id, action, durationMinutes: minutes }
        });
        const until = r.restriction?.expiresAt ? ` until ${new Date(r.restriction.expiresAt).toLocaleString()}` : '';
        toast(action === 'kick' ? `${name} removed${until}.` : `${name} is a viewer${until}.`, 'success');
        m.close();
        onDone && onDone();
      } catch (ex) {
        err.textContent =
          ex.data?.error === 'cannot_target_self' ? 'You cannot apply this action to yourself.' :
          ex.data?.error === 'cannot_target_owner' ? 'The document owner cannot be restricted.' :
          ex.data?.error === 'target_not_editor' ? 'Only editors can be made temporary viewers.' :
          ex.data?.error === 'target_temporarily_removed' ? 'This user is already removed temporarily.' :
          'Could not apply the temporary restriction.';
        err.hidden = false;
        duration.setAttribute('aria-invalid', 'true');
        duration.focus();
      } finally {
        busy(submit, false);
      }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: durationId }, ['Duration in minutes']),
      duration,
      err
    ])
  ]);
  const m = openModal({
    title,
    body: form,
    footer: [cancel, submit],
    initialFocus: duration
  });
}

async function openShareDialog(doc) {
  const data = await api('/api/documents/' + doc.id + '/shares');
  const permissions = data.permissions || {};
  const canShare = !!permissions.canShare;
  const canGrantModeration = !!permissions.canGrantModeration;
  const canModerate = !!permissions.canModerate;
  const currentUserId = meUser()?.id;

  // ---- People list ----
  const peopleListId = nextId('share-people');
  const list = h('ul', { class: 'share-list', 'aria-labelledby': peopleListId });
  for (const s of data.shares) {
    const name = s.display_name || s.email;
    const effectiveRole = s.effective_role || s.role;
    const restrictionText = s.restriction_action
      ? `${s.restriction_action === 'kick' ? 'Removed' : 'Viewer'} until ${new Date(s.restriction_expires_at).toLocaleString()}`
      : '';
    const actions = [];

    if (canGrantModeration && effectiveRole === 'editor') {
      const modId = nextId('moderator-grant');
      const modToggle = h('input', {
        type: 'checkbox',
        id: modId,
        checked: !!s.can_moderate,
        'aria-label': `Allow ${name} to remove users or make editors temporary viewers`
      });
      modToggle.addEventListener('change', async () => {
        try {
          await api('/api/documents/' + doc.id + '/shares/' + s.user_id + '/permissions', {
            method: 'PATCH',
            body: { canModerate: modToggle.checked }
          });
          toast(modToggle.checked ? 'Special permissions granted.' : 'Special permissions revoked.', 'success');
          rebuild();
        } catch (e) {
          modToggle.checked = !modToggle.checked;
          toast(e.data?.error === 'viewers_cannot_moderate'
            ? 'Viewers cannot receive special permissions.'
            : 'Could not update special permissions.', 'error');
        }
      });
      actions.push(h('span', { class: 'permission-toggle' }, [
        modToggle,
        h('label', { for: modId }, ['Special permissions'])
      ]));
    }

    if (canModerate && s.user_id !== currentUserId && !s.restriction_action) {
      actions.push(h('button', {
        type: 'button',
        class: 'btn btn-sm',
        'aria-label': `Remove ${name} temporarily`,
        onclick: () => openTemporaryActionDialog(doc, s, 'kick', rebuild)
      }, ['Remove temporarily']));
      if (s.role === 'editor') {
        actions.push(h('button', {
          type: 'button',
          class: 'btn btn-sm',
          'aria-label': `Make ${name} a temporary viewer`,
          onclick: () => openTemporaryActionDialog(doc, s, 'viewer', rebuild)
        }, ['Make viewer temporarily']));
      }
    }

    if (canGrantModeration && s.restriction_action) {
      actions.push(h('button', {
        type: 'button',
        class: 'btn btn-sm',
        'aria-label': `Clear temporary restriction for ${name}`,
        onclick: async () => {
          await api('/api/documents/' + doc.id + '/moderation/' + s.user_id, { method: 'DELETE' });
          toast('Temporary restriction cleared.', 'success');
          rebuild();
        }
      }, ['Clear restriction']));
    }

    if (canShare) {
      const remove = h('button', {
        type: 'button',
        class: 'btn btn-sm btn-danger',
        'aria-label': `Remove ${name}`
      }, ['Remove']);
      remove.addEventListener('click', async () => {
        if (!await confirm(
          'Remove access?',
          `${name} will lose access immediately.`,
          { confirmLabel: 'Remove', kind: 'danger' }
        )) return;
        await api('/api/documents/' + doc.id + '/shares/' + s.user_id, { method: 'DELETE' });
        rebuild();
      });
      actions.push(remove);
    }

    list.appendChild(h('li', {}, [
      h('span', { class: 'share-person' }, [
        h('span', {}, [name]),
        h('span', { class: 'share-meta' }, [
          h('span', { class: 'tag' }, [effectiveRole === 'viewer' ? 'Viewer' : 'Editor']),
          s.is_guest ? h('span', { class: 'tag viewer' }, ['Guest']) : null,
          s.can_moderate && effectiveRole === 'editor' ? h('span', { class: 'tag owner' }, ['Special permissions']) : null,
          restrictionText ? h('span', { class: 'tag viewer' }, [restrictionText]) : null
        ].filter(Boolean))
      ]),
      h('span', { class: 'share-actions' }, actions)
    ]));
  }
  if (!data.shares.length) {
    list.appendChild(h('li', {}, [h('em', {}, ['No one else has direct access yet.'])]));
  }

  // ---- Invite by email ----
  const emailId = nextId('share-email');
  const emailErrId = nextId('share-email-error');
  const emailRoleId = nextId('share-role');
  const emailGuestsId = nextId('share-email-guests');
  const emailGuestsHelpId = nextId('share-email-guests-help');
  const emailInput = h('input', {
    type: 'email', id: emailId,
    placeholder: 'name@example.com',
    autocomplete: 'email',
    inputmode: 'email',
    'aria-describedby': emailErrId
  });
  const emailErr = h('div', {
    id: emailErrId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  const roleSel = h('select', { id: emailRoleId }, [
    h('option', { value: 'editor' }, ['Editor']),
    h('option', { value: 'viewer' }, ['Viewer'])
  ]);
  const emailGuests = h('input', {
    type: 'checkbox',
    id: emailGuestsId,
    checked: true,
    'aria-describedby': emailGuestsHelpId
  });
  const inviteBtn = h('button', { type: 'button', class: 'btn btn-primary' }, ['Send invitation']);
  inviteBtn.addEventListener('click', async () => {
    emailErr.hidden = true;
    emailInput.removeAttribute('aria-invalid');
    busy(inviteBtn, true);
    try {
      const r = await api('/api/documents/' + doc.id + '/invite-email', {
        method: 'POST',
        body: {
          email: emailInput.value.trim(),
          role: roleSel.value,
          allowGuests: !!emailGuests.checked
        }
      });
      toast(r.mode === 'direct' ? 'Added to document.' : 'Invitation email sent.', 'success');
      emailInput.value = '';
      rebuild();
    } catch (e) {
      emailErr.textContent = e.data?.error === 'invalid_email'
        ? 'Enter a valid email address.'
        : e.data?.error === 'too_many_attempts'
          ? 'Too many invitation attempts. Please wait a few minutes.'
          : 'Could not invite: ' + (e.data?.error || e.message || 'error');
      emailErr.hidden = false;
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
    } finally { busy(inviteBtn, false); }
  });

  // ---- Invite links ----
  const linksListId = nextId('invite-links');
  const linksList = h('ul', { class: 'share-list', 'aria-labelledby': linksListId });
  for (const l of data.invites) {
    const isExpired = l.expires_at && l.expires_at < Date.now();
    const status = l.revoked ? 'Revoked' : isExpired ? 'Expired'
      : (l.max_uses && l.uses >= l.max_uses) ? 'Exhausted' : 'Active';
    const url = `${location.origin}/invite/link/${l.token}`;
    const isActive = status === 'Active';
    const copy = h('button', {
      type: 'button', class: 'btn btn-sm',
      'aria-label': `Copy link for ${isActive ? 'active' : status.toLowerCase()} invite`
    }, ['Copy link']);
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(url);
      toast('Link copied.', 'success');
    });
    const revoke = h('button', {
      type: 'button', class: 'btn btn-sm btn-danger',
      'aria-label': 'Revoke this invite link'
    }, ['Revoke']);
    revoke.addEventListener('click', async () => {
      if (!await confirm(
        'Revoke this link?',
        'Anyone who has already accepted is unaffected. New uses will be refused.',
        { confirmLabel: 'Revoke link', kind: 'danger' }
      )) return;
      await api('/api/documents/' + doc.id + '/invite-link/' + l.token, { method: 'DELETE' });
      rebuild();
    });
    linksList.appendChild(h('li', {}, [
      h('span', {}, [
        h('span', { class: 'tag ' + (isActive ? 'owner' : 'viewer') }, [status]),
        ` · ${l.role === 'viewer' ? 'Viewer' : 'Editor'}`,
        l.allow_guests ? ' · guests allowed' : ' · account required',
        l.max_uses ? ` · uses ${l.uses} of ${l.max_uses}` : '',
        l.expires_at ? ` · expires ${new Date(l.expires_at).toLocaleString()}` : ''
      ]),
      h('span', { style: { display: 'flex', gap: '0.3rem' } }, [copy, isActive ? revoke : null].filter(Boolean))
    ]));
  }
  if (!data.invites.length) {
    linksList.appendChild(h('li', {}, [h('em', {}, ['No invite links yet.'])]));
  }

  const linkRoleId = nextId('link-role');
  const linkUsesId = nextId('link-uses');
  const linkGuestsId = nextId('link-guests');
  const linkGuestsHelpId = nextId('link-guests-help');
  const linkRoleSel = h('select', { id: linkRoleId }, [
    h('option', { value: 'editor' }, ['Editor']),
    h('option', { value: 'viewer' }, ['Viewer'])
  ]);
  const linkUses = h('input', {
    type: 'text', id: linkUsesId, value: '0',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    maxlength: '6',
    autocomplete: 'off',
    style: { width: '6rem' }
  });
  const linkGuests = h('input', {
    type: 'checkbox',
    id: linkGuestsId,
    checked: true,
    'aria-describedby': linkGuestsHelpId
  });
  const linkBtn = h('button', { type: 'button', class: 'btn' }, ['Create invite link']);
  linkBtn.addEventListener('click', async () => {
    busy(linkBtn, true);
    try {
      const r = await api('/api/documents/' + doc.id + '/invite-link', {
        method: 'POST',
        body: {
          role: linkRoleSel.value,
          maxUses: Number(linkUses.value) || 0,
          allowGuests: !!linkGuests.checked
        }
      });
      try { await navigator.clipboard.writeText(r.url); } catch {}
      toast('Invite link created and copied to clipboard.', 'success');
      rebuild();
    } catch (e) {
      toast('Could not create link.', 'error');
    } finally { busy(linkBtn, false); }
  });

  // ---- Capacity ----
  const capId = nextId('share-cap');
  const capHelpId = nextId('share-cap-help');
  const capInput = h('input', {
    type: 'text', id: capId, value: String(doc.capacity || 0),
    inputmode: 'numeric',
    pattern: '[0-9]*',
    maxlength: '6',
    autocomplete: 'off',
    style: { width: '6rem' },
    'aria-describedby': capHelpId
  });
  const capBtn = h('button', {
    type: 'button',
    class: 'btn btn-sm',
    'aria-label': 'Update capacity limit'
  }, ['Update']);
  capBtn.addEventListener('click', async () => {
    busy(capBtn, true);
    try {
      await api('/api/documents/' + doc.id, { method: 'PATCH', body: { capacity: Number(capInput.value) || 0 } });
      toast('Capacity updated.', 'success');
    } catch (e) {
      toast('Could not update capacity.', 'error');
    } finally { busy(capBtn, false); }
  });

  const m = openModal({
    title: canShare ? `Share "${doc.title}"` : `Manage users in "${doc.title}"`,
    body: h('div', {}, [
      h('h3', { id: peopleListId, style: { marginTop: 0 } }, ['People with access']),
      list,
      canShare && h('h3', {}, ['Invite by email']),
      canShare && h('div', { class: 'field' }, [
        h('label', { class: 'field-label', for: emailId }, ['Email address']),
        h('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' } }, [emailInput]),
        emailErr
      ]),
      canShare && h('div', { class: 'field' }, [
        h('label', { class: 'field-label', for: emailRoleId }, ['Role']),
        roleSel
      ]),
      canShare && h('div', {
        class: 'field',
        style: { display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }
      }, [
        emailGuests,
        h('div', { style: { flex: '1' } }, [
          h('label', { class: 'field-label', for: emailGuestsId, style: { display: 'inline' } }, [
            'Allow joining as a guest (no account required)'
          ]),
          h('div', { class: 'field-help', id: emailGuestsHelpId }, [
            'When enabled, the recipient can choose to join the document immediately as a guest by entering a display name, without creating an Ephesian account.'
          ])
        ])
      ]),
      canShare && h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, [inviteBtn]),
      canShare && h('p', { class: 'field-help' }, [
        'Existing users gain access immediately. New users get an email invite they can claim by signing up with the same address, or — when allowed — by joining as a guest.'
      ]),
      canShare && h('h3', { id: linksListId }, ['Invite links']),
      canShare && linksList,
      canShare && h('div', { style: { display: 'grid', gridTemplateColumns: 'auto auto', gap: '0.6rem 0.8rem', alignItems: 'center' } }, [
        h('label', { class: 'field-label', for: linkRoleId }, ['Role']),
        linkRoleSel,
        h('label', { class: 'field-label', for: linkUsesId }, ['Max uses (0 = unlimited)']),
        linkUses
      ]),
      canShare && h('div', {
        class: 'field',
        style: { marginTop: '0.6rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }
      }, [
        linkGuests,
        h('div', { style: { flex: '1' } }, [
          h('label', { class: 'field-label', for: linkGuestsId, style: { display: 'inline' } }, [
            'Allow joining as a guest (no account required)'
          ]),
          h('div', { class: 'field-help', id: linkGuestsHelpId }, [
            'When enabled, anyone with the link can join by just entering a display name. Disable to require visitors to sign in or create an Ephesian account first.'
          ])
        ])
      ]),
      canShare && h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '0.6rem' } }, [linkBtn]),
      canShare && h('h3', {}, ['Capacity limit']),
      canShare && h('div', { class: 'field' }, [
        h('label', { class: 'field-label', for: capId }, ['Maximum simultaneous collaborators']),
        h('div', { style: { display: 'flex', gap: '0.4rem', alignItems: 'center' } }, [capInput, capBtn]),
        h('div', { class: 'field-help', id: capHelpId }, [
          'When the document is full, additional people are refused entry until someone leaves. Use 0 for unlimited.'
        ])
      ])
    ])
  });

  function rebuild() {
    m.close();
    openShareDialog(doc);
  }
}
