import { Router } from 'express';
import express from 'express';
import { isMember, memberGroupIds } from '../middleware.js';
import { todayBJ } from '../lib/dates.js';
import { itemState, normalizeItemInput, stageOf, CATEGORY_LABEL } from '../lib/reminder-rules.js';
import { absPath, removeFile, sniffType, storeFile } from '../lib/files.js';
import fs from 'fs';

const MAX_UPLOAD = 20 * 1024 * 1024;

export function itemRoutes(ctx) {
  const router = Router();
  const { db } = ctx;
  const rawBody = express.raw({ type: () => true, limit: MAX_UPLOAD });

  const decorate = (row, today) => ({
    id: row.id,
    group_id: row.group_id,
    group_name: row.group_name,
    is_personal: Boolean(row.is_personal),
    name: row.name,
    category: row.category,
    category_label: CATEGORY_LABEL[row.category] || row.category,
    note: row.note,
    production_date: row.production_date,
    shelf_life_value: row.shelf_life_value,
    shelf_life_unit: row.shelf_life_unit,
    expiry_date: row.expiry_date,
    has_photo: Boolean(row.photo_file),
    status: row.status,
    processed_kind: row.processed_kind,
    processed_by_name: row.processed_by_name || null,
    processed_at: row.processed_at,
    created_at: row.created_at,
    state: row.status === 'active' ? itemState(row, today) : null,
  });

  const SELECT = `
    SELECT i.*, g.name AS group_name, g.is_personal, pu.display_name AS processed_by_name
    FROM items i JOIN family_groups g ON g.id = i.group_id
    LEFT JOIN users pu ON pu.id = i.processed_by
  `;

  // 取物品并校验当前用户是该组成员；不是成员一律按不存在处理，避免泄露
  const loadOwned = (req, res) => {
    const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(Number(req.params.id));
    if (!row || !isMember(db, row.group_id, req.uid)) {
      res.status(404).json({ error: '物品不存在' });
      return null;
    }
    return row;
  };

  router.get('/', (req, res) => {
    const today = todayBJ(ctx.now());
    const scope = req.query.scope === 'history' ? 'history' : 'active';
    let gids = memberGroupIds(db, req.uid);
    if (req.query.group_id) {
      const gid = Number(req.query.group_id);
      if (!gids.includes(gid)) return res.status(403).json({ error: '你不是该组的成员' });
      gids = [gid];
    }
    if (!gids.length) return res.json({ items: [] });
    const marks = gids.map(() => '?').join(',');
    const rows = scope === 'active'
      ? db.prepare(`${SELECT} WHERE i.group_id IN (${marks}) AND i.status = 'active'
                    ORDER BY (i.expiry_date IS NULL), i.expiry_date ASC, i.id ASC`).all(...gids)
      : db.prepare(`${SELECT} WHERE i.group_id IN (${marks}) AND i.status != 'active'
                    ORDER BY i.processed_at DESC LIMIT 200`).all(...gids);
    res.json({ items: rows.map((r) => decorate(r, today)) });
  });

  router.post('/', (req, res) => {
    const today = todayBJ(ctx.now());
    const gid = Number(req.body.group_id);
    if (!gid || !isMember(db, gid, req.uid)) return res.status(403).json({ error: '请选择你所在的家庭组' });
    const { error, value } = normalizeItemInput(req.body, today);
    if (error) return res.status(400).json({ error });
    const r = db.prepare(`
      INSERT INTO items (group_id, name, category, note, production_date, shelf_life_value, shelf_life_unit,
                         expiry_date, base_date, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(gid, value.name, value.category, value.note, value.production_date, value.shelf_life_value,
      value.shelf_life_unit, value.expiry_date, value.base_date, req.uid, ctx.now());
    const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(r.lastInsertRowid);
    res.status(201).json({ item: decorate(row, today) });
  });

  router.put('/:id', (req, res) => {
    const today = todayBJ(ctx.now());
    const cur = loadOwned(req, res);
    if (!cur) return;
    const { error, value } = normalizeItemInput(req.body, today);
    if (error) return res.status(400).json({ error });

    // 提醒基准：有生产日期取生产日期，否则取录入日期（不随编辑日期漂移）
    const base_date = value.production_date || todayBJ(cur.created_at);
    const next = { ...value, base_date };
    const datesChanged = next.expiry_date !== cur.expiry_date || next.base_date !== cur.base_date
      || next.category !== cur.category;

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE items SET name = ?, category = ?, note = ?, production_date = ?, shelf_life_value = ?,
          shelf_life_unit = ?, expiry_date = ?, base_date = ? WHERE id = ?
      `).run(next.name, next.category, next.note, next.production_date, next.shelf_life_value,
        next.shelf_life_unit, next.expiry_date, next.base_date, cur.id);
      if (datesChanged) {
        // 到期日变化后按新日期重新判定：已越过的阶段视为已提醒，不补发
        const { stage } = stageOf({ ...cur, ...next }, today);
        db.prepare('DELETE FROM reminder_state WHERE item_id = ?').run(cur.id);
        const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(cur.group_id);
        const ins = db.prepare('INSERT INTO reminder_state (user_id, item_id, last_stage, last_reminded_on) VALUES (?, ?, ?, ?)');
        members.forEach((m) => ins.run(m.user_id, cur.id, stage, stage > 0 ? today : null));
      }
    });
    tx();
    res.json({ item: decorate(db.prepare(`${SELECT} WHERE i.id = ?`).get(cur.id), today) });
  });

  // 幂等：已处理的再次处理不报错
  router.post('/:id/handle', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    const kind = req.body.kind;
    if (!['used', 'discarded'].includes(kind)) return res.status(400).json({ error: '处理方式必须是 used 或 discarded' });
    if (cur.status === 'active') {
      db.prepare('UPDATE items SET status = ?, processed_kind = ?, processed_by = ?, processed_at = ? WHERE id = ? AND status = ?')
        .run(kind, kind, req.uid, ctx.now(), cur.id, 'active');
    }
    res.json({ success: true });
  });

  router.post('/:id/restore', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    db.prepare(`UPDATE items SET status = 'active', processed_kind = NULL, processed_by = NULL, processed_at = NULL WHERE id = ?`)
      .run(cur.id);
    res.json({ success: true });
  });

  router.delete('/:id', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    db.prepare('DELETE FROM items WHERE id = ?').run(cur.id);
    removeFile(ctx.dataDir, cur.photo_file);
    res.json({ success: true });
  });

  // ---- 包装日期照片（V1 只存图，为 V2 的 OCR 预留）----
  router.post('/:id/photo', rawBody, (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: '没有收到图片' });
    const t = sniffType(buf);
    if (!t || t.mime === 'application/pdf') return res.status(400).json({ error: '只支持 jpg / png / webp 图片' });
    const rel = storeFile(ctx.dataDir, 'photos', cur.group_id, buf, t.ext);
    db.prepare('UPDATE items SET photo_file = ? WHERE id = ?').run(rel, cur.id);
    removeFile(ctx.dataDir, cur.photo_file);
    res.json({ success: true });
  });

  router.get('/:id/photo', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    if (!cur.photo_file) return res.status(404).json({ error: '没有照片' });
    const file = absPath(ctx.dataDir, cur.photo_file);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '照片文件已丢失' });
    const t = sniffType(fs.readFileSync(file).subarray(0, 16));
    res.setHeader('Content-Type', t ? t.mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(file).pipe(res);
  });

  router.delete('/:id/photo', (req, res) => {
    const cur = loadOwned(req, res);
    if (!cur) return;
    db.prepare('UPDATE items SET photo_file = NULL WHERE id = ?').run(cur.id);
    removeFile(ctx.dataDir, cur.photo_file);
    res.json({ success: true });
  });

  return router;
}
