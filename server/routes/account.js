import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../middleware.js';
import { uniqueCode } from '../lib/codes.js';
import {
  isValidEmail, isValidSendKey, mailConfigured, mailSenderAddress,
} from '../lib/channels.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

function maskKey(k) {
  if (!k) return '';
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function publicProfile(row, env) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    is_admin: Boolean(row.is_admin),
    email: row.email,
    notify_email: Boolean(row.notify_email),
    serverchan_key: maskKey(row.serverchan_key),
    has_serverchan_key: Boolean(row.serverchan_key),
    notify_serverchan: Boolean(row.notify_serverchan),
    notify_hour: row.notify_hour,
    mail_available: mailConfigured(env),
    mail_sender: mailSenderAddress(env),
  };
}

export function accountRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  router.get('/me', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
    res.json({ user: publicProfile(row, ctx.env) });
  });

  router.put('/me', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
    const b = req.body || {};
    const next = {
      display_name: row.display_name,
      email: row.email,
      notify_email: row.notify_email,
      serverchan_key: row.serverchan_key,
      notify_serverchan: row.notify_serverchan,
      notify_hour: row.notify_hour,
    };

    if (b.display_name !== undefined) {
      const n = String(b.display_name).trim();
      if (!n || n.length > 20) return res.status(400).json({ error: '昵称 1-20 个字符' });
      next.display_name = n;
    }
    if (b.email !== undefined) {
      const e = String(b.email).trim();
      if (e && !isValidEmail(e)) return res.status(400).json({ error: '邮箱格式不正确' });
      next.email = e;
    }
    // 带 * 的值是脱敏回显，视为"未修改"
    if (b.serverchan_key !== undefined && !String(b.serverchan_key).includes('*')) {
      const k = String(b.serverchan_key).trim();
      if (k && !isValidSendKey(k)) return res.status(400).json({ error: 'SendKey 格式不正确' });
      next.serverchan_key = k;
    }
    if (b.notify_hour !== undefined) {
      const h = Number(b.notify_hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) return res.status(400).json({ error: '发送时刻必须是 0-23 的整点' });
      next.notify_hour = h;
    }
    if (b.notify_email !== undefined) next.notify_email = b.notify_email ? 1 : 0;
    if (b.notify_serverchan !== undefined) next.notify_serverchan = b.notify_serverchan ? 1 : 0;

    if (next.notify_email && !next.email) return res.status(400).json({ error: '开启邮件提醒前请先填写邮箱' });
    if (next.notify_email && !row.notify_email && !mailConfigured(ctx.env)) {
      return res.status(400).json({ error: '服务器尚未配置发件邮箱，暂时无法开启邮件提醒' });
    }
    if (next.notify_serverchan && !next.serverchan_key) return res.status(400).json({ error: '开启微信提醒前请先填写 SendKey' });

    db.prepare(`UPDATE users SET display_name = ?, email = ?, notify_email = ?, serverchan_key = ?,
                notify_serverchan = ?, notify_hour = ? WHERE id = ?`)
      .run(next.display_name, next.email, next.notify_email, next.serverchan_key,
        next.notify_serverchan, next.notify_hour, req.uid);
    res.json({ user: publicProfile(db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid), ctx.env) });
  });

  router.post('/me/password', (req, res) => {
    const { old_password, new_password } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
    if (!bcrypt.compareSync(String(old_password || ''), row.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    const np = String(new_password || '');
    if (np.length < 6 || np.length > 72) return res.status(400).json({ error: '新密码 6-72 位' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(np, 10), req.uid);
    res.json({ success: true });
  });

  router.post('/me/test-channel', async (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
    const channel = req.body && req.body.channel;
    let result;
    if (channel === 'serverchan') {
      if (!row.serverchan_key) return res.status(400).json({ error: '请先保存 SendKey' });
      result = await ctx.senders.serverchan(row.serverchan_key, 'WeRemember 测试消息',
        '这是一条测试消息。收到它说明微信提醒已配置成功。');
    } else if (channel === 'email') {
      if (!mailConfigured(ctx.env)) return res.status(400).json({ error: '服务器尚未配置发件邮箱' });
      if (!row.email) return res.status(400).json({ error: '请先保存邮箱' });
      result = await ctx.senders.email(row.email, 'WeRemember 测试邮件',
        '这是一封测试邮件。收到它说明邮件提醒已配置成功。');
    } else {
      return res.status(400).json({ error: '未知渠道' });
    }
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ success: true });
  });

  // 最近的发送记录，设置页展示失败原因
  router.get('/me/dispatch-log', (req, res) => {
    const rows = db.prepare(`SELECT date, channel, status, attempts, item_count, error
                             FROM dispatch_log WHERE user_id = ? ORDER BY date DESC, channel LIMIT 10`).all(req.uid);
    res.json({ logs: rows });
  });

  // ---- 管理员：注册邀请码 ----
  router.post('/admin/invites', requireAdmin, (req, res) => {
    const code = uniqueCode(10, (c) => db.prepare('SELECT 1 FROM invites WHERE code = ?').get(c));
    const now = ctx.now();
    db.prepare('INSERT INTO invites (code, created_by, is_admin, created_at, expires_at) VALUES (?, ?, 0, ?, ?)')
      .run(code, req.uid, now, now + INVITE_TTL_MS);
    res.status(201).json({ code, expires_at: now + INVITE_TTL_MS });
  });

  router.get('/admin/invites', requireAdmin, (req, res) => {
    const now = ctx.now();
    const rows = db.prepare(`
      SELECT i.code, i.created_at, i.expires_at, i.used_at, u.username AS used_by_name
      FROM invites i LEFT JOIN users u ON u.id = i.used_by
      WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT 30
    `).all(req.uid);
    res.json({
      invites: rows.map((r) => ({
        ...r,
        state: r.used_at ? 'used' : (r.expires_at < now ? 'expired' : 'available'),
      })),
    });
  });

  return router;
}
