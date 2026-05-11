import { h, toast, announceRoute } from '../ui.js';
import { api, fetchMe, meUser } from '../api.js';
import { navigate } from '../router.js';

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
  if (!user) {
    card.appendChild(h('p', {}, [
      'Sign in or create an account to accept the invitation.'
    ]));
    card.appendChild(h('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } }, [
      h('a', {
        class: 'btn btn-primary', 'data-link': '',
        href: '/register?next=' + encodeURIComponent('/invite/link/' + params.token)
      }, ['Create account']),
      h('a', {
        class: 'btn', 'data-link': '',
        href: '/login?next=' + encodeURIComponent('/invite/link/' + params.token)
      }, ['Sign in'])
    ]));
    announceRoute('You have been invited');
    return;
  }
  if (!user.emailVerified) {
    card.appendChild(h('div', { class: 'callout warning', role: 'status' }, [
      'Verify your email before accepting invitations. ',
      h('a', { href: '/verify', 'data-link': '' }, ['Verify now'])
    ]));
    announceRoute('You have been invited — verify your email first');
    return;
  }
  const accept = h('button', { type: 'button', class: 'btn btn-primary' }, ['Accept and open document']);
  accept.addEventListener('click', async () => {
    try {
      const r = await api('/api/invites/link/' + params.token + '/accept', { method: 'POST' });
      navigate('/d/' + r.documentId);
    } catch (e) {
      toast('Could not accept invitation: ' + (e.message || ''), 'error');
    }
  });
  card.appendChild(accept);
  announceRoute('You have been invited');
}

export async function renderEmailInvite(main, params) {
  main.innerHTML = '';
  await fetchMe(true);
  const user = meUser();
  const card = h('section', { class: 'auth-page card', 'aria-labelledby': 'invite-heading' });
  main.appendChild(card);
  card.appendChild(h('h1', { id: 'invite-heading' }, ['You have been invited']));
  if (!user) {
    card.appendChild(h('p', {}, [
      'Sign in (or create an account) with the email address that received this invitation to accept it.'
    ]));
    card.appendChild(h('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } }, [
      h('a', { class: 'btn btn-primary', 'data-link': '', href: '/register?next=' + encodeURIComponent('/invite/email/' + params.token) }, ['Create account']),
      h('a', { class: 'btn', 'data-link': '', href: '/login?next=' + encodeURIComponent('/invite/email/' + params.token) }, ['Sign in'])
    ]));
    announceRoute('You have been invited');
    return;
  }
  if (!user.emailVerified) {
    card.appendChild(h('div', { class: 'callout warning', role: 'status' }, [
      'Verify your email first. ',
      h('a', { href: '/verify', 'data-link': '' }, ['Verify now'])
    ]));
    announceRoute('You have been invited — verify your email first');
    return;
  }
  try {
    const r = await api('/api/invites/email/' + params.token + '/accept', { method: 'POST' });
    navigate('/d/' + r.documentId);
  } catch (e) {
    card.appendChild(h('div', { class: 'callout danger', role: 'alert' }, [
      'This invitation could not be accepted. It may have already been used, or it was sent to a different email address than the one you signed in with.'
    ]));
    announceRoute('Invitation could not be accepted');
  }
}
