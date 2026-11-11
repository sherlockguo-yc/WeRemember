// 内存限流：同一 key 在窗口内最多 max 次。进程重启后清零，对个人项目足够。
export function createLimiter({ windowMs, max }) {
  const hits = new Map();
  return {
    // 返回 true 表示放行
    take(key, now = Date.now()) {
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return false;
      }
      arr.push(now);
      hits.set(key, arr);
      return true;
    },
    reset() { hits.clear(); },
  };
}

export function limitMiddleware(limiter, message) {
  return (req, res, next) => {
    if (!limiter.take(req.ip || 'unknown')) {
      return res.status(429).json({ error: message || '操作过于频繁，请稍后再试' });
    }
    next();
  };
}
