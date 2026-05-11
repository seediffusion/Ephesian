const routes = [];

export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ pattern, re, keys, handler });
}

export async function dispatch(url) {
  const u = new URL(url, window.location.origin);
  for (const r of routes) {
    const m = u.pathname.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      await r.handler({ params, search: u.searchParams, path: u.pathname });
      return true;
    }
  }
  return false;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  dispatch(window.location.href);
}

export function bindLinks(root = document.body) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http')) return;
    e.preventDefault();
    navigate(href);
  });
}

window.addEventListener('popstate', () => dispatch(window.location.href));
