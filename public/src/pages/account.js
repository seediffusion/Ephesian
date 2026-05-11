import { h, busy, toast, openModal, confirm, announceRoute, nextId, icon } from '../ui.js';
import { api, fetchMe, meUser } from '../api.js';
import { navigate } from '../router.js';
import { startRegistration } from '@simplewebauthn/browser';

export async function renderAccount(main) {
  await fetchMe(true);
  const user = meUser();
  if (!user) { navigate('/login'); return; }

  main.innerHTML = '';
  const root = h('section', {
    'aria-labelledby': 'account-heading',
    style: { maxWidth: '760px', margin: '2rem auto', display: 'grid', gap: '1.2rem' }
  });
  main.appendChild(root);

  root.appendChild(h('h1', { id: 'account-heading' }, ['Your account']));

  // ---- Profile card ----
  root.appendChild(h('section', { class: 'card', 'aria-labelledby': 'profile-heading' }, [
    h('h2', { id: 'profile-heading', style: { marginTop: 0 } }, ['Profile']),
    h('dl', {}, [
      h('dt', {}, ['Display name']),
      h('dd', {}, [user.displayName]),
      h('dt', {}, ['Email']),
      h('dd', {}, [user.email, ' ', user.emailVerified
        ? h('span', { class: 'tag' }, ['Verified'])
        : h('a', { href: '/verify', 'data-link': '' }, ['Verify now'])])
    ])
  ]));

  // ---- Password change ----
  root.appendChild(h('section', { class: 'card', 'aria-labelledby': 'pw-heading' }, [
    h('h2', { id: 'pw-heading', style: { marginTop: 0 } }, ['Change password']),
    buildPasswordForm()
  ]));

  // ---- 2FA ----
  const twofaSection = h('section', { class: 'card', 'aria-labelledby': '2fa-heading' });
  root.appendChild(twofaSection);
  await renderTwoFA(twofaSection, user);

  announceRoute('Your account');
}

function buildPasswordForm() {
  const errId = nextId('pw-error');
  const newHelpId = nextId('pw-new-help');
  const cur = h('input', {
    type: 'password',
    id: 'pw-current',
    autocomplete: 'current-password',
    required: true
  });
  const next1 = h('input', {
    type: 'password',
    id: 'pw-new',
    autocomplete: 'new-password',
    minlength: '10',
    required: true,
    'aria-describedby': newHelpId
  });
  const next2 = h('input', {
    type: 'password',
    id: 'pw-confirm',
    autocomplete: 'new-password',
    minlength: '10',
    required: true
  });
  const err = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, ['Update password']);
  return h('form', {
    'aria-labelledby': 'pw-heading',
    'aria-describedby': errId,
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      [cur, next1, next2].forEach(x => x.removeAttribute('aria-invalid'));
      if (next1.value !== next2.value) {
        err.textContent = 'The two new passwords do not match.';
        err.hidden = false;
        next2.setAttribute('aria-invalid', 'true');
        next2.focus();
        return;
      }
      busy(btn, true);
      try {
        await api('/api/auth/change-password', {
          method: 'POST',
          body: { currentPassword: cur.value, newPassword: next1.value }
        });
        cur.value = next1.value = next2.value = '';
        toast('Password updated.', 'success');
        cur.focus();
      } catch (e2) {
        err.textContent = e2.data?.error === 'invalid_credentials'
          ? 'Current password is incorrect.'
          : (e2.data?.issues ? e2.data.issues.join(' ') : (e2.message || 'Could not update password.'));
        err.hidden = false;
        if (e2.data?.error === 'invalid_credentials') {
          cur.setAttribute('aria-invalid', 'true'); cur.focus();
        } else {
          next1.setAttribute('aria-invalid', 'true'); next1.focus();
        }
      } finally { busy(btn, false); }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'pw-current' }, ['Current password']),
      cur
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'pw-new' }, ['New password']),
      next1,
      h('div', { class: 'field-help', id: newHelpId }, [
        'At least 10 characters. Paste from a password manager is supported.'
      ])
    ]),
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'pw-confirm' }, ['Confirm new password']),
      next2
    ]),
    err,
    h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, [btn])
  ]);
}

