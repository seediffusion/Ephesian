import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}
loadEnvFile();

function ensureSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) return;
  const generated = crypto.randomBytes(48).toString('base64url');
  const envPath = path.join(PROJECT_ROOT, '.env');
  let body = '';
  if (fs.existsSync(envPath)) body = fs.readFileSync(envPath, 'utf8');
  if (/^SESSION_SECRET=.*$/m.test(body)) {
    body = body.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${generated}`);
  } else {
    if (body.length && !body.endsWith('\n')) body += '\n';
    body += `SESSION_SECRET=${generated}\n`;
  }
  fs.writeFileSync(envPath, body, { mode: 0o600 });
  process.env.SESSION_SECRET = generated;
}
ensureSessionSecret();

function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function toInt(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInt(v, fallback) {
  const n = toInt(v, fallback);
  return n > 0 ? n : fallback;
}

const port = toInt(process.env.PORT, 8787);
const wsPort = toInt(process.env.WS_PORT, 0) || port;
const publicOrigin = (process.env.PUBLIC_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');

let rpId = process.env.WEBAUTHN_RP_ID || '';
let rpOrigin = process.env.WEBAUTHN_ORIGIN || publicOrigin;
if (!rpId) {
  try {
    rpId = new URL(publicOrigin).hostname;
  } catch {
    rpId = 'localhost';
  }
}

export const config = {
  projectRoot: PROJECT_ROOT,
  appName: process.env.APP_NAME || 'Ephesian',
  port,
  wsPort,
  publicOrigin,
  trustProxy: toBool(process.env.TRUST_PROXY, false),
  cookieSecure: toBool(process.env.COOKIE_SECURE, false),
  sessionSecret: process.env.SESSION_SECRET,
  databasePath: path.isAbsolute(process.env.DATABASE_PATH || '')
    ? process.env.DATABASE_PATH
    : path.join(PROJECT_ROOT, process.env.DATABASE_PATH || 'data/ephesian.db'),
  defaultDocumentCapacity: toInt(process.env.DEFAULT_DOCUMENT_CAPACITY, 0),
  passwordResetRateLimits: {
    requestIpMax: toPositiveInt(process.env.PASSWORD_RESET_REQUEST_IP_MAX, 10),
    requestIpWindowMs: toPositiveInt(process.env.PASSWORD_RESET_REQUEST_IP_WINDOW_MS, 60 * 60 * 1000),
    requestEmailMax: toPositiveInt(process.env.PASSWORD_RESET_REQUEST_EMAIL_MAX, 5),
    requestEmailWindowMs: toPositiveInt(process.env.PASSWORD_RESET_REQUEST_EMAIL_WINDOW_MS, 60 * 60 * 1000),
    confirmIpMax: toPositiveInt(process.env.PASSWORD_RESET_CONFIRM_IP_MAX, 20),
    confirmIpWindowMs: toPositiveInt(process.env.PASSWORD_RESET_CONFIRM_IP_WINDOW_MS, 15 * 60 * 1000)
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    secure: toBool(process.env.SMTP_SECURE, false),
    from: process.env.SMTP_FROM || 'Ephesian <no-reply@example.com>',
    enabled: !!process.env.SMTP_HOST
  },
  webauthn: {
    rpName: process.env.WEBAUTHN_RP_NAME || process.env.APP_NAME || 'Ephesian',
    rpId,
    origin: rpOrigin
  }
};
