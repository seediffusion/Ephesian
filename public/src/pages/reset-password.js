import { h, busy, toast, announceRoute, nextId } from '../ui.js';
import { api, clearMeCache } from '../api.js';
import { navigate } from '../router.js';
import { renderAuthSlot } from '../auth-slot.js';

export function renderResetPassword(main, search) {
  main.innerHTML = '';

  const userId = String(search?.get('uid') || '').trim();
  const token = String(search?.get('token') || '').trim();
  if (!userId || !token) {
    main.appendChild(h('section', { class: 'auth-page card' }, [
      h('h1', {}, ['Reset link needed']),
      h('p', {}, ['Use the link from your password reset email, or request a new one.']),
      h('p', {}, [h('a', { href: '/forgot-password', 'data-link': '' }, ['Request a new reset link'])])
    ]));
    announceRoute('Reset password');
    return;
  }

  const errId = nextId('reset-error');
  const passHelpId = nextId('reset-pass-help');
  const errBox = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  const passInput = h('input', {
    type: 'password',
    id: 'reset-password',
    autocomplete: 'new-password',
    minlength: '10',
    required: true,
    'aria-describedby': `${passHelpId} ${errId}`
  });
  const passConfirm = h('input', {
    type: 'password',
    id: 'reset-password2',
    autocomplete: 'new-password',
    minlength: '10',
    required: true,
    'aria-describedby': errId
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, ['Update password']);

  const form = h('form', {
    'aria-labelledby': 'reset-heading',
    'aria-describedby': errId,
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      passInput.removeAttribute('aria-invalid');
      passConfirm.removeAttribute('aria-invalid');
      if (passInput.value !== passConfirm.value) {
        errBox.textContent = 'The two passwords do not match.';
        errBox.hidden = false;
        passConfirm.setAttribute('aria-invalid', 'true');
        passConfirm.focus();
        return;
      }
      busy(submit, true);
      try {
        await api('/api/auth/reset-password', {
          method: 'POST',
          body: { userId, token, password: passInput.value }
        });
        clearMeCache();
        await renderAuthSlot();
        toast('Password updated. Sign in with your new password.', 'success');
        navigate('/login', { replace: true });
      } catch (err) {
        if (err.data?.error === 'weak_password' && Array.isArray(err.data.issues)) {
          errBox.textContent = err.data.issues.join(' ');
          passInput.setAttribute('aria-invalid', 'true');
          passInput.focus();
        } else if (err.data?.error === 'invalid_or_expired') {
          errBox.textContent = 'This reset link is invalid or has expired. Request a new one.';
        } else if (err.data?.error === 'too_many_attempts') {
          errBox.textContent = 'Too many reset attempts. Please try again later.';
        } else {
          errBox.textContent = err.message || 'Could not update your password.';
        }
        errBox.hidden = false;
      } finally {
        busy(submit, false);
      }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'reset-password' }, ['New password']),
      passInput,
      h('div', { class: 'field-help', id: passHelpId }, [
        'At least 10 characters with upper, lower, and a number. You can paste a password from a password manager.'
      ])
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'reset-password2' }, ['Confirm new password']),
      passConfirm
    ]),
    errBox,
    h('div', { class: 'form-actions' }, [
      h('a', { href: '/forgot-password', 'data-link': '' }, ['Request a new link']),
      submit
    ])
  ]);

  main.appendChild(h('section', { class: 'auth-page card' }, [
    h('h1', { id: 'reset-heading' }, ['Choose a new password']),
    form
  ]));

  announceRoute('Choose a new password');
}
