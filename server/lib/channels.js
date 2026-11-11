import nodemailer from 'nodemailer';

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidSendKey(k) { return KEY_RE.test(k); }
export function isValidEmail(e) { return e.length <= 100 && EMAIL_RE.test(e); }

function trimTitle(title) {
  return title.replace(/[\r\n]+/g, ' ').slice(0, 32);
}

// Server酱 Turbo：POST https://sctapi.ftqq.com/<SendKey>.send
// 错误的 Key 返回 HTTP 400 + {"code":40001,...}（2026-11-11 实测）；成功以 code === 0 为准（官方 FAQ）。
export async function sendServerChan(key, title, markdown, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!isValidSendKey(key)) return { ok: false, error: 'SendKey 格式不正确' };
  try {
    const res = await fetchImpl(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: trimTitle(title), desp: markdown }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
    if (json && json.code === 0) return { ok: true };
    const msg = (json && (json.info || json.message)) || `HTTP ${res.status}`;
    return { ok: false, error: `Server酱返回：${msg}` };
  } catch (e) {
    return { ok: false, error: `Server酱请求失败：${e.name === 'TimeoutError' ? '超时' : e.message}` };
  }
}

export function mailConfigured(env = process.env) {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

let cachedTransport = null;
function getTransport(env) {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.qq.com',
      port: Number(env.SMTP_PORT || 465),
      secure: true,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return cachedTransport;
}

export async function sendMail(to, subject, text, { env = process.env, transport } = {}) {
  if (!mailConfigured(env)) return { ok: false, error: '服务器未配置发件邮箱' };
  if (!isValidEmail(to)) return { ok: false, error: '收件邮箱格式不正确' };
  try {
    await (transport || getTransport(env)).sendMail({
      from: `"WeRemember" <${env.SMTP_USER}>`,
      to,
      subject,
      text,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `邮件发送失败：${e.message}` };
  }
}

export function mailSenderAddress(env = process.env) {
  return env.SMTP_USER || '';
}
