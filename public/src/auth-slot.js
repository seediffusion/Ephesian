import { h, clear, confirm } from './ui.js';
import { api, fetchMe, clearMeCache, meUser, mePending2FA } from './api.js';
import { navigate } from './router.js';

export async function renderAuthSlot() {
  const slot = document.getElementById('auth-slot');
  clear(slot);
  try {
    await fetchMe(true);
  } catch {}
  const user = meUser();
  const pending = mePending2FA();
  if (!user) {
    slot.appendChild(h('a', { href: '/login', 'data-link': '', class: 'btn btn-sm' }, ['Sign in']));
    slot.appendChild(h('a', { href: '/register', 'data-link': '', class: 'btn btn-sm btn-primary' }, ['Create account']));
    return;
  }
  if (pending) {
    slot.appendChild(h('span', { class: 'tag' }, ['2FA pending']));
    slot.appendChild(h('button', {
      type: 'button',
      class: 'btn btn-sm',
      onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); clearMeCache(); navigate('/login'); }
    }, ['Cancel']));
    return;
  }
  if (user.isGuest) {
    // Guests have no account page and no email. Show the guest label as plain
    // visible text (no aria-label so the accessible name matches what is shown,
    // satisfying WCAG 2.5.3). End-guest-session is destructive and irreversible
    // for guests, so we confirm before terminating the session.
    slot.appendChild(h('span', { class: 'tag' }, [
      'Guest: ', user.displayName
    ]));
    slot.appendChild(h('a', {
      href: '/register',
      'data-link': '',
      class: 'btn btn-sm btn-ghost'
    }, ['Create an account']));
    slot.appendChild(h('button', {
      type: 'button',
      class: 'btn btn-sm btn-danger',
      'aria-haspopup': 'dialog',
      onclick: async () => {
        if (!await confirm(
          'End guest session?',
          'You will be signed out and lose access to documents you joined as a guest. To rejoin, you will need the original invite link again.',
          { confirmLabel: 'End guest session', kind: 'danger' }
        )) return;
        try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
        clearMeCache();
        navigate('/');
      }
    }, ['End guest session']));
    return;
  }
  slot.appendChild(h('a', { href: '/account', 'data-link': '', class: 'btn btn-sm btn-ghost' }, [user.displayName || user.email]));
  slot.appendChild(h('button', {
    type: 'button',
    class: 'btn btn-sm',
    onclick: async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
      clearMeCache();
      navigate('/login');
    }
  }, ['Sign out']));
}
