import { h, toast, announceRoute, busy, openModal, nextId } from '../ui.js';
import { api, fetchMe, meUser, clearMeCache } from '../api.js';
import { navigate } from '../router.js';
import { renderAuthSlot } from '../auth-slot.js';

export async function renderLinkInvite(main, params) {
  main.innerHTML = '';
  await fetchMe(true);
  const user = meUser();
  let info;
  try {
    info = await api('/api/invites/link/' + params.token);
  } catch (e) {
    main.appendChild(h('div', { class: 'callout danger', role: 'alert' }, [
      e.status === 410 ? 'This invite link is no longer valid.' : 'Invite not found.'
    ]));
    announceRoute('Invite — not available');
    return;
  }
  const card = h('section', { class: 'auth-page card', 'aria-labelledby': 'invite-heading' });
  main.appendChild(card);
  card.appendChild(h('h1', { id: 'invite-heading' }, ['You have been invited']));
  card.appendChild(h('p', {}, [
    'You can join "', h('strong', {}, [info.document.title || 'Untitled']),
    '" as a ', h('strong', {}, [info.role]), '.'
  ]));

  // ---- Already signed in (full account) — accept directly ----
  if (user && !user.isGuest) {
    if (!user.emailVerified) {
      card.appendChild(h('div', { class: 'callout warning', role: 'status' }, [
        'Verify your email before accepting invitations. ',
        h('a', { href: '/verify', 'data-link': '' }, ['Verify now'])
      ]));
      announceRoute('You have been invited — verify your email first');
      return;
    }
    const accept = h('button', { type: 'button', class: 'btn btn-primary' }, ['Accept and open document']);
    accept.addEventListener('click', async (e) => {
      busy(accept, true);
      try {
        const r = await api('/api/invites/link/' + params.token + '/accept', { method: 'POST' });
        navigate('/d/' + r.documentId);
      } catch (err) {
        toast('Could not accept invitation: ' + (err.message || ''), 'error');
      } finally { busy(accept, false); }
    });
    card.appendChild(accept);
    announceRoute('You have been invited');
    return;
  }

  // ---- Already signed in as a guest somewhere else — accept directly too ----
  if (user && user.isGuest) {
    const accept = h('button', { type: 'button', class: 'btn btn-primary' }, ['Accept and open document']);
    accept.addEventListener('click', async () => {
      busy(accept, true);
      try {
        const r = await api('/api/invites/link/' + params.token + '/accept', { method: 'POST' });
        navigate('/d/' + r.documentId);
      } catch (err) {
        toast('Could not accept invitation: ' + (err.message || ''), 'error');
      } finally { busy(accept, false); }
    });
    card.appendChild(accept);
    announceRoute('You have been invited');
    return;
  }

  // ---- Not signed in: offer guest join (if allowed) AND/OR sign-in/register ----
  if (info.allowGuests) {
    card.appendChild(h('p', {}, [
      'You can join immediately as a guest using a display name, or sign in / create an account if you have one.'
    ]));
    card.appendChild(h('div', {
      style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }
    }, [
      h('button', {
        type: 'button',
        class: 'btn btn-primary',
        'aria-haspopup': 'dialog',
        onclick: () => promptGuestJoin('/api/invites/link/' + params.token + '/guest')
      }, ['Join as a guest']),
      h('a', {
        class: 'btn',
        'data-link': '',
        href: '/login?next=' + encodeURIComponent('/invite/link/' + params.token)
      }, ['Sign in']),
      h('a', {
        class: 'btn btn-ghost',
        'data-link': '',
        href: '/register?next=' + encodeURIComponent('/invite/link/' + params.token)
      }, ['Create an account'])
    ]));
    card.appendChild(h('p', { class: 'field-help' }, [
      'Guest access lasts for this browser session only. Signing in or creating an account lets you come back later.'
    ]));
    announceRoute('You have been invited. Choose how to join.');
    return;
  }

  // ---- Guests not allowed for this link ----
  card.appendChild(h('p', {}, [
    'The owner of this document requires collaborators to have an Ephesian account. Sign in or create one to join.'
  ]));
  card.appendChild(h('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } }, [
    h('a', {
      class: 'btn btn-primary',
      'data-link': '',
      href: '/register?next=' + encodeURIComponent('/invite/link/' + params.token)
    }, ['Create account']),
    h('a', {
      class: 'btn',
      'data-link': '',
      href: '/login?next=' + encodeURIComponent('/invite/link/' + params.token)
    }, ['Sign in'])
  ]));
  announceRoute('You have been invited');
}

