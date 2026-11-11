// 从包装上的 OCR 文本里提取：生产日期 / 到期日期 / 保质期时长。
// 纯函数，无 DOM 依赖，前端与单测共用。
//
// 设计原则：宁可不填，也不要填错。OCR 对数字很容易出错（实测出现过 "2027103/01"、"202703ol"），
// 所以解析结果只用于"预填表单让用户核对"，并且：
//   - 只接受能通过日历校验的日期（2000–2099 年，月日真实存在）
//   - 只做最保守的字符纠错（O→0、l/I→1 仅在紧邻数字时）
//   - 每个字段标注来源：keyword（有关键词锚定）/ position（仅凭位置猜测，需特别提示核对）

const PROD_KW = /(生产日期|生产日|制造日期|制造日|出厂日期|MFG\.?(?:\s*DATE)?|MANUFACTURED?|PRODUCTION\s*DATE|PROD\.?(?:\s*DATE)?|PRD|DOM)/i;
const EXP_KW = /(有效期至|有效期到|有效期限?至?|有效至|保质期至|到期日期?|失效日期|截止日期|使用期限至?|EXP\.?(?:IRY)?(?:\s*DATE)?|EXPIRES?|BEST\s*BEFORE|USE\s*BY|BB|BBD)/i;
const SHELF_KW = /(保质期|保存期|有效期|使用期限|SHELF\s*LIFE)/i;
const PAO_KW = /(开封后|开启后|开盖后|PAO|OPEN(?:ED)?\s*AFTER)/i;

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysIn(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }

export function validYMD(y, m, d) {
  return Number.isInteger(y) && y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// 规范化：全角→半角；汉字之间的空格折叠；O/o、l/I 仅在紧邻数字时纠正；统一分隔符
export function normalize(text) {
  let s = String(text || '').normalize('NFKC');
  s = s.replace(/[\r\n]+/g, '\n');
  // tesseract 中文识别会在每个汉字之间插入空格：折叠"汉字 汉字"之间的空白
  s = s.replace(/([\u4e00-\u9fff：:])[ \t]+(?=[\u4e00-\u9fff：:])/g, '$1');
  s = s.replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1');
  // 数字串里的易混字符：先找"以数字开头、由 数字/O/o/l/I/| 组成、至少含 4 个数字"的连续片段，整体纠正。
  // 要求首字符是数字，避免把英文单词（LOT、BEST、Oil）里的字母改掉。
  s = s.replace(/\d[\dOolI|]*(?:[./\-][\dOolI|]+)*/g, (seg) => {
    if ((seg.match(/\d/g) || []).length < 4) return seg;
    return seg.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
  });
  return s;
}

// 从一小段文本里取第一个合法日期。返回 { date, raw } 或 null
export function extractDate(seg) {
  const s = String(seg || '');
  const pats = [
    // 2026年03月01日 / 2026年3月1日 / 2026年3月（无日 → 取 1 日，由调用方标注 partial）
    { re: /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/, f: (m) => [+m[1], +m[2], +m[3]] },
    // 2026-03-01 / 2026.03.01 / 2026/03/01 / 2026 03 01
    { re: /(20\d{2})\s*[-./ ]\s*(\d{1,2})\s*[-./ ]\s*(\d{1,2})(?!\d)/, f: (m) => [+m[1], +m[2], +m[3]] },
    // 20260301（8 位连写）
    { re: /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/, f: (m) => [+m[1], +m[2], +m[3]] },
    // 26.03.01 / 26/03/01（2 位年；只在以点或斜杠分隔时接受，避免误吞其他数字串）
    { re: /(?<!\d)(\d{2})[./](\d{1,2})[./](\d{1,2})(?!\d)/, f: (m) => [2000 + +m[1], +m[2], +m[3]] },
  ];
  for (const { re, f } of pats) {
    const m = re.exec(s);
    if (!m) continue;
    const [y, mo, d] = f(m);
    if (validYMD(y, mo, d)) return { date: iso(y, mo, d), raw: m[0].trim(), index: m.index };
  }
  // 年月（无日）：2027年3月 / 2027.03 / 2027/03 —— 食品常见"有效期至 2027.03"
  const ym = /(20\d{2})\s*(?:年|[-./])\s*(\d{1,2})\s*月?(?![\d./-])/.exec(s);
  if (ym && validYMD(+ym[1], +ym[2], 1)) {
    const y = +ym[1];
    const mo = +ym[2];
    return { date: iso(y, mo, daysIn(y, mo)), raw: ym[0].trim(), index: ym.index, partial: true };
  }
  return null;
}

// 解析保质期时长："18个月" "36M" "2年" "730天" "24 months"
export function extractShelfLife(seg) {
  const s = String(seg || '');
  const m = /(\d{1,4})\s*(个月|月|M(?:ONTHS?)?|年|Y(?:EARS?)?|天|日|D(?:AYS?)?)(?![a-z])/i.exec(s);
  if (!m) return null;
  const v = +m[1];
  const u = m[2].toUpperCase();
  let unit;
  if (u === '个月' || u === '月' || u.startsWith('M')) unit = 'month';
  else if (u === '年' || u.startsWith('Y')) unit = 'year';
  else unit = 'day';
  // 合理范围按单位区分：月 ≤120、年 ≤10、天 ≤3650
  const max = { month: 120, year: 10, day: 3650 }[unit];
  if (!(v >= 1 && v <= max)) return null;
  return { value: v, unit, raw: m[0] };
}

// 把文本切成行，并把"关键词 + 紧随其后的 40 个字符"作为该关键词的取值窗口
function windows(text, kw) {
  const out = [];
  const re = new RegExp(kw.source, `${kw.flags.replace('g', '')}g`);
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const lineEnd = text.indexOf('\n', start);
    const end = Math.min(start + 40, lineEnd === -1 ? text.length : lineEnd);
    out.push({ kw: m[0], at: m.index, seg: text.slice(start, end) });
  }
  return out;
}

