import { Router } from 'express';
import express from 'express';
import fs from 'fs';
import { isMember, memberGroupIds } from '../middleware.js';
import { absPath, removeFile, sniffType, storeFile } from '../lib/files.js';

const MAX_UPLOAD = 20 * 1024 * 1024;

function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function manualRoutes(ctx) {
  const router = Router();
  const { db } = ctx;
  const rawBody = express.raw({ type: () => true, limit: MAX_UPLOAD });

  const SELECT = `
    SELECT m.id, m.group_id, m.name, m.category, m.note, m.file_name, m.mime, m.size, m.created_at,
           g.name AS group_name, g.is_personal, u.display_name AS creator_name
    FROM manuals m JOIN family_groups g ON g.id = m.group_id JOIN users u ON u.id = m.created_by
  `;

  const loadOwned = (req, res) => {
    const row = db.prepare('SELECT * FROM manuals WHERE id = ?').get(Number(req.params.id));
    if (!row || !isMember(db, row.group_id, req.uid)) {
      res.status(404).json({ error: '说明书不存在' });
      return null;
    }
    return row;
  };

  const cleanMeta = (src) => {
    const name = String(src.name || '').trim();
    const category = String(src.category || '').trim();
    const note = String(src.note || '').trim();
    if (!name) return { error: '请填写产品名称' };
    if (name.length > 50) return { error: '产品名称最长 50 字' };
    if (category.length > 20) return { error: '分类最长 20 字' };
    if (note.length > 200) return { error: '备注最长 200 字' };
    return { value: { name, category, note } };
  };

  // 上传：文件内容作为请求体，元信息放在查询参数（不引入 multipart 依赖）
  router.post('/', rawBody, (req, res) => {
    const gid = Number(req.query.group_id);
    if (!gid || !isMember(db, gid, req.uid)) return res.status(403).json({ error: '请选择你所在的家庭组' });
    const { error, value } = cleanMeta(req.query);
    if (error) return res.status(400).json({ error });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: '没有收到文件' });
    const t = sniffType(buf);
    if (!t) return res.status(400).json({ error: '只支持 PDF 和 jpg / png / webp 图片' });

    const fileName = String(req.query.file_name || '').trim().slice(0, 100) || `${value.name}.${t.ext}`;
    const rel = storeFile(ctx.dataDir, 'manuals', gid, buf, t.ext);
    const r = db.prepare(`
      INSERT INTO manuals (group_id, name, category, note, file_name, file_path, mime, size, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(gid, value.name, value.category, value.note, fileName, rel, t.mime, buf.length, req.uid, ctx.now());
    res.status(201).json({ manual: db.prepare(`${SELECT} WHERE m.id = ?`).get(r.lastInsertRowid) });
  });

  router.get('/', (req, res) => {
    let gids = memberGroupIds(db, req.uid);
    if (req.query.group_id) {
      const gid = Number(req.query.group_id);
      if (!gids.includes(gid)) return res.status(403).json({ error: '你不是该组的成员' });
      gids = [gid];
    }
    if (!gids.length) return res.json({ manuals: [] });
    const marks = gids.map(() => '?').join(',');
    const q = String(req.query.q || '').trim().slice(0, 50);
    const params = [...gids];
    let where = `m.group_id IN (${marks})`;
    if (q) {
      const like = `%${likeEscape(q)}%`;
      where += ` AND (m.name LIKE ? ESCAPE '\\' OR m.category LIKE ? ESCAPE '\\'
                      OR m.note LIKE ? ESCAPE '\\' OR m.file_name LIKE ? ESCAPE '\\')`;
      params.push(like, like, like, like);
    }
    const rows = db.prepare(`${SELECT} WHERE ${where} ORDER BY m.created_at DESC LIMIT 300`).all(...params);
    res.json({ manuals: rows });
  });

  router.get('/:id/file', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    const file = absPath(ctx.dataDir, cur.file_path);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '文件已丢失' });
    const disp = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', cur.mime);
    res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(cur.file_name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(file).pipe(res);
  });

  router.put('/:id', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    const { error, value } = cleanMeta(req.body || {});
    if (error) return res.status(400).json({ error });
    db.prepare('UPDATE manuals SET name = ?, category = ?, note = ? WHERE id = ?')
      .run(value.name, value.category, value.note, cur.id);
    res.json({ manual: db.prepare(`${SELECT} WHERE m.id = ?`).get(cur.id) });
  });

  router.delete('/:id', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    db.prepare('DELETE FROM manuals WHERE id = ?').run(cur.id);
    removeFile(ctx.dataDir, cur.file_path);
    res.json({ success: true });
  });

  return router;
}
