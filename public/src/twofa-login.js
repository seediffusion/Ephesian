import { h, busy, openModal, nextId } from './ui.js';
import { api } from './api.js';
import { startAuthentication } from '@simplewebauthn/browser';

export function runSecondFactor(factors) {
  return new Promise((resolve, reject) => {
    const errId = nextId('twofa-err');
    const codeId = nextId('twofa-code');
    const groupId = nextId('twofa-methods');
    const helperId = nextId('twofa-helper');

    const errBox = h('div', {
      id: errId,
      class: 'field-error',
      role: 'alert',
      'aria-live': 'assertive',
      hidden: true
    });
    const codeInput = h('input', {
      type: 'text',
      id: codeId,
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      maxlength: '20',
      'aria-describedby': helperId
    });

    let modeButtons = [];
    let activeMode = factors.totp ? 'totp' : factors.email ? 'email' : factors.webauthn ? 'webauthn' : 'backup';

    const helper = h('p', { id: helperId, class: 'field-help' }, ['Choose a method above to continue.']);

    function setMode(mode, skipFocus = false) {
      activeMode = mode;
      modeButtons.forEach(b => {
        const on = b.dataset.mode === mode;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.classList.toggle('btn-primary', on);
      });
      const helpers = {
        totp: 'Enter the 6-digit code from your authenticator app.',
        email: 'A code has been sent to your registered email address. Paste or type it below.',
        backup: 'Enter one of the backup codes you saved when you set up 2FA. Format is like AAAA-BBBB-CC.',
        webauthn: 'Activate the "Use security key" button to verify with your security key, passkey, or platform authenticator.'
      };
      helper.textContent = helpers[mode];
      codeInput.placeholder = mode === 'backup' ? 'AAAA-BBBB-CC' : '6-digit code';
      codeRow.hidden = (mode === 'webauthn');
      verifyBtn.hidden = (mode === 'webauthn');
      // After a USER-initiated mode switch, move focus to the relevant control.
      // We skip this on initial setMode call so we don't race openModal's own focus settle.
      if (!skipFocus) {
        if (mode === 'webauthn') {
          webauthnBtn.focus();
        } else {
          codeInput.focus();
        }
      }
    }

    function makeModeBtn(mode, label, onClick) {
      // Toggle-button group pattern (not tab/tablist) because there is no separate panel per
      // mode — the same input field handles every mode. role="tab" without role="tablist" +
      // role="tabpanel" is invalid.
      const b = h('button', {
        type: 'button',
        class: 'btn',
        'data-mode': mode,
        'aria-pressed': 'false'
      }, [label]);
      b.addEventListener('click', onClick);
      return b;
    }

    if (factors.totp) {
      modeButtons.push(makeModeBtn('totp', 'Authenticator app', () => setMode('totp')));
    }
    if (factors.email) {
      modeButtons.push(makeModeBtn('email', 'Email me a code', async () => {
        setMode('email');
        try { await api('/api/2fa/email/send-challenge', { method: 'POST' }); }
        catch {
          errBox.textContent = 'Could not send code. Try again.';
          errBox.hidden = false;
        }
      }));
    }
    if (factors.webauthn) {
      modeButtons.push(makeModeBtn('webauthn', 'Security key or passkey', () => setMode('webauthn')));
    }
    modeButtons.push(makeModeBtn('backup', 'Backup code', () => setMode('backup')));

    const optionsGroup = h('div', {
      id: groupId,
      role: 'group',
      'aria-label': 'Second-factor method',
      style: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }
    }, modeButtons);

    const codeRow = h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: codeId }, ['Verification code']),
      codeInput
    ]);

    const verifyBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, ['Verify']);
    const webauthnBtn = h('button', {
      type: 'button',
      class: 'btn btn-primary',
      onclick: async (e) => {
        try {
          busy(e.currentTarget, true);
          const options = await api('/api/2fa/webauthn/auth/options', { method: 'POST' });
          const response = await startAuthentication({ optionsJSON: options });
          await api('/api/2fa/webauthn/auth/verify', { method: 'POST', body: { response } });
          cancelled = true;
          m.close();
          resolve();
        } catch (err) {
          errBox.textContent = err.message || 'Security key verification failed.';
          errBox.hidden = false;
        } finally { busy(e.currentTarget, false); }
      }
    }, ['Use security key']);

    const form = h('form', {
      'aria-describedby': errId,
      onsubmit: async (e) => {
        e.preventDefault();
        errBox.hidden = true;
        codeInput.removeAttribute('aria-invalid');
        if (activeMode === 'webauthn') return;
        const code = codeInput.value.trim();
        if (!code) {
          errBox.textContent = 'Enter a code first.';
          errBox.hidden = false;
          codeInput.setAttribute('aria-invalid', 'true');
          codeInput.focus();
          return;
        }
        busy(verifyBtn, true);
        try {
          if (activeMode === 'totp') {
            await api('/api/2fa/totp/verify', { method: 'POST', body: { code } });
          } else if (activeMode === 'email') {
            await api('/api/2fa/email/verify-challenge', { method: 'POST', body: { code } });
          } else if (activeMode === 'backup') {
            await api('/api/2fa/backup/verify', { method: 'POST', body: { code } });
          }
          cancelled = true;
          m.close();
          resolve();
        } catch (err) {
          errBox.textContent = err.data?.error === 'invalid_code'
            ? 'That code did not match. Try again.'
            : (err.message || 'Verification failed.');
          errBox.hidden = false;
          codeInput.setAttribute('aria-invalid', 'true');
          codeInput.focus();
        } finally {
          busy(verifyBtn, false);
        }
      }
    }, [
      optionsGroup,
      helper,
      codeRow,
      errBox,
      h('div', { style: { display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' } }, [
        webauthnBtn, verifyBtn
      ])
    ]);

    let cancelled = false;
    const m = openModal({
      title: 'Two-factor verification',
      body: form,
      // The code input is the natural starting point for typed-code methods;
      // for WebAuthn we'll redirect focus to the security-key button after open.
      initialFocus: activeMode === 'webauthn' ? webauthnBtn : codeInput,
      onClose: () => {
        if (!cancelled) { cancelled = true; reject(new Error('cancelled')); }
      }
    });

    // Initialize the active mode (paints aria-pressed states and helper text).
    // We pass `skipFocus: true` because openModal already settled focus on the
    // right control via `initialFocus`, and setMode's own focus call would race.
    setMode(activeMode, true);
  });
}
