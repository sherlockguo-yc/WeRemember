import { runDispatch } from './dispatch.js';

// 每分钟检查一次：到了用户设定的发送时刻就发当天汇总；服务停机后恢复时自动补发当天未发的。
export function startScheduler(ctx, { intervalMs = 60000, log = console } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const report = await runDispatch(ctx.db, ctx.senders, ctx.now());
      for (const r of report) {
        log.log(`[dispatch] ${r.user} ${r.channel} ${r.ok ? 'ok' : `failed: ${r.error}`}`);
      }
    } catch (e) {
      log.error('[dispatch] tick error', e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 5000).unref();
  return { stop: () => clearInterval(timer), tick };
}
