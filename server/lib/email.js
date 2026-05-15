import nodemailer from 'nodemailer';
import { config } from './config.js';

let transporter = null;
if (config.smtp.enabled) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
  });
}

function logToConsole(subject, to, body) {
  const bar = '─'.repeat(60);
  process.stdout.write(`\n${bar}\n[Ephesian email — SMTP not configured]\n` +
    `To:      ${to}\nSubject: ${subject}\n\n${body}\n${bar}\n\n`);
}

export async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    logToConsole(subject, to, text || stripHtml(html));
    return { delivered: false, console: true };
  }
  const info = await transporter.sendMail({
    from: config.smtp.from,
    to,
    subject,
    text: text || stripHtml(html),
    html: html || autoHtmlFromText(text || '')
  });
  return {
    delivered: true,
    messageId: info.messageId || null,
    accepted: Array.isArray(info.accepted) ? info.accepted : [],
    rejected: Array.isArray(info.rejected) ? info.rejected : [],
    pending: Array.isArray(info.pending) ? info.pending : [],
    response: info.response || ''
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
}

// Convert a plain-text email body into HTML that every major mail client renders
// reliably: paragraphs preserved, line breaks preserved, and any http/https URL
// rendered as a real <a href> so recipients do not have to copy-paste.
function autoHtmlFromText(text) {
  const escaped = escapeHtml(text);
  // Match http(s) URLs. Stop on whitespace or angle brackets, and trim trailing
  // sentence punctuation that almost certainly is not part of the URL itself.
  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<]+[^\s<.,:;!?)\]]/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;">${url}</a>`
  );
  const body = linked
    .split(/\n{2,}/)
    .map(p => '<p style="margin:0 0 1em 0;">' + p.replace(/\n/g, '<br>') + '</p>')
    .join('\n');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"></head>',
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
    'font-size:15px;line-height:1.55;color:#15171c;max-width:36rem;margin:1.5rem auto;padding:0 1rem;">',
    body,
    '</body></html>'
  ].join('');
}

export function emailMode() {
  return config.smtp.enabled ? 'smtp' : 'console';
}
