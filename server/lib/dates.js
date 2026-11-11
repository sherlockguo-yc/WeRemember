// 所有日期按北京时间（UTC+8）的 YYYY-MM-DD 处理，与服务器时区无关。
const DAY = 86400000;
const BJ_OFFSET = 8 * 3600 * 1000;

export function bjNow(ms = Date.now()) {
  return new Date(ms + BJ_OFFSET);
}

export function todayBJ(ms = Date.now()) {
  return bjNow(ms).toISOString().slice(0, 10);
}

export function hourBJ(ms = Date.now()) {
  return bjNow(ms).getUTCHours();
}

export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

export function isValidDate(s) {
  return parseDate(s) !== null;
}

function fmt(t) {
  return new Date(t).toISOString().slice(0, 10);
}

// a - b，单位：天
export function diffDays(a, b) {
  return Math.round((parseDate(a) - parseDate(b)) / DAY);
}

export function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY);
}

// 月末截断：1 月 31 日 + 1 个月 = 2 月末
export function addMonths(s, n) {
  const t = new Date(parseDate(s));
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + n;
  const d = t.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmt(Date.UTC(y, m, Math.min(d, lastDay)));
}
