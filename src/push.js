import { api } from './api.js';

// 浏览器端 Web Push 封装。设置页只和这里交互。
// 状态：unsupported（浏览器不支持）/ need-install（iOS 未添加到主屏幕）/ denied（用户拒绝）/ off / on / unavailable（服务端未启用）

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}

export async function pushState() {
  // iOS 只有"添加到主屏幕"后的 PWA 才有 PushManager
  if (isIOS() && !isStandalone()) return { state: 'need-install' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { state: 'unsupported' };
  }
  let cfg;
  try { cfg = await api.get('/api/push/config'); } catch { return { state: 'unavailable' }; }
  if (!cfg.available) return { state: 'unavailable' };
  if (Notification.permission === 'denied') return { state: 'denied', cfg };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { state: 'off', cfg };
  // 本机有订阅但服务端没有（例如被清理），按"未开启"处理
  const { subscribed } = await api.post('/api/push/status', { endpoint: sub.endpoint });
  return { state: subscribed ? 'on' : 'off', cfg };
}

export async function enablePush() {
  const { cfg } = await pushState();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('未获得通知权限，请在系统设置里允许 WeRemember 发送通知');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.public_key),
    });
  }
  try {
    await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  } catch (e) {
    // 服务端拒绝（如不支持的推送服务）时撤销本地订阅，避免留下"本机已订阅、服务端没有"的状态
    await sub.unsubscribe().catch(() => {});
    throw e;
  }
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
