import { h, clear } from './ui.js';
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
      class: 'btn btn-sm', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); clearMeCache(); navigate('/login'); }
    }, ['Cancel']));
    return;
  }
  slot.appendChild(h('a', { href: '/account', 'data-link': '', class: 'btn btn-sm btn-ghost' }, [user.displayName || user.email]));
  slot.appendChild(h('button', {
    class: 'btn btn-sm',
    onclick: async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
      clearMeCache();
      navigate('/login');
    }
  }, ['Sign out']));
}
