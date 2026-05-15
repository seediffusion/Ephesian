import { h, busy, toast, announceRoute, nextId } from '../ui.js';
import { api, clearMeCache } from '../api.js';
import { navigate } from '../router.js';
import { renderAuthSlot } from '../auth-slot.js';

export function renderRegister(main, search) {
  main.innerHTML = '';

  const errId = nextId('register-error');
  const emailHelpId = nextId('register-email-help');
  const passHelpId = nextId('register-pass-help');
  const nameHelpId = nextId('register-name-help');

  const errBox = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });

  const emailInput = h('input', {
    type: 'email', id: 'register-email',
    autocomplete: 'email', required: true,
    'aria-describedby': `${emailHelpId} ${errId}`,
    inputmode: 'email'
  });
  const nameInput = h('input', {
    type: 'text', id: 'register-display-name',
    autocomplete: 'name',
    'aria-describedby': nameHelpId
  });
  const passInput = h('input', {
    type: 'password', id: 'register-password',
    autocomplete: 'new-password', minlength: '10', required: true,
    'aria-describedby': `${passHelpId} ${errId}`
  });
  const passConfirm = h('input', {
    type: 'password', id: 'register-password2',
    autocomplete: 'new-password', required: true,
    'aria-describedby': errId
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, ['Create account']);

  const form = h('form', {
    'aria-labelledby': 'register-heading',
    'aria-describedby': errId,
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      emailInput.removeAttribute('aria-invalid');
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
        await api('/api/auth/register', {
          method: 'POST',
          body: {
            email: emailInput.value.trim(),
            password: passInput.value,
            displayName: nameInput.value.trim()
          }
        });
        clearMeCache();
        await renderAuthSlot();
        toast('Account created. Check your email for a verification code.', 'success');
        navigate('/verify');
      } catch (err) {
        const data = err.data;
        if (data?.error === 'weak_password' && Array.isArray(data.issues)) {
          errBox.textContent = data.issues.join(' ');
          passInput.setAttribute('aria-invalid', 'true');
          passInput.focus();
        } else if (data?.error === 'email_taken') {
          errBox.textContent = 'An account already exists for that email address.';
          emailInput.setAttribute('aria-invalid', 'true');
          emailInput.focus();
        } else if (data?.error === 'invalid_email') {
          errBox.textContent = 'That does not look like a valid email address.';
          emailInput.setAttribute('aria-invalid', 'true');
          emailInput.focus();
        } else {
          errBox.textContent = err.message || 'Something went wrong. Try again.';
        }
        errBox.hidden = false;
      } finally {
        busy(submit, false);
      }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'register-email' }, ['Email address']),
      emailInput,
      h('div', { class: 'field-help', id: emailHelpId }, [
        'You will need to verify this address before sharing or editing.'
      ])
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'register-display-name' }, ['Display name (optional)']),
      nameInput,
      h('div', { class: 'field-help', id: nameHelpId }, [
        'Shown to your collaborators when they see your cursor.'
      ])
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'register-password' }, ['Password']),
      passInput,
      h('div', { class: 'field-help', id: passHelpId }, [
        'At least 10 characters with upper, lower, and a number. You can paste a password from a password manager.'
      ])
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'register-password2' }, ['Confirm password']),
      passConfirm
    ]),
    errBox,
    h('div', { class: 'form-actions' }, [
      h('a', { href: '/login', 'data-link': '' }, ['Already have an account? Sign in']),
      submit
    ])
  ]);

  main.appendChild(h('section', { class: 'auth-page card' }, [
    h('h1', { id: 'register-heading' }, ['Create your Ephesian account']),
    form
  ]));

  announceRoute('Create account');
}
