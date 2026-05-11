#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const isDev = process.argv.includes('--dev');
const DIST = path.join(ROOT, 'public', 'dist', 'main.js');
const ENV = path.join(ROOT, '.env');

if (!fs.existsSync(ENV)) {
  // Auto-copy .env.example so the user gets a working dev setup out of the box.
  const example = path.join(ROOT, '.env.example');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, ENV);
    console.log('[start] Created .env from .env.example. Run `npm run setup` to customize, or just keep going.');
  }
}

async function runNode(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, {
      stdio: 'inherit',
      cwd: ROOT,
      ...opts
    });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`node ${args[0]} exited with ${code}`)));
  });
}

async function ensureBuilt() {
  if (!fs.existsSync(DIST)) {
    console.log('[start] No bundle found — building frontend (one-time, ~1s)…');
    await runNode(['scripts/build.mjs']);
  }
}

await ensureBuilt();

if (isDev) {
  // Spawn watcher + server in parallel.
  const watcher = spawn(process.execPath, ['scripts/build.mjs', '--watch'], {
    stdio: 'inherit', cwd: ROOT
  });
  const server = spawn(process.execPath, ['server/index.js'], {
    stdio: 'inherit', cwd: ROOT
  });
  const shutdown = () => { watcher.kill(); server.kill(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('exit', shutdown);
} else {
  await runNode(['server/index.js']);
}
