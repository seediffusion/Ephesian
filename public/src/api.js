export async function api(path, { method = 'GET', body, headers, signal } = {}) {
  const opts = { method, headers: { ...(headers || {}) }, credentials: 'same-origin', signal };
  if (body !== undefined) {
    if (body instanceof FormData) {
      opts.body = body;
    } else if (typeof body === 'string') {
      opts.body = body;
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'text/plain';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  if (!res.ok) {
    const err = new Error(typeof data === 'object' ? (data.error || res.statusText) : res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function downloadFile(path, { method = 'POST', body, filename } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let _me = null;
export async function fetchMe(force = false) {
  if (_me && !force) return _me;
  const data = await api('/api/auth/me');
  _me = data;
  return data;
}

export function clearMeCache() { _me = null; }

export function meUser() { return _me?.user || null; }
export function mePending2FA() { return !!_me?.pending2FA; }
