import { IC } from './icons.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let toastTimer;
export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, isError ? 3800 : 2200);
}

// 弹窗：基类 .modal-mask 统一控制层级；确认弹窗用 .confirm 变体，层级高于普通弹窗
function ensureMask(id, extraClass = '') {
  let mask = document.getElementById(id);
  if (!mask) {
    mask = document.createElement('div');
    mask.id = id;
    mask.className = `modal-mask ${extraClass}`;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeMask(mask); });
    document.body.appendChild(mask);
  }
  return mask;
}
function closeMask(mask) {
  mask.classList.remove('show');
  mask.innerHTML = '';
  if (mask._onClose) { const f = mask._onClose; mask._onClose = null; f(); }
}

export function showModal(html, { onClose } = {}) {
  const mask = ensureMask('modal');
  mask.innerHTML = `<div class="modal-box">${html}</div>`;
  mask._onClose = onClose || null;
  mask.classList.add('show');
  return mask;
}
export function hideModal() {
  const mask = document.getElementById('modal');
  if (mask) closeMask(mask);
}

export function confirmDialog({ title, message, okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const mask = ensureMask('confirm-modal', 'confirm');
    mask.innerHTML = `
      <div class="modal-box">
        <div class="modal-head"><h3>${esc(title)}</h3></div>
        <p>${esc(message)}</p>
        <div class="btn-row">
          <button class="btn" data-r="0">取消</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okText)}</button>
        </div>
      </div>`;
    mask._onClose = () => resolve(false);
    mask.classList.add('show');
    mask.querySelectorAll('button[data-r]').forEach((b) => b.addEventListener('click', () => {
      const ok = b.dataset.r === '1';
      mask._onClose = null;
      closeMask(mask);
      resolve(ok);
    }));
  });
}

export const modalHead = (title) => `
  <div class="modal-head">
    <h3>${esc(title)}</h3>
    <button class="icon-btn" data-close aria-label="关闭">${IC.x(20)}</button>
  </div>`;

export function bindClose(root = document.getElementById('modal')) {
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', hideModal));
}

export function emptyState(icon, title, sub = '') {
  return `<div class="empty-state"><div class="es-icon">${icon}</div><p>${esc(title)}</p>${sub ? `<p class="hint">${esc(sub)}</p>` : ''}</div>`;
}

// 防重复提交：执行期间禁用按钮
export async function withBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function fmtTs(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
export const UNIT_LABEL = { day: '天', month: '个月', year: '年' };

// 与 server/lib/dates.js 的 addMonths 同口径（月末截断），仅用于表单预览
export function previewExpiry(prod, value, unit) {
  const v = Number(value);
  if (!prod || !(v > 0)) return null;
  const [y, m, d] = prod.split('-').map(Number);
  if (!y || !m || !d) return null;
  if (unit === 'day') return new Date(Date.UTC(y, m - 1, d + v)).toISOString().slice(0, 10);
  const months = unit === 'year' ? v * 12 : v;
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}
