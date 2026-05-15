import { h, busy, announceRoute, nextId } from '../ui.js';
import { api, clearMeCache } from '../api.js';
import { navigate } from '../router.js';
import { runSecondFactor } from '../twofa-login.js';
import { renderAuthSlot } from '../auth-slot.js';

export function renderLogin(main, search) {
  main.innerHTML = '';

  const next = search?.get('next') || '/dashboard';
  const errId = nextId('login-error');
  const errBox = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  const emailInput = h('input', {
    type: 'email', id: 'login-email',
    autocomplete: 'email', required: true,
    'aria-describedby': errId,
    inputmode: 'email'
  });
  const passInput = h('input', {
    type: 'password', id: 'login-password',
    autocomplete: 'current-password', required: true,
    'aria-describedby': errId
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, ['Sign in']);

  const form = h('form', {
    'aria-labelledby': 'login-heading',
    'aria-describedby': errId,
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      emailInput.removeAttribute('aria-invalid');
      passInput.removeAttribute('aria-invalid');
      busy(submit, true);
      try {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: { email: emailInput.value.trim(), password: passInput.value }
        });
        clearMeCache();
        if (data.requires2FA) {
          await runSecondFactor(data.factors);
        }
        try { await api('/api/invites/email/claim-pending', { method: 'POST' }); } catch {}
        await renderAuthSlot();
        navigate(next || '/dashboard');
      } catch (err) {
        if (err.data?.error === 'invalid_credentials') {
          errBox.textContent = 'Email or password is incorrect.';
          emailInput.setAttribute('aria-invalid', 'true');
          passInput.setAttribute('aria-invalid', 'true');
        } else if (err.data?.error === 'too_many_attempts') {
          errBox.textContent = 'Too many sign-in attempts. Please try again in a few minutes.';
        } else if (err.message === 'cancelled') {
          errBox.textContent = 'Two-factor verification was cancelled.';
        } else {
          errBox.textContent = err.message || 'Sign-in failed.';
        }
        errBox.hidden = false;
        emailInput.focus();
      } finally {
        busy(submit, false);
      }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'login-email' }, ['Email address']),
      emailInput
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'login-password' }, ['Password']),
      passInput,
      h('div', { class: 'field-help' }, [
        h('a', { href: '/forgot-password', 'data-link': '' }, ['Forgot your password?'])
      ])
    ]),
    errBox,
    h('div', { class: 'form-actions' }, [
      h('a', { href: '/register', 'data-link': '' }, ['No account yet? Create one']),
      submit
    ])
  ]);

  main.appendChild(h('section', { class: 'auth-page card' }, [
    h('h1', { id: 'login-heading' }, ['Sign in to Ephesian']),
    form
  ]));

  announceRoute('Sign in');
}
