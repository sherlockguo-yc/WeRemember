import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createLimiter, limitMiddleware } from '../lib/ratelimit.js';

export function ensureBootstrapInvite(db, env) {
  const code = (env.ADMIN_INVITE_CODE || '').trim().toUpperCase();
  if (!code) return;
  const hasAdmin = db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get();
  if (hasAdmin) return;
  db.prepare(`INSERT OR IGNORE INTO invites (code, created_by, is_admin, created_at, expires_at)
              VALUES (?, NULL, 1, ?, NULL)`).run(code, Date.now());
}

export function createUserWithPersonalGroup(db, { username, passwordHash, displayName, isAdmin }) {
  const r = db.prepare('INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, displayName, isAdmin ? 1 : 0);
  const uid = Number(r.lastInsertRowid);
  const g = db.prepare('INSERT INTO family_groups (name, invite_code, is_personal, created_by) VALUES (?, NULL, 1, ?)')
    .run('个人空间', uid);
  db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.lastInsertRowid, uid);
  return uid;
}

export function authRoutes(ctx) {
  const router = Router();
  const { db } = ctx;
  const authLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
  const limit = limitMiddleware(authLimiter, '尝试次数过多，请 15 分钟后再试');
  router.limiter = authLimiter;

  const sign = (user) => jwt.sign({ uid: user.id }, ctx.jwtSecret, { expiresIn: '30d' });

  router.post('/register', limit, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const code = String(req.body.invite_code || '').trim().toUpperCase();
    const displayName = String(req.body.display_name || '').trim().slice(0, 20) || username;

    if (!username || !password || !code) return res.status(400).json({ error: '用户名、密码和邀请码都必填' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名 2-20 个字符' });
    if (password.length < 6 || password.length > 72) return res.status(400).json({ error: '密码 6-72 位' });

    const hash = bcrypt.hashSync(password, 10);
    let user;
    const tx = db.transaction(() => {
      const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
      if (!inv) throw Object.assign(new Error('邀请码不存在'), { status: 400 });
      if (inv.used_by) throw Object.assign(new Error('邀请码已被使用'), { status: 400 });
      if (inv.expires_at && inv.expires_at < ctx.now()) throw Object.assign(new Error('邀请码已过期'), { status: 400 });
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        throw Object.assign(new Error('用户名已被注册'), { status: 409 });
      }
      const uid = createUserWithPersonalGroup(db, {
        username, passwordHash: hash, displayName, isAdmin: Boolean(inv.is_admin),
      });
      db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(uid, ctx.now(), code);
      user = db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(uid);
    });
    try {
      tx();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    res.json({ token: sign(user), user });
  });

  router.post('/login', limit, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const user = { id: row.id, username: row.username, display_name: row.display_name, is_admin: row.is_admin };
    res.json({ token: sign(user), user });
  });

  return router;
}
