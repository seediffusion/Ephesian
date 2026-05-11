#!/usr/bin/env node
import { build, context } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'src', 'main.js');
const OUT_DIR = path.join(ROOT, 'public', 'dist');

const watch = process.argv.includes('--watch');

fs.mkdirSync(OUT_DIR, { recursive: true });

const config = {
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  outdir: OUT_DIR,
  sourcemap: true,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  metafile: false,
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' }
};

if (watch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log('[build] watching public/src/**');
} else {
  await build(config);
  console.log('[build] bundled to public/dist/main.js');
}
