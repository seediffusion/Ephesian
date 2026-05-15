import { h, busy, announceRoute, nextId } from '../ui.js';
import { api } from '../api.js';

export function renderForgotPassword(main) {
  main.innerHTML = '';

  const errId = nextId('forgot-error');
  const helpId = nextId('forgot-help');
  const errBox = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  const sentBox = h('div', {
    class: 'callout success',
    role: 'status',
    tabindex: '-1',
    hidden: true
  }, ['If an account exists for that email address, password reset instructions have been sent.']);
  const emailInput = h('input', {
    type: 'email',
    id: 'forgot-email',
    autocomplete: 'email',
    required: true,
    inputmode: 'email',
    'aria-describedby': `${helpId} ${errId}`
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, ['Send reset link']);

  const form = h('form', {
    'aria-labelledby': 'forgot-heading',
    'aria-describedby': `${helpId} ${errId}`,
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      sentBox.hidden = true;
      emailInput.removeAttribute('aria-invalid');
      busy(submit, true);
      try {
        await api('/api/auth/forgot-password', {
          method: 'POST',
          body: { email: emailInput.value.trim() }
        });
        emailInput.value = '';
        sentBox.hidden = false;
        sentBox.focus();
      } catch (err) {
        if (err.data?.error === 'invalid_email') {
          errBox.textContent = 'Enter a valid email address.';
          emailInput.setAttribute('aria-invalid', 'true');
          emailInput.focus();
        } else if (err.data?.error === 'too_many_attempts') {
          errBox.textContent = 'Too many reset requests. Please try again later.';
        } else {
          errBox.textContent = err.message || 'Could not send reset instructions.';
        }
        errBox.hidden = false;
      } finally {
        busy(submit, false);
      }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'forgot-email' }, ['Email address']),
      emailInput,
      h('div', { class: 'field-help', id: helpId }, [
        'Use the email address on your Ephesian account.'
      ])
    ]),
    errBox,
    sentBox,
    h('div', { class: 'form-actions' }, [
      h('a', { href: '/login', 'data-link': '' }, ['Back to sign in']),
      submit
    ])
  ]);

  main.appendChild(h('section', { class: 'auth-page card' }, [
    h('h1', { id: 'forgot-heading' }, ['Reset your password']),
    form
  ]));

  announceRoute('Reset password');
}
