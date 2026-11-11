import { Router } from 'express';
import { uniqueCode } from '../lib/codes.js';
import { isMember } from '../middleware.js';
import { removeFile } from '../lib/files.js';

export function groupRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  const codeExists = (c) => db.prepare('SELECT 1 FROM family_groups WHERE invite_code = ?').get(c);

  const summary = (gid, uid) => {
    const g = db.prepare('SELECT * FROM family_groups WHERE id = ?').get(gid);
    const count = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(gid).c;
    return {
      id: g.id, name: g.name, is_personal: Boolean(g.is_personal), member_count: count,
      is_owner: g.created_by === uid,
      invite_code: g.created_by === uid ? g.invite_code : null,
    };
  };

  router.get('/', (req, res) => {
    const ids = db.prepare(`
      SELECT g.id FROM family_groups g JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = ? ORDER BY g.is_personal DESC, gm.joined_at ASC, g.id ASC
    `).all(req.uid).map((r) => r.id);
    res.json({ groups: ids.map((id) => summary(id, req.uid)) });
  });

  router.post('/', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '组名不能为空' });
    if (name.length > 30) return res.status(400).json({ error: '组名最长 30 字' });
    const code = uniqueCode(6, codeExists);
    const r = db.prepare('INSERT INTO family_groups (name, invite_code, is_personal, created_by) VALUES (?, ?, 0, ?)')
      .run(name, code, req.uid);
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(r.lastInsertRowid, req.uid);
    res.status(201).json({ group: summary(Number(r.lastInsertRowid), req.uid) });
  });

  // 家庭组邀请码：让已有账号加入某个组（区别于注册邀请码）
  router.post('/join', (req, res) => {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: '邀请码不能为空' });
    const g = db.prepare('SELECT * FROM family_groups WHERE invite_code = ? AND is_personal = 0').get(code);
    if (!g) return res.status(404).json({ error: '邀请码无效' });
    if (isMember(db, g.id, req.uid)) return res.status(409).json({ error: '你已在该家庭组中' });
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, req.uid);
    res.json({ group: summary(g.id, req.uid) });
  });

  router.get('/:id', (req, res) => {
    const gid = Number(req.params.id);
    if (!isMember(db, gid, req.uid)) return res.status(403).json({ error: '你不是该组的成员' });
    const members = db.prepare(`
      SELECT u.id, u.display_name, u.username, gm.joined_at
      FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.joined_at
    `).all(gid);
    res.json({ group: summary(gid, req.uid), members });
  });

  const ownerOnly = (req, res) => {
    const gid = Number(req.params.id);
    const g = db.prepare('SELECT * FROM family_groups WHERE id = ?').get(gid);
    if (!g || !isMember(db, gid, req.uid)) { res.status(404).json({ error: '家庭组不存在' }); return null; }
    if (g.created_by !== req.uid) { res.status(403).json({ error: '只有组长能执行此操作' }); return null; }
    return g;
  };

  router.put('/:id', (req, res) => {
    const g = ownerOnly(req, res);
    if (!g) return;
    if (g.is_personal) return res.status(400).json({ error: '个人空间不能改名' });
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 30) return res.status(400).json({ error: '组名 1-30 个字符' });
    db.prepare('UPDATE family_groups SET name = ? WHERE id = ?').run(name, g.id);
    res.json({ success: true });
  });

  router.post('/:id/reset-code', (req, res) => {
    const g = ownerOnly(req, res);
    if (!g) return;
    if (g.is_personal) return res.status(400).json({ error: '个人空间没有邀请码' });
    const code = uniqueCode(6, codeExists);
    db.prepare('UPDATE family_groups SET invite_code = ? WHERE id = ?').run(code, g.id);
    res.json({ invite_code: code });
  });

  router.delete('/:id/members/:uid', (req, res) => {
    const g = ownerOnly(req, res);
    if (!g) return;
    const target = Number(req.params.uid);
    if (target === req.uid) return res.status(400).json({ error: '不能移出自己' });
    const r = db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g.id, target);
    if (r.changes === 0) return res.status(404).json({ error: '该成员不在组中' });
    res.json({ success: true });
  });

  router.post('/:id/leave', (req, res) => {
    const gid = Number(req.params.id);
    const g = db.prepare('SELECT * FROM family_groups WHERE id = ?').get(gid);
    if (!g || !isMember(db, gid, req.uid)) return res.status(404).json({ error: '你不在该组中' });
    if (g.is_personal) return res.status(400).json({ error: '个人空间不能退出' });

    const others = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ? ORDER BY joined_at')
      .all(gid, req.uid);
    if (g.created_by === req.uid && others.length) {
      // 组长退出：把组长身份移交给最早加入的成员，邀请码管理权随之转移
      db.prepare('UPDATE family_groups SET created_by = ? WHERE id = ?').run(others[0].user_id, gid);
    }
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, req.uid);

    if (!others.length) {
      // 最后一人离开：连同组内数据与文件一并清理
      const files = [
        ...db.prepare('SELECT file_path AS f FROM manuals WHERE group_id = ?').all(gid),
        ...db.prepare('SELECT photo_file AS f FROM items WHERE group_id = ? AND photo_file IS NOT NULL').all(gid),
      ];
      db.prepare('DELETE FROM family_groups WHERE id = ?').run(gid);
      files.forEach((x) => removeFile(ctx.dataDir, x.f));
    }
    res.json({ success: true });
  });

  return router;
}
