import { h, toast, openModal, confirm, announceRoute, nextId } from '../ui.js';
import { api, fetchMe, meUser } from '../api.js';
import { navigate } from '../router.js';

export async function renderDashboard(main) {
  await fetchMe(true);
  const user = meUser();
  if (!user) { navigate('/login'); return; }

  main.innerHTML = '';
  const root = h('section', { class: 'dashboard', 'aria-labelledby': 'dashboard-heading' });
  main.appendChild(root);

  root.appendChild(h('h1', { id: 'dashboard-heading' }, ['Your documents']));

  if (!user.emailVerified) {
    root.appendChild(h('div', { class: 'callout warning', role: 'status' }, [
      'Verify your email to start creating and editing documents. ',
      h('a', { href: '/verify', 'data-link': '' }, ['Verify now'])
    ]));
  }

  const toolbar = h('div', {
    class: 'dashboard-toolbar',
    role: 'group',
    'aria-label': 'Document actions'
  }, [
    h('button', {
      type: 'button',
      class: 'btn btn-primary',
      'aria-haspopup': 'dialog',
      onclick: createDoc
    }, ['New document']),
    h('button', { type: 'button', class: 'btn', onclick: importDoc }, ['Import a file']),
    h('div', { class: 'filler', 'aria-hidden': 'true' })
  ]);
  root.appendChild(toolbar);

  const gridHeadingId = nextId('docgrid');
  root.appendChild(h('h2', { id: gridHeadingId, class: 'sr-only' }, ['Documents list']));
  const grid = h('ul', {
    role: 'list',
    class: 'doc-grid list-reset',
    'aria-labelledby': gridHeadingId
  });
  root.appendChild(grid);

  function reload() { return renderDashboard(main); }

  async function createDoc() {
    if (!user.emailVerified) { toast('Verify your email first.', 'warning'); return; }
    return new Promise(resolve => {
      const titleId = nextId('newdoc-title');
      const capId = nextId('newdoc-cap');
      const capHelpId = nextId('newdoc-cap-help');
      const title = h('input', { type: 'text', id: titleId, value: 'Untitled' });
      const cap = h('input', {
        // `type="text"` + `inputmode="numeric"` + `pattern` avoids the type=number a11y issues
        // (spinner buttons, mouse-wheel value change, locale parsing). Validated separately.
        type: 'text', id: capId, value: '0',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        maxlength: '6',
        autocomplete: 'off',
        'aria-describedby': capHelpId
      });
      const create = h('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            const r = await api('/api/documents', { method: 'POST', body: {
              title: title.value.trim() || 'Untitled',
              capacity: Number(cap.value) || 0
            }});
            m.close();
            navigate('/d/' + r.document.id);
          } catch (e) {
            toast('Could not create document: ' + (e.message || 'error'), 'error');
          }
        }
      }, ['Create']);
      const m = openModal({
        title: 'New document',
        body: h('div', {}, [
          h('div', { class: 'field' }, [
            h('label', { class: 'field-label', for: titleId }, ['Title']),
            title
          ]),
          h('div', { class: 'field' }, [
            h('label', { class: 'field-label', for: capId }, ['Collaborator limit']),
            cap,
            h('div', { class: 'field-help', id: capHelpId }, [
              'Maximum number of distinct people allowed inside the document at once. Use 0 for unlimited.'
            ])
          ])
        ]),
        footer: [create],
        onClose: () => resolve()
      });
    });
  }

  function importDoc() {
    if (!user.emailVerified) { toast('Verify your email first.', 'warning'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,.html,.htm,.md,.markdown,.txt';
    input.setAttribute('aria-label', 'Choose a document file to import');
    input.onchange = async () => {
      const f = input.files[0]; if (!f) return;
      try {
        const create = await api('/api/documents', { method: 'POST', body: {
          title: f.name.replace(/\.[^.]+$/, ''), capacity: 0
        }});
        const fd = new FormData();
        fd.append('file', f);
        fd.append('replaceTitle', 'false');
        const r = await api('/api/documents/' + create.document.id + '/import', { method: 'POST', body: fd });
        sessionStorage.setItem('ephesian.pendingImport:' + create.document.id, r.html);
        navigate('/d/' + create.document.id);
      } catch (e) {
        toast('Import failed: ' + (e.message || 'error'), 'error');
      }
    };
    input.click();
  }

  try {
    const data = await api('/api/documents');
    if (!data.documents.length) {
      grid.appendChild(h('li', { class: 'callout', style: { listStyle: 'none' } }, [
        'You have no documents yet. Use "New document" to get started.'
      ]));
      announceRoute('Your documents — none yet');
      return;
    }
    for (const d of data.documents) {
      const docTitle = d.title || 'Untitled';
      const cardHeadingId = nextId('doc-h');
      const card = h('li', {}, [
        h('article', { class: 'doc-card', 'aria-labelledby': cardHeadingId }, [
          h('h3', { id: cardHeadingId, style: { margin: 0, fontSize: '1.05rem' } }, [
            h('a', { href: '/d/' + d.id, 'data-link': '', class: 'doc-link' }, [docTitle])
          ]),
          h('div', { class: 'doc-meta' }, [
            d.is_owner
              ? h('span', { class: 'tag owner' }, ['Owner'])
              : h('span', { class: 'tag' }, [d.share_role === 'viewer' ? 'Viewer' : 'Editor']),
            ' · last edited ' + new Date(d.updated_at).toLocaleString()
          ]),
          h('div', { class: 'doc-card-actions' }, [
            h('a', {
              href: '/d/' + d.id,
              'data-link': '',
              class: 'btn btn-sm btn-primary',
              'aria-label': `Open document ${docTitle}`
            }, ['Open']),
            d.is_owner ? h('button', {
              type: 'button',
              class: 'btn btn-sm btn-danger',
              'aria-label': `Delete document ${docTitle}`,
              onclick: async () => {
                if (!await confirm(
                  'Delete this document?',
                  `"${docTitle}" cannot be recovered. All collaborators will lose access.`,
                  { confirmLabel: 'Delete document', kind: 'danger' }
                )) return;
                try { await api('/api/documents/' + d.id, { method: 'DELETE' }); reload(); }
                catch (e) { toast('Could not delete.', 'error'); }
              }
            }, ['Delete']) : null
          ].filter(Boolean))
        ])
      ]);
      grid.appendChild(card);
    }
    announceRoute(`Your documents — ${data.documents.length}`);
  } catch (e) {
    grid.appendChild(h('li', { class: 'callout danger', role: 'alert', style: { listStyle: 'none' } }, [
      'Could not load documents. Please refresh the page or try again later.'
    ]));
    announceRoute('Your documents — error loading');
  }
}
