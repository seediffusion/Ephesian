import { h, busy, toast, announceRoute, nextId } from '../ui.js';
import { api, clearMeCache, fetchMe, meUser } from '../api.js';
import { navigate } from '../router.js';

export async function renderVerify(main, search) {
  main.innerHTML = '';
  await fetchMe(true);
  const user = meUser();
  if (!user) { navigate('/login'); return; }
  if (user.emailVerified) { navigate('/dashboard'); return; }

  const helpId = nextId('verify-help');
  const errId = nextId('verify-error');

  const codeInput = h('input', {
    type: 'text',
    id: 'verify-code',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: '6',
    pattern: '\\d{6}',
    required: true,
    'aria-describedby': helpId
  });
  const err = h('div', {
    id: errId,
    class: 'field-error',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: true
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, ['Confirm email']);
  const resend = h('button', { type: 'button', class: 'btn btn-ghost' }, ['Resend code']);

  const initialCode = search?.get('code');
  const uidFromUrl = search?.get('uid');
  if (initialCode) codeInput.value = initialCode;

  resend.addEventListener('click', async () => {
    busy(resend, true);
    try {
      const r = await api('/api/auth/resend-verification', { method: 'POST' });
      if (r.alreadyVerified) navigate('/dashboard');
      else toast('Verification code re-sent. Check your inbox.', 'success');
    } catch (e) {
      toast('Could not resend — please try again later.', 'error');
    } finally { busy(resend, false); }
  });

  const form = h('form', {
    'aria-labelledby': 'verify-heading',
    'aria-describedby': errId,
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      codeInput.removeAttribute('aria-invalid');
      busy(submit, true);
      try {
        const body = { code: codeInput.value.trim() };
        if (uidFromUrl) body.userId = uidFromUrl;
        await api('/api/auth/verify-email', { method: 'POST', body });
        clearMeCache();
        try { await api('/api/invites/email/claim-pending', { method: 'POST' }); } catch {}
        toast('Email verified.', 'success');
        navigate('/dashboard');
      } catch (e2) {
        err.textContent = e2.data?.error === 'invalid_or_expired'
          ? 'That code is invalid or has expired. Use "Resend code" to get a fresh one.'
          : (e2.message || 'Verification failed.');
        err.hidden = false;
        codeInput.setAttribute('aria-invalid', 'true');
        codeInput.focus();
      } finally { busy(submit, false); }
    }
  }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'verify-code' }, ['Enter the 6-digit code we sent to your email']),
      codeInput,
      h('div', { class: 'field-help', id: helpId }, [
        'Codes expire after 30 minutes. If no email arrived, check spam, or use "Resend code".'
      ])
    ]),
    err,
    h('div', { style: { display: 'flex', gap: '0.5rem', justifyContent: 'space-between', alignItems: 'center' } }, [
      resend, submit
    ])
  ]);

  main.appendChild(h('section', { class: 'auth-page card' }, [
    h('h1', { id: 'verify-heading' }, ['Confirm your email']),
    h('p', {}, [
      'We sent a code to ', h('strong', {}, [user.email]),
      '. Enter it below to finish setting up your account.'
    ]),
    form
  ]));

  announceRoute('Confirm your email');

  if (initialCode && uidFromUrl) {
    // Auto-submit when arriving from an email link, but give the route announcement
    // time to be read first and tell the user what is happening.
    setTimeout(() => {
      toast('Confirming your verification code automatically…', 'info', { ttl: 4000 });
      setTimeout(() => form.requestSubmit(), 600);
    }, 800);
  }
}
