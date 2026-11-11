import fs from 'fs';
import { join } from 'path';
import * as webpush from 'web-push';

// 订阅里的 endpoint 是客户端提交的 URL，服务端会向它发 POST。
// 不加限制就是 SSRF（让服务器去请求内网地址），所以只放行已知推送服务的域名。
// FCM（Chrome / Android）单独识别：N150 在大陆，到 fcm.googleapis.com 不通（2026-11-11 实测超时），
// 放行只会得到"订阅成功但永远收不到"，所以明确拒绝并说明原因。
const ALLOWED_HOSTS = [
  { test: (h) => h === 'web.push.apple.com', name: 'Apple' },
  { test: (h) => h === 'updates.push.services.mozilla.com', name: 'Mozilla' },
  { test: (h) => h.endsWith('.notify.windows.com'), name: 'Microsoft' },
];

export function checkEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return { ok: false, error: '推送地址格式不正确' }; }
  if (u.protocol !== 'https:' || u.port) return { ok: false, error: '推送地址格式不正确' };
  const host = u.hostname.toLowerCase();
  if (host === 'fcm.googleapis.com' || host.endsWith('.googleapis.com')) {
    return { ok: false, error: '当前浏览器使用 Google 推送服务，服务器无法连接，请改用 iPhone（添加到主屏幕）、Firefox 或 Edge' };
  }
  if (!ALLOWED_HOSTS.some((a) => a.test(host))) return { ok: false, error: '不支持的推送服务' };
  return { ok: true };
}

const B64URL = /^[A-Za-z0-9_-]+$/;
export function checkSubscription(sub) {
  if (!sub || typeof sub !== 'object') return { ok: false, error: '订阅信息缺失' };
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return { ok: false, error: '推送地址格式不正确' };
  const ep = checkEndpoint(endpoint);
  if (!ep.ok) return ep;
  const p256dh = keys && keys.p256dh;
  const auth = keys && keys.auth;
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh) || p256dh.length > 200
    || typeof auth !== 'string' || !B64URL.test(auth) || auth.length > 100) {
    return { ok: false, error: '订阅密钥格式不正确' };
  }
  return { ok: true };
}

// VAPID 密钥对：首次启动生成，存在 DATA_DIR（受部署同步保护）。
// 丢失后所有已有订阅都会失效，所以只在文件不存在时才生成，绝不覆盖。
export function loadVapid(dataDir, env = process.env) {
  const f = join(dataDir, '.vapid.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let keys;
  if (fs.existsSync(f)) {
    keys = JSON.parse(fs.readFileSync(f, 'utf8'));
  } else {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(f, JSON.stringify(keys), { mode: 0o600 });
  }
  const subject = env.VAPID_SUBJECT
    || (env.SMTP_USER ? `mailto:${env.SMTP_USER}` : 'https://weremember.sherlockguo.com');
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
}

// 向单个订阅发送。返回 { ok, gone?, error? }；gone 表示订阅已失效（404/410），调用方应删除。
export async function sendWebPush(vapid, sub, payload, { lib = webpush, timeoutMs = 10000 } = {}) {
  try {
    await lib.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 12 * 3600,
        urgency: 'normal',
        timeout: timeoutMs,
      },
    );
    return { ok: true };
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      return { ok: false, gone: true, error: '订阅已失效' };
    }
    const code = e && e.statusCode ? `HTTP ${e.statusCode}` : (e && e.message) || '未知错误';
    return { ok: false, error: `推送失败：${code}` };
  }
}

export function pushPayload(title, body) {
  return { title: String(title).slice(0, 60), body: String(body).slice(0, 300), url: '/' };
}