async function renderTwoFA(container, user) {
  container.innerHTML = '';
  container.appendChild(h('h2', { id: '2fa-heading', style: { marginTop: 0 } }, ['Two-factor authentication']));
  container.appendChild(h('p', {}, [
    'Add additional factors so a stolen password is not enough to sign in. SMS is intentionally not supported.'
  ]));

  const list = h('ul', { class: 'list-reset', 'aria-label': 'Second-factor methods' });
  container.appendChild(list);

  const factors = user.twoFactor;
  list.appendChild(makeRow('Authenticator app (TOTP)', factors.totp, async (enabled) => {
    if (enabled) {
      if (!await confirm(
        'Disable authenticator app?',
        'You will no longer be prompted for a TOTP code when signing in.',
        { confirmLabel: 'Disable', kind: 'danger' }
      )) return;
      await api('/api/2fa/totp/disable', { method: 'POST' });
      toast('Authenticator app disabled.', 'success');
      const me = await api('/api/auth/me'); user.twoFactor = me.user.twoFactor;
      renderTwoFA(container, user);
    } else {
      await setupTotp();
      const me = await api('/api/auth/me'); user.twoFactor = me.user.twoFactor;
      renderTwoFA(container, user);
    }
  }));

  list.appendChild(makeRow('Security key or passkey (WebAuthn)', factors.webauthn, async (enabled) => {
    if (enabled) {
      manageWebauthn(async () => {
        const me = await api('/api/auth/me'); user.twoFactor = me.user.twoFactor;
        renderTwoFA(container, user);
      });
    } else {
      await registerWebauthn();
      const me = await api('/api/auth/me'); user.twoFactor = me.user.twoFactor;
      renderTwoFA(container, user);
    }
  }, enabled => enabled ? 'Manage keys' : 'Add a key'));

  list.appendChild(makeRow('Email-based codes', factors.email, async (enabled) => {
    if (enabled) {
      await api('/api/2fa/email/disable', { method: 'POST' });
      toast('Email codes disabled.', 'success');
    } else {
      if (!user.emailVerified) {
        toast('Verify your email first to use email codes.', 'warning');
        return;
      }
      await api('/api/2fa/email/enable', { method: 'POST' });
      toast('Email codes enabled.', 'success');
    }
    const me = await api('/api/auth/me'); user.twoFactor = me.user.twoFactor;
    renderTwoFA(container, user);
  }));

  const regen = h('button', { class: 'btn btn-sm' }, ['Generate or replace backup codes']);
  regen.addEventListener('click', async () => {
    if (!await confirm(
      'Generate new backup codes?',
      'Any existing backup codes will be invalidated.',
      { confirmLabel: 'Generate new codes', kind: 'danger' }
    )) return;
    const data = await api('/api/2fa/backup/regenerate', { method: 'POST' });
    showBackupCodes(data.codes);
  });
  container.appendChild(h('div', { style: { marginTop: '1rem' } }, [
    h('h3', { style: { fontSize: '1rem' } }, ['Backup codes']),
    h('p', {}, [
      'Backup codes let you sign in if you lose access to your other factors. Treat them like passwords.'
    ]),
    regen
  ]));
}

function makeRow(label, enabled, onToggle, btnLabelFn) {
  const btnText = btnLabelFn ? btnLabelFn(enabled) : (enabled ? 'Disable' : 'Enable');
  const btn = h('button', {
    class: 'btn btn-sm',
    type: 'button',
    'aria-label': `${btnText} ${label}`
  }, [btnText]);
  btn.addEventListener('click', async () => {
    try { busy(btn, true); await onToggle(enabled); } finally { busy(btn, false); }
  });
  return h('li', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.5rem 0', borderBottom: '1px solid var(--color-border)', gap: '0.6rem'
    }
  }, [
    h('span', {}, [
      label, ' ',
      enabled
        ? h('span', { class: 'tag owner' }, ['Active'])
        : h('span', { class: 'tag' }, ['Off'])
    ]),
    btn
  ]);
}

async function setupTotp() {
  const data = await api('/api/2fa/totp/begin-setup', { method: 'POST' });
  return new Promise(resolve => {
    const errId = nextId('totp-err');
    const codeId = nextId('totp-code');
    const codeInput = h('input', {
      type: 'text',
      id: codeId,
      inputmode: 'numeric',
      maxlength: '6',
      pattern: '\\d{6}',
      autocomplete: 'one-time-code'
    });
    const err = h('div', {
      id: errId,
      class: 'field-error',
      role: 'alert',
      'aria-live': 'assertive',
      hidden: true
    });
    const confirmBtn = h('button', { type: 'button', class: 'btn btn-primary' }, ['Confirm code']);
    confirmBtn.addEventListener('click', async () => {
      err.hidden = true;
      codeInput.removeAttribute('aria-invalid');
      busy(confirmBtn, true);
      try {
        const r = await api('/api/2fa/totp/confirm', { method: 'POST', body: { code: codeInput.value.trim() } });
        if (r.backupCodes) showBackupCodes(r.backupCodes);
        toast('Authenticator app enabled.', 'success');
        m.close(); resolve();
      } catch (e) {
        err.textContent = 'That code did not match. Try once more — codes change every 30 seconds.';
        err.hidden = false;
        codeInput.setAttribute('aria-invalid', 'true');
        codeInput.focus();
      } finally { busy(confirmBtn, false); }
    });
    const m = openModal({
      title: 'Set up authenticator app',
      body: h('div', {}, [
        h('p', {}, ['Scan this QR code with an authenticator app such as 1Password, Aegis, Bitwarden, or Google Authenticator.']),
        h('img', {
          src: data.qr,
          alt: 'QR code for setting up your authenticator app. If you cannot scan it, use the text secret below.',
          class: 'qr-img'
        }),
        h('p', {}, ['If you cannot scan, enter this secret manually:']),
        h('div', { class: 'code-blob', 'aria-label': 'TOTP setup secret' }, [data.secret]),
        h('div', { class: 'field', style: { marginTop: '1rem' } }, [
          h('label', { class: 'field-label', for: codeId }, ['Enter the 6-digit code your app generates']),
          codeInput
        ]),
        err
      ]),
      footer: [confirmBtn],
      onClose: () => resolve()
    });
  });
}

