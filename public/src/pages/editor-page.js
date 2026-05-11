import { h, busy, toast, openModal, confirm, announceRoute, nextId, icon, srOnly } from '../ui.js';
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
  const isOwner = role === 'owner';

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

  const shareBtn = isOwner
    ? h('button', {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        'aria-haspopup': 'dialog',
        onclick: () => openShareDialog(doc)
      }, ['Share'])
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

  shell.appendChild(h('div', { class: 'editor-meta' }, [
    backBtn, titleInput,
    h('span', { class: 'tag' }, [role.charAt(0).toUpperCase() + role.slice(1)]),
    status,
    h('div', { style: { flex: '1' }, 'aria-hidden': 'true' }),
    presenceWrap,
    importBtn, exportBtn, shareBtn
  ].filter(Boolean)));

  // ---- Toolbar (only for editors/owners — viewers see no formatting controls because the editor is read-only) ----
  const canEdit = role !== 'viewer';
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
  shell.appendChild(h('span', { id: surfaceLabelId, class: 'sr-only' }, [
    canEdit
      ? 'Document content. Use the formatting toolbar above for rich-text controls.'
      : 'Document content. This document is read-only for your account.'
  ]));
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
          style: { backgroundColor: '#888' }
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
      cmd: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() }
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

async function openShareDialog(doc) {
  const data = await api('/api/documents/' + doc.id + '/shares');

  // ---- People list ----
  const peopleListId = nextId('share-people');
  const list = h('ul', { class: 'share-list', 'aria-labelledby': peopleListId });
  for (const s of data.shares) {
    const remove = h('button', {
      type: 'button',
      class: 'btn btn-sm btn-danger',
      'aria-label': `Remove ${s.display_name || s.email}`
    }, ['Remove']);
    remove.addEventListener('click', async () => {
      if (!await confirm(
        'Remove access?',
        `${s.display_name || s.email} will lose access immediately.`,
        { confirmLabel: 'Remove', kind: 'danger' }
      )) return;
      await api('/api/documents/' + doc.id + '/shares/' + s.user_id, { method: 'DELETE' });
      rebuild();
    });
    list.appendChild(h('li', {}, [
      h('span', {}, [
        s.display_name || s.email, ' ',
        h('span', { class: 'tag' }, [s.role === 'viewer' ? 'Viewer' : 'Editor'])
      ]),
      remove
    ]));
  }
  if (!data.shares.length) {
    list.appendChild(h('li', {}, [h('em', {}, ['No one else has direct access yet.'])]));
  }

  // ---- Invite by email ----
  const emailId = nextId('share-email');
  const emailRoleId = nextId('share-role');
  const emailInput = h('input', {
    type: 'email', id: emailId,
    placeholder: 'name@example.com',
    autocomplete: 'email',
    inputmode: 'email'
  });
  const roleSel = h('select', { id: emailRoleId }, [
    h('option', { value: 'editor' }, ['Editor']),
    h('option', { value: 'viewer' }, ['Viewer'])
  ]);
  const inviteBtn = h('button', { type: 'button', class: 'btn btn-primary' }, ['Send invitation']);
  inviteBtn.addEventListener('click', async () => {
    busy(inviteBtn, true);
    try {
      const r = await api('/api/documents/' + doc.id + '/invite-email', {
        method: 'POST', body: { email: emailInput.value.trim(), role: roleSel.value }
      });
      toast(r.mode === 'direct' ? 'Added to document.' : 'Invitation email sent.', 'success');
      emailInput.value = '';
      rebuild();
    } catch (e) {
      toast('Could not invite: ' + (e.data?.error || e.message), 'error');
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
      'aria-label': `Copy ${isActive ? 'active ' : status.toLowerCase() + ' '}invite link`
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
    title: `Share "${doc.title}"`,
    body: h('div', {}, [
      h('h3', { id: peopleListId, style: { marginTop: 0 } }, ['People with access']),
      list,
      h('h3', {}, ['Invite by email']),
      h('div', { class: 'field' }, [
        h('label', { class: 'field-label', for: emailId }, ['Email address']),
        h('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' } }, [emailInput])
      ]),
      h('div', { class: 'field' }, [
        h('label', { class: 'field-label', for: emailRoleId }, ['Role']),
        roleSel
      ]),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, [inviteBtn]),
      h('p', { class: 'field-help' }, [
        'Existing users gain access immediately. New users get an email invite they can claim by signing up with the same address.'
      ]),
      h('h3', { id: linksListId }, ['Invite links']),
      linksList,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'auto auto', gap: '0.6rem 0.8rem', alignItems: 'center' } }, [
        h('label', { class: 'field-label', for: linkRoleId }, ['Role']),
        linkRoleSel,
        h('label', { class: 'field-label', for: linkUsesId }, ['Max uses (0 = unlimited)']),
        linkUses
      ]),
      h('div', {
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
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '0.6rem' } }, [linkBtn]),
      h('h3', {}, ['Capacity limit']),
      h('div', { class: 'field' }, [
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
