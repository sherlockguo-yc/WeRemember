import express from 'express';
import { join } from 'path';
import { makeAuth } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { groupRoutes } from './routes/groups.js';
import { itemRoutes } from './routes/items.js';
import { manualRoutes } from './routes/manuals.js';
import { createLimiter } from './lib/ratelimit.js';

// ctx = { db, dataDir, jwtSecret, env, senders, now, publicDir }
export function createApp(ctx) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const auth = makeAuth(ctx);
  const joinLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
  const testLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 5 });

  const authRouter = authRoutes(ctx);
  app.use('/api/auth', authRouter);

  app.use('/api/groups/join', (req, res, next) => {
    if (req.method === 'POST' && !joinLimiter.take(req.ip)) {
      return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
    }
    next();
  });
  app.use('/api/me/test-channel', (req, res, next) => {
    if (req.method === 'POST' && !testLimiter.take(`u${req.headers.authorization || req.ip}`)) {
      return res.status(429).json({ error: '测试过于频繁，请 10 分钟后再试' });
    }
    next();
  });

  app.use('/api/groups', auth, groupRoutes(ctx));
  app.use('/api/items', auth, itemRoutes(ctx));
  app.use('/api/manuals', auth, manualRoutes(ctx));
  app.use('/api', auth, accountRoutes(ctx));

  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

  if (ctx.publicDir) {
    app.use(express.static(ctx.publicDir, {
      setHeaders(res, file) {
        if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-store');
        else res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));
    app.get('*', (req, res) => res.sendFile(join(ctx.publicDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: '文件超过 20MB 限制' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求格式不正确' });
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  app.authRouter = authRouter;
  return app;
}
