import express from 'express';
import mammoth from 'mammoth';
import HTMLtoDOCX from 'html-to-docx';
import TurndownService from 'turndown';
import multer from 'multer';
import { getDocumentAccess, setDocumentTitle } from '../lib/documents.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

function requireVerifiedUser(req, res) {
  if (!req.user) { res.status(401).json({ error: 'auth_required' }); return null; }
  if (!req.user.emailVerified) { res.status(403).json({ error: 'email_unverified' }); return null; }
  return req.user;
}

// Convert an uploaded document file to HTML and return it to the client.
// The client is responsible for applying the HTML to the editor, which
// then propagates through Y.js to all collaborators.
router.post('/:id/import', upload.single('file'), async (req, res) => {
  const u = requireVerifiedUser(req, res); if (!u) return;
  const a = getDocumentAccess(req.params.id, u.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (a.role === 'viewer') return res.status(403).json({ error: 'forbidden' });
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const name = req.file.originalname || 'document';
  const ext = name.toLowerCase().match(/\.(docx|html?|md|markdown|txt)$/)?.[1] || '';
  let html = '';
  let warnings = [];
  try {
    if (ext === 'docx') {
      const result = await mammoth.convertToHtml({ buffer: req.file.buffer });
      html = result.value || '';
      warnings = (result.messages || []).filter(m => m.type === 'warning').map(m => m.message);
    } else if (ext === 'html' || ext === 'htm') {
      html = sanitizeHtml(req.file.buffer.toString('utf8'));
    } else if (ext === 'md' || ext === 'markdown') {
      html = mdToHtml(req.file.buffer.toString('utf8'));
    } else if (ext === 'txt' || ext === '') {
      const txt = req.file.buffer.toString('utf8');
      html = txt.split(/\r?\n\r?\n+/)
        .map(p => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`)
        .join('');
    } else {
      return res.status(400).json({ error: 'unsupported_format', supported: ['docx', 'html', 'md', 'txt'] });
    }
  } catch (e) {
    return res.status(400).json({ error: 'import_failed', message: e.message });
  }
  if (req.body?.replaceTitle === 'true' && name) {
    setDocumentTitle(a.document.id, name.replace(/\.[^.]+$/, ''));
  }
  res.json({ ok: true, html, warnings });
});

// Convert the client-supplied HTML (current editor state) to a downloadable file.
router.post('/:id/export', express.json({ limit: '10mb' }), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  const a = getDocumentAccess(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  const fmt = String(req.query.format || 'docx').toLowerCase();
  const html = String(req.body?.html || '');
  const title = a.document.title || 'document';
  const safeName = title.replace(/[^a-z0-9-_ ]+/gi, '_').slice(0, 80) || 'document';

  if (fmt === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.html"`);
    return res.send(htmlDocument(title, html));
  }
  if (fmt === 'md') {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const md = td.turndown(html);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
    return res.send(md);
  }
  if (fmt === 'txt') {
    const txt = html.replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n')
      .replace(/<br\s*\/?>(\s|)*/gi, '\n')
      .replace(/<[^>]+>/g, '');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.txt"`);
    return res.send(decodeEntities(txt));
  }
  if (fmt === 'docx') {
    try {
      const buf = await HTMLtoDOCX(htmlDocument(title, html), null, {
        title,
        margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
      return res.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    } catch (e) {
      return res.status(500).json({ error: 'export_failed', message: e.message });
    }
  }
  res.status(400).json({ error: 'unsupported_format', supported: ['docx', 'html', 'md', 'txt'] });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function decodeEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function htmlDocument(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function sanitizeHtml(input) {
  // Strip script/style/event handlers — TipTap will also strip unknown content
  // when ingesting, but we belt-and-brace here in case the client trusts the result.
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/\sjavascript:[^"' >]+/gi, '');
}

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false, listType = null;
  for (const line of lines) {
    if (line.startsWith('```')) { inCode = !inCode; out.push(inCode ? '<pre><code>' : '</code></pre>'); continue; }
    if (inCode) { out.push(escapeHtml(line)); continue; }
    if (/^#{1,6}\s/.test(line)) {
      const n = line.match(/^#+/)[0].length;
      const text = line.slice(n + 1);
      if (listType) { out.push(`</${listType}>`); listType = null; }
      out.push(`<h${n}>${inlineMd(text)}</h${n}>`);
      continue;
    }
    if (/^[*-]\s+/.test(line)) {
      if (listType !== 'ul') { if (listType) out.push(`</${listType}>`); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inlineMd(line.replace(/^[*-]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      if (listType !== 'ol') { if (listType) out.push(`</${listType}>`); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inlineMd(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }
    if (line.trim() === '') {
      if (listType) { out.push(`</${listType}>`); listType = null; }
      continue;
    }
    if (listType) { out.push(`</${listType}>`); listType = null; }
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (listType) out.push(`</${listType}>`);
  return out.join('\n');
}
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export { router as ioRouter };