export function parsePackaging(rawText) {
  const text = normalize(rawText);
  const res = {
    production_date: null, expiry_date: null, shelf_life: null,
    // sources：keyword（有标签）/ position（按位置推测）；raws：识别到的原始文字，界面用来让用户对照照片核对
    sources: {}, raws: {}, notes: [], text,
  };

  // 1) 生产日期：关键词锚定
  for (const w of windows(text, PROD_KW)) {
    const d = extractDate(w.seg);
    if (d) { res.production_date = d.date; res.sources.production_date = 'keyword'; res.raws.production_date = d.raw; break; }
  }

  // 2) 到期日期：关键词锚定（"有效期至"优先于"有效期"）
  for (const w of windows(text, EXP_KW)) {
    const d = extractDate(w.seg);
    if (d) {
      res.expiry_date = d.date; res.sources.expiry_date = 'keyword'; res.raws.expiry_date = d.raw;
      if (d.partial) res.notes.push('到期日只识别到年月，已按当月最后一天填写，请核对');
      break;
    }
  }

  // 3) 保质期时长：关键词锚定，且不能是"开封后"那一段
  const paoAt = windows(text, PAO_KW).map((w) => w.at);
  for (const w of windows(text, SHELF_KW)) {
    // 排除 "有效期至 2027..." 这类被 SHELF_KW 误命中的到期日关键词
    if (/^\s*(?:至|到)/.test(w.seg)) continue;
    // 排除紧邻在"开封后"之后的时长（那是 PAO，不是保质期）
    if (paoAt.some((p) => w.at > p && w.at - p < 8)) continue;
    const sl = extractShelfLife(w.seg);
    if (sl) { res.shelf_life = { value: sl.value, unit: sl.unit }; res.sources.shelf_life = 'keyword'; res.raws.shelf_life = sl.raw; break; }
  }
  // 有些包装只写 "36M" "18个月"，没有"保质期"字样：只在文本里恰好出现一个时长且不属于 PAO 时采用
  if (!res.shelf_life) {
    const all = [...text.matchAll(/(\d{1,3})\s*(个月|M(?:ONTHS?)?|年|Y(?:EARS?)?)(?![a-z])/gi)]
      .filter((m) => !paoAt.some((p) => m.index > p && m.index - p < 8));
    if (all.length === 1) {
      const sl = extractShelfLife(all[0][0]);
      if (sl) { res.shelf_life = { value: sl.value, unit: sl.unit }; res.sources.shelf_life = 'position'; res.raws.shelf_life = sl.raw; }
    }
  }

  // 4) 兜底：没有关键词时，文本里恰好有 1 个合法日期 → 视为生产日期；恰好 2 个 → 较早者生产、较晚者到期
  if (!res.production_date && !res.expiry_date) {
    const found = [];
    const rawOf = new Map();
    for (const line of text.split('\n')) {
      let rest = line;
      for (let i = 0; i < 4; i += 1) {
        const d = extractDate(rest);
        if (!d) break;
        if (!d.partial && !rawOf.has(d.date)) { rawOf.set(d.date, d.raw); found.push(d.date); }
        rest = rest.slice(d.index + d.raw.length);
      }
    }
    if (found.length === 1) {
      res.production_date = found[0]; res.sources.production_date = 'position'; res.raws.production_date = rawOf.get(found[0]);
    } else if (found.length === 2) {
      const [a, b] = [...found].sort();
      res.production_date = a; res.sources.production_date = 'position'; res.raws.production_date = rawOf.get(a);
      res.expiry_date = b; res.sources.expiry_date = 'position'; res.raws.expiry_date = rawOf.get(b);
    } else if (found.length > 2) {
      res.notes.push('识别到多个日期，无法判断哪个是生产日期，请手动填写');
    }
  }

  // 5) 一致性：生产日期不能晚于到期日期，否则两个都不采信
  if (res.production_date && res.expiry_date && res.production_date > res.expiry_date) {
    res.notes.push('识别到的生产日期晚于到期日期，数字很可能识别错了，请手动填写');
    res.production_date = null; res.expiry_date = null;
    delete res.sources.production_date; delete res.sources.expiry_date;
    delete res.raws.production_date; delete res.raws.expiry_date;
  }
  // 6) 同时有到期日和保质期时长：以到期日为准（保质期时长由前端不再预填，避免互相矛盾）
  if (res.expiry_date && res.shelf_life) {
    res.notes.push('同时识别到到期日和保质期时长，已优先采用到期日');
    res.shelf_life = null; delete res.sources.shelf_life; delete res.raws.shelf_life;
  }
  return res;
}
