import { h, announceRoute } from '../ui.js';
import { meUser } from '../api.js';

export function renderLanding(main) {
  const user = meUser();
  main.innerHTML = '';
  main.appendChild(h('section', {
    class: 'card',
    'aria-labelledby': 'landing-heading',
    style: { maxWidth: '780px', margin: '3rem auto' }
  }, [
    h('h1', { id: 'landing-heading' }, ['Ephesian']),
    h('p', { class: 'field-help' }, [
      'A self-hosted, real-time document collaboration platform. Auto-saves to your server. ',
      'Works offline in the browser. Imports and exports .docx, .html, .md and plain text.'
    ]),
    h('ul', { style: { marginTop: '1rem', paddingLeft: '1.25rem' } }, [
      h('li', {}, ['Live multi-user editing with presence cursors']),
      h('li', {}, ['Share via email or invite link, with optional per-document capacity caps']),
      h('li', {}, ['Argon2id passwords, email verification, TOTP, WebAuthn / passkeys, backup codes']),
      h('li', {}, ['Light and dark mode'])
    ]),
    h('div', {
      style: { display: 'flex', gap: '0.6rem', marginTop: '1.4rem', flexWrap: 'wrap' }
    }, [
      user
        ? h('a', { href: '/dashboard', 'data-link': '', class: 'btn btn-primary' }, ['Go to your documents'])
        : h('a', { href: '/register', 'data-link': '', class: 'btn btn-primary' }, ['Create an account']),
      user
        ? null
        : h('a', { href: '/login', 'data-link': '', class: 'btn' }, ['Sign in'])
    ].filter(Boolean))
  ]));
  announceRoute('Ephesian — welcome');
}
