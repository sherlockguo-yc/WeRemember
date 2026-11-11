import jwt from 'jsonwebtoken';

export function makeAuth(ctx) {
  return (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    let payload;
    try {
      payload = jwt.verify(h.slice(7), ctx.jwtSecret);
    } catch {
      return res.status(401).json({ error: '登录已过期' });
    }
    const user = ctx.db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    req.user = user;
    req.uid = user.id;
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

export function isMember(db, groupId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId));
}

export function memberGroupIds(db, userId) {
  return db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId).map((r) => r.group_id);
}
