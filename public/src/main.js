import { route, dispatch, navigate, bindLinks } from './router.js';
import { setupThemeToggle } from './theme.js';
import { renderAuthSlot } from './auth-slot.js';
import { fetchMe } from './api.js';

import { renderLanding } from './pages/landing.js';
import { renderRegister } from './pages/register.js';
import { renderLogin } from './pages/login.js';
import { renderForgotPassword } from './pages/forgot-password.js';
import { renderResetPassword } from './pages/reset-password.js';
import { renderVerify } from './pages/verify.js';
import { renderAccount } from './pages/account.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderEditorPage } from './pages/editor-page.js';
import { renderLinkInvite, renderEmailInvite } from './pages/invite.js';

const main = document.getElementById('main');

route('/', async () => {
  await fetchMe(true);
  renderLanding(main);
});
route('/login', ({ search }) => renderLogin(main, search));
route('/register', ({ search }) => renderRegister(main, search));
route('/forgot-password', () => renderForgotPassword(main));
route('/reset-password', ({ search }) => renderResetPassword(main, search));
route('/verify', ({ search }) => renderVerify(main, search));
route('/account', () => renderAccount(main));
route('/dashboard', () => renderDashboard(main));
route('/d/:id', ({ params }) => renderEditorPage(main, params));
route('/invite/link/:token', ({ params }) => renderLinkInvite(main, params));
route('/invite/email/:token', ({ params }) => renderEmailInvite(main, params));

setupThemeToggle();
bindLinks();

(async () => {
  await renderAuthSlot();
  const matched = await dispatch(window.location.href);
  if (!matched) renderLanding(main);
})();