// Shared between link invites and email invites — the only thing that differs
// between them is the POST URL the display name is submitted to.
function promptGuestJoin(endpointPath) {
  const inputId = nextId('guest-name');
  const errId = nextId('guest-err');
  const input = h('input', {
    type: 'text',
    id: inputId,
    autocomplete: 'nickname',
    maxlength: '60',
    required: true,
    placeholder: 'Your name as it will appear to others'
  });
  const err = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  
  let form;
  const ok = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    onclick: () => {
      if (form) {
        if (form.requestSubmit) {
          form.requestSubmit();
        } else if (form.reportValidity()) {
          form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
    }
  }, ['Join document']);
  const cancel = h('button', {
    type: 'button',
    class: 'btn',
    onclick: () => m.close()
  }, ['Cancel']);

  form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      input.removeAttribute('aria-invalid');
      const displayName = input.value.trim();
      if (!displayName) {
        err.textContent = 'Enter a display name to continue.';
        err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      busy(ok, true);
      try {
        const r = await api(endpointPath, {
          method: 'POST',
          body: { displayName }
        });
        clearMeCache();
        await renderAuthSlot();
        m.close();
        navigate('/d/' + r.documentId);
      } catch (e2) {
        err.textContent =
          e2.data?.error === 'guests_not_allowed' ? 'The owner of this invite does not allow guest access.' :
          e2.data?.error === 'display_name_required' ? 'Enter a display name to continue.' :
          e2.data?.error === 'expired' ? 'This invite has expired.' :
          e2.data?.error === 'exhausted' ? 'This invite has reached its maximum uses.' :
          e2.data?.error === 'invalid_invite' ? 'This invitation could not be found or has already been used.' :
          e2.data?.error === 'too_many_attempts' ? 'Too many guest join attempts. Please wait a few minutes.' :
          (e2.message || 'Could not join as a guest.');
        err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      } finally { busy(ok, false); }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: inputId }, ['Display name']),
      input,
      h('p', { class: 'field-help' }, [
        'This is what other collaborators will see next to your cursor.'
      ])
    ]),
    err
  ]);

  const m = openModal({
    title: 'Join as a guest',
    body: form,
    footer: [cancel, ok],
    initialFocus: input
  });
}

export async function renderEmailInvite(main, params) {
  main.innerHTML = '';
  await fetchMe(true);
  const user = meUser();

  // Fetch invite metadata first so we can decide what to offer. Anonymous
  // requesters get the document title and role without leaking the email address.
  let info;
  try {
    info = await api('/api/invites/email/' + params.token);
  } catch (e) {
    main.appendChild(h('div', { class: 'callout danger', role: 'alert' }, [
      e.status === 404 ? 'This invitation could not be found or has already been used.' : 'Invite not available.'
    ]));
    announceRoute('Invite — not available');
    return;
  }

  const card = h('section', { class: 'auth-page card', 'aria-labelledby': 'invite-heading' });
  main.appendChild(card);
  card.appendChild(h('h1', { id: 'invite-heading' }, ['You have been invited']));
  card.appendChild(h('p', {}, [
    'You can join "', h('strong', {}, [info.document.title || 'Untitled']),
    '" as a ', h('strong', {}, [info.role]), '.'
  ]));

  // Signed-in full user with verified email — try to accept directly. If the
  // server rejects (wrong email), fall through to the manual options.
  if (user && !user.isGuest && user.emailVerified) {
    try {
      const r = await api('/api/invites/email/' + params.token + '/accept', { method: 'POST' });
      navigate('/d/' + r.documentId);
      return;
    } catch (e) {
      // The signed-in email didn't match the invitation. Offer the manual paths below.
      card.appendChild(h('div', { class: 'callout warning', role: 'status' }, [
        'This invitation was sent to a different email address than the one you are signed in with. You can sign in with the correct address, or — if this link allows it — join as a guest below.'
      ]));
    }
  }

  // Signed-in user but not yet verified — point them to verify first.
  if (user && !user.isGuest && !user.emailVerified) {
    card.appendChild(h('div', { class: 'callout warning', role: 'status' }, [
      'Verify your email first. ',
      h('a', { href: '/verify', 'data-link': '' }, ['Verify now'])
    ]));
    announceRoute('You have been invited — verify your email first');
    return;
  }

  // ---- Not signed in: offer guest join (if allowed) AND/OR sign-in/register ----
  if (info.allowGuests) {
    card.appendChild(h('p', {}, [
      'You can join immediately as a guest using a display name, or sign in / create an account if you have one.'
    ]));
    const actions = h('div', {
      style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }
    });
    actions.appendChild(h('button', {
      type: 'button',
      class: 'btn btn-primary',
      'aria-haspopup': 'dialog',
      onclick: () => promptGuestJoin('/api/invites/email/' + params.token + '/guest')
    }, ['Join as a guest']));
    if (!user) {
      actions.appendChild(h('a', {
        class: 'btn',
        'data-link': '',
        href: '/login?next=' + encodeURIComponent('/invite/email/' + params.token)
      }, ['Sign in']));
      actions.appendChild(h('a', {
        class: 'btn btn-ghost',
        'data-link': '',
        href: '/register?next=' + encodeURIComponent('/invite/email/' + params.token)
      }, ['Create an account']));
    }
    card.appendChild(actions);
    card.appendChild(h('p', { class: 'field-help' }, [
      'Guest access lasts for this browser session only. Signing in or creating an account lets you come back later.'
    ]));
    announceRoute('You have been invited. Choose how to join.');
    return;
  }

  // ---- Guests not allowed for this link ----
  if (!user) {
    card.appendChild(h('p', {}, [
      'This invitation requires an Ephesian account that matches the email address it was sent to.'
    ]));
    card.appendChild(h('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } }, [
      h('a', {
        class: 'btn btn-primary',
        'data-link': '',
        href: '/register?next=' + encodeURIComponent('/invite/email/' + params.token)
      }, ['Create account']),
      h('a', {
        class: 'btn',
        'data-link': '',
        href: '/login?next=' + encodeURIComponent('/invite/email/' + params.token)
      }, ['Sign in'])
    ]));
  }
  announceRoute('You have been invited.');
}
