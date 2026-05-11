#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const TARGET = path.join(ROOT, '.env');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q, def) {
  return new Promise((resolve) => {
    const hint = def ? ` [${def}]` : '';
    rl.question(`${q}${hint}: `, (a) => {
      const ans = (a || '').trim();
      resolve(ans || def || '');
    });
  });
}

function readExample() {
  return fs.readFileSync(EXAMPLE, 'utf8');
}

function patch(env, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) return env.replace(re, `${key}=${value}`);
  return env + (env.endsWith('\n') ? '' : '\n') + `${key}=${value}\n`;
}

console.log('');
console.log('  Ephesian setup wizard');
console.log('  ─────────────────────');
console.log('  This walks you through .env values. Press Enter to accept defaults.');
console.log('  You can re-run this any time with `npm run setup`.');
console.log('');

let env = readExample();

const port = await ask('HTTP port', '8787');
env = patch(env, 'PORT', port);

const origin = await ask('Public origin (where users will reach the app)', `http://localhost:${port}`);
env = patch(env, 'PUBLIC_ORIGIN', origin.replace(/\/$/, ''));

const cookieSecure = origin.startsWith('https://') ? 'true' : 'false';
env = patch(env, 'COOKIE_SECURE', cookieSecure);

const trustProxy = (await ask('Are you behind a reverse proxy that sets X-Forwarded-*? (y/N)', 'n')).toLowerCase().startsWith('y') ? 'true' : 'false';
env = patch(env, 'TRUST_PROXY', trustProxy);

const sessionSecret = crypto.randomBytes(48).toString('base64url');
env = patch(env, 'SESSION_SECRET', sessionSecret);

const dbPath = await ask('SQLite database file path', './data/ephesian.db');
env = patch(env, 'DATABASE_PATH', dbPath);

console.log('');
console.log('  -- Email delivery ----------------------------------------------');
console.log('  If you skip SMTP, verification codes and invite links print to');
console.log('  the terminal — fine for testing or single-user use.');
const useSmtp = (await ask('Configure SMTP now? (y/N)', 'n')).toLowerCase().startsWith('y');
if (useSmtp) {
  env = patch(env, 'SMTP_HOST', await ask('SMTP host', 'smtp.example.com'));
  env = patch(env, 'SMTP_PORT', await ask('SMTP port', '587'));
  env = patch(env, 'SMTP_USER', await ask('SMTP username', ''));
  env = patch(env, 'SMTP_PASS', await ask('SMTP password', ''));
  env = patch(env, 'SMTP_SECURE', (await ask('Use TLS on connect? (y/N)', 'n')).toLowerCase().startsWith('y') ? 'true' : 'false');
  env = patch(env, 'SMTP_FROM', await ask('"From" header', `Ephesian <no-reply@${new URL(origin).hostname}>`));
} else {
  env = patch(env, 'SMTP_HOST', '');
}

const appName = await ask('App name shown in the header', 'Ephesian');
env = patch(env, 'APP_NAME', appName);

const cap = await ask('Default per-document collaborator cap (0 = unlimited)', '0');
env = patch(env, 'DEFAULT_DOCUMENT_CAPACITY', cap);

fs.writeFileSync(TARGET, env, { mode: 0o600 });
console.log('');
console.log('  Saved configuration to .env');
console.log('  Start the server with:  npm start');
console.log('  Or in dev mode:         npm run dev');
console.log('');

rl.close();
