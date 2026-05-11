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
  await transporter.sendMail({
    from: config.smtp.from,
    to,
    subject,
    text: text || stripHtml(html),
    html: html || `<pre style="font-family:inherit">${escapeHtml(text || '')}</pre>`
  });
  return { delivered: true };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
}

export function emailMode() {
  return config.smtp.enabled ? 'smtp' : 'console';
}