async function registerWebauthn() {
  let deviceName = 'Security key';
  // Prefer a real form over native prompt() — accessible and themeable.
  try {
    deviceName = await askDeviceName();
  } catch { return; }
  try {
    const options = await api('/api/2fa/webauthn/register/options', { method: 'POST' });
    const response = await startRegistration({ optionsJSON: options });
    await api('/api/2fa/webauthn/register/verify', { method: 'POST', body: { response, deviceName } });
    toast('Security key registered.', 'success');
  } catch (e) {
    toast('Could not register security key: ' + (e.message || 'error'), 'error');
  }
}

function askDeviceName() {
  return new Promise((resolve, reject) => {
    const inputId = nextId('device-name');
    const input = h('input', {
      type: 'text', id: inputId, value: 'Security key',
      autocomplete: 'off', maxlength: '80'
    });
    const okBtn = h('button', {
      type: 'button', class: 'btn btn-primary',
      onclick: () => { const v = input.value.trim() || 'Security key'; m.close(); resolve(v); }
    }, ['Continue']);
    const cancelBtn = h('button', {
      type: 'button', class: 'btn',
      onclick: () => { m.close(); reject(new Error('cancelled')); }
    }, ['Cancel']);
    const m = openModal({
      title: 'Name this security key',
      body: h('div', { class: 'field' }, [
        h('label', { class: 'field-label', for: inputId }, ['Device label']),
        input,
        h('p', { class: 'field-help' }, ['Choose a name you will recognize later, such as "YubiKey" or "Laptop passkey".'])
      ]),
      footer: [cancelBtn, okBtn],
      onClose: () => { /* reject handled by cancel button */ }
    });
    setTimeout(() => { input.select(); }, 0);
  });
}

async function manageWebauthn(onDone) {
  const data = await api('/api/2fa/webauthn/credentials');
  const list = h('ul', { class: 'share-list', 'aria-label': 'Registered security keys' });
  if (!data.credentials.length) {
    list.appendChild(h('li', {}, [h('em', {}, ['No registered keys yet.'])]));
  }
  for (const c of data.credentials) {
    const del = h('button', {
      type: 'button',
      class: 'btn btn-sm btn-danger',
      'aria-label': `Remove security key "${c.device_name}"`
    }, ['Remove']);
    del.addEventListener('click', async () => {
      if (!await confirm(
        'Remove this key?',
        `"${c.device_name}" will no longer be accepted at sign-in.`,
        { confirmLabel: 'Remove key', kind: 'danger' }
      )) return;
      await api('/api/2fa/webauthn/credentials/' + c.id, { method: 'DELETE' });
      m.close(); onDone();
    });
    list.appendChild(h('li', {}, [
      h('span', {}, [
        c.device_name, ' ',
        h('span', { class: 'tag' }, [`Added ${new Date(c.created_at).toLocaleDateString()}`])
      ]),
      del
    ]));
  }
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary' }, ['Add another key']);
  addBtn.addEventListener('click', async () => { m.close(); await registerWebauthn(); onDone(); });
  const m = openModal({
    title: 'Your security keys',
    body: list,
    footer: [addBtn]
  });
}

function showBackupCodes(codes) {
  const close = () => m.close();
  const copyBtn = h('button', {
    type: 'button',
    class: 'btn',
    onclick: () => {
      navigator.clipboard.writeText(codes.join('\n'));
      toast('Copied to clipboard.', 'success');
    }
  }, ['Copy all']);
  const doneBtn = h('button', {
    type: 'button', class: 'btn btn-primary', onclick: close
  }, ['I have saved them']);
  const m = openModal({
    title: 'Save your backup codes',
    body: h('div', {}, [
      h('p', {}, ['Each code can be used once. Print or store them somewhere safe.']),
      h('ul', {
        class: 'backup-codes list-reset',
        'aria-label': 'Backup codes'
      }, codes.map(c => h('li', { class: 'code-blob' }, [c]))),
      h('p', { style: { marginTop: '0.6rem' } }, [
        'When you sign in, switch to "Backup code" and paste one of these in.'
      ])
    ]),
    footer: [copyBtn, doneBtn]
  });
}
