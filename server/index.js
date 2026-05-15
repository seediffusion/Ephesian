import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { config } from './lib/config.js';
import { attachUser, requireAuth } from './lib/sessions.js';
import { authRouter } from './routes/auth.js';
import { twofaRouter } from './routes/twofa.js';
import { documentsRouter } from './routes/documents.js';
import { invitesRouter } from './routes/invites.js';
import { ioRouter } from './routes/io.js';
import { attachCollabServer } from './lib/collab.js';

const PROJECT_ROOT = config.projectRoot;
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DIST_DIR = path.join(PUBLIC_DIR, 'dist');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'interest-cohort=(), publickey-credentials-get=(self), publickey-credentials-create=(self)');
  next();
});

app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.use(attachUser);

// ------- API routes -------
app.use('/api/auth', authRouter);
app.use('/api/2fa', twofaRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/documents', ioRouter);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    appName: config.appName,
    smtpConfigured: config.smtp.enabled,
    publicOrigin: config.publicOrigin
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    appName: config.appName,
    publicOrigin: config.publicOrigin,
    webauthn: { rpId: config.webauthn.rpId, rpName: config.webauthn.rpName },
    smtpConfigured: config.smtp.enabled
  });
});

// ------- Static assets -------
app.use('/dist', express.static(DIST_DIR, { maxAge: '1h', index: false }));
app.use(express.static(PUBLIC_DIR, { index: false }));

// ------- HTML pages (single shell at /, dynamic routing via client) -------
function serveShell(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
}

const PAGES = [
  '/', '/login', '/register', '/forgot-password', '/reset-password', '/verify', '/account', '/dashboard',
  '/d/:id', '/invite/link/:token', '/invite/email/:token'
];
for (const p of PAGES) app.get(p, serveShell);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  serveShell(req, res);
});

const httpServer = http.createServer(app);
attachCollabServer(httpServer);

httpServer.listen(config.port, () => {
  const banner = `
╔═════════════════════════════════════════════════════════════════╗
║                                                                 ║
║   ${config.appName.padEnd(60)}║
║   Open ${config.publicOrigin.padEnd(56)}║
║                                                                 ║
║   Email delivery: ${(config.smtp.enabled ? 'SMTP (live)' : 'console (no SMTP configured)').padEnd(46)}║
║   Database:       ${config.databasePath.replace(PROJECT_ROOT, '.').padEnd(46)}║
║                                                                 ║
║   First-time setup tip: run \`npm run setup\` to be walked        ║
║   through .env values, or just open the URL above and register. ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
`;
  process.stdout.write(banner);
});
