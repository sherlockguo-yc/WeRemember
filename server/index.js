import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { openDB } from './db.js';
import { createApp } from './app.js';
import { ensureBootstrapInvite } from './routes/auth.js';
import { sendServerChan, sendMail } from './lib/channels.js';
import { startScheduler } from './lib/scheduler.js';
import { loadVapid, sendWebPush } from './lib/webpush.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dataDir = process.env.DATA_DIR || join(root, 'data');
const PORT = process.env.PORT || 5176;

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = join(dataDir, '.jwt-secret');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

const db = openDB(join(dataDir, 'weremember.db'));
ensureBootstrapInvite(db, process.env);
if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get() && !process.env.ADMIN_INVITE_CODE) {
  console.warn('[warn] 还没有管理员，也未设置 ADMIN_INVITE_CODE，无法注册首个账号');
}

const vapid = loadVapid(dataDir, process.env);

const ctx = {
  db,
  dataDir,
  jwtSecret: loadSecret(),
  env: process.env,
  vapid,
  now: () => Date.now(),
  senders: {
    serverchan: (key, title, md) => sendServerChan(key, title, md),
    email: (to, title, text) => sendMail(to, title, text),
    push: (sub, payload) => sendWebPush(vapid, sub, payload),
  },
  publicDir: join(root, 'public'),
};

createApp(ctx).listen(PORT, () => {
  console.log(`WeRemember 已启动: http://localhost:${PORT}`);
});
startScheduler(ctx);
