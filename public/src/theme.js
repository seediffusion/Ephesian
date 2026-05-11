const KEY = 'ephesian.theme';
const ORDER = ['auto', 'light', 'dark'];
const ICONS = { auto: '◐', light: '☀', dark: '☾' };
const LABELS = {
  auto: 'system preference',
  light: 'light',
  dark: 'dark'
};

export function currentTheme() {
  try { return localStorage.getItem(KEY) || 'auto'; }
  catch { return 'auto'; }
}

export function setTheme(t) {
  if (!ORDER.includes(t)) t = 'auto';
  try { localStorage.setItem(KEY, t); } catch {}
  document.documentElement.dataset.theme = t;
}

export function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const iconSpan = btn.querySelector('.theme-icon');

  function updateLabel() {
    const cur = currentTheme();
    const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
    if (iconSpan) iconSpan.textContent = ICONS[cur];
    btn.setAttribute('aria-label', `Theme: ${LABELS[cur]}. Activate to switch to ${LABELS[next]}.`);
    btn.title = `Theme: ${LABELS[cur]}`;
  }
  updateLabel();
  btn.addEventListener('click', () => {
    const cur = currentTheme();
    const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
    setTheme(next);
    updateLabel();
  });
}
