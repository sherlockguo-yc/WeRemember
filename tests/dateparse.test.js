import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePackaging, extractDate, extractShelfLife, normalize, validYMD } from '../src/dateparse.js';

// 下面 REAL_* 是 tesseract.js 7.0.0 + chi_sim/eng(best_int) 对合成包装图的真实输出（2026-11-11 实测），
// 不是手写的理想文本：包含汉字间空格、数字识别错误等真实噪声。

const REAL_A = '生产 日 期 : 2026 年 03 月 01 日\n保质 期 : 18 个 月\n批号 L20260301';
const REAL_B = 'MFG 2026.03.01\nEXP 2028.09.01';
const REAL_C_BEST = '20260301\n有 效 期 至 2027103/01';
const REAL_C_FULL = '20260301\n有 效 期 至 202703ol';
const REAL_D = '生产 日 期 2026-03-01\n保质 期 36M 开封 后 12M';
const REAL_E = '生产 日 期 :2026.03.01 保质 期 :24 个 月';

test('真实 OCR 输出 A：中文标签 + 年月日 + 保质期', () => {
  const r = parsePackaging(REAL_A);
  assert.equal(r.production_date, '2026-03-01');
  assert.deepEqual(r.shelf_life, { value: 18, unit: 'month' });
  assert.equal(r.expiry_date, null);
  assert.equal(r.sources.production_date, 'keyword');
});

test('真实 OCR 输出 B：MFG / EXP 点号日期', () => {
  const r = parsePackaging(REAL_B);
  assert.equal(r.production_date, '2026-03-01');
  assert.equal(r.expiry_date, '2028-09-01');
  assert.equal(r.shelf_life, null);
});

test('真实 OCR 输出 C：数字被识别坏时不能填错日期', () => {
  // "2027103/01" 不是合法日期，必须不采信到期日，而不是瞎猜成某个日期
  const best = parsePackaging(REAL_C_BEST);
  assert.equal(best.expiry_date, null);
  // 但 8 位连写的 20260301 是合法日期，按位置兜底为生产日期
  assert.equal(best.production_date, '2026-03-01');
  assert.equal(best.sources.production_date, 'position');
  // 完整版识别成 "202703ol"：o/l 紧邻数字时纠正为 0/1 → 20270301，合法 → 允许采信
  const full = parsePackaging(REAL_C_FULL);
  assert.equal(full.expiry_date, '2027-03-01');
});

test('真实 OCR 输出 D：开封后 12M 不能被当成保质期', () => {
  const r = parsePackaging(REAL_D);
  assert.equal(r.production_date, '2026-03-01');
  assert.deepEqual(r.shelf_life, { value: 36, unit: 'month' });
});

test('真实 OCR 输出 E：紧凑格式', () => {
  const r = parsePackaging(REAL_E);
  assert.equal(r.production_date, '2026-03-01');
  assert.deepEqual(r.shelf_life, { value: 24, unit: 'month' });
});

test('日期格式覆盖', () => {
  const d = (s) => extractDate(s)?.date;
  assert.equal(d('2026年3月1日'), '2026-03-01');
  assert.equal(d('2026年03月01日'), '2026-03-01');
  assert.equal(d('2026-03-01'), '2026-03-01');
  assert.equal(d('2026.03.01'), '2026-03-01');
  assert.equal(d('2026/3/1'), '2026-03-01');
  assert.equal(d('20260301'), '2026-03-01');
  assert.equal(d('26.03.01'), '2026-03-01');
  assert.equal(d('26/03/01'), '2026-03-01');
});

test('只有年月：取当月最后一天并标注 partial', () => {
  const a = extractDate('2027年3月');
  assert.equal(a.date, '2027-03-31');
  assert.equal(a.partial, true);
  assert.equal(extractDate('2027.02').date, '2027-02-28');
  assert.equal(extractDate('2028.02').date, '2028-02-29');
  const r = parsePackaging('有效期至 2027年3月');
  assert.equal(r.expiry_date, '2027-03-31');
  assert.ok(r.notes.some((n) => /年月/.test(n)));
});

test('日历校验：不存在的日期一律拒绝', () => {
  assert.equal(extractDate('2026.02.30'), null);
  assert.equal(extractDate('2026.13.01'), null);
  assert.equal(extractDate('2026.00.10'), null);
  assert.equal(extractDate('2026.04.31'), null);
  assert.equal(extractDate('1999.01.01'), null);
  assert.equal(validYMD(2024, 2, 29), true);
  assert.equal(validYMD(2025, 2, 29), false);
});

test('保质期时长：单位与范围', () => {
  assert.deepEqual(extractShelfLife('18个月'), { value: 18, unit: 'month', raw: '18个月' });
  assert.equal(extractShelfLife('36M').unit, 'month');
  assert.equal(extractShelfLife('3年').unit, 'year');
  assert.equal(extractShelfLife('24 months').unit, 'month');
  assert.equal(extractShelfLife('730天').unit, 'day');
  assert.equal(extractShelfLife('0个月'), null);
  assert.equal(extractShelfLife('999个月'), null);
  assert.equal(extractShelfLife('批号 L20260301'), null);
});

test('全角与空格噪声：规范化后仍能解析', () => {
  assert.match(normalize('生 产 日 期'), /生产日期/);
  assert.equal(parsePackaging('生产日期：２０２６．０３．０１').production_date, '2026-03-01');
});

test('O/l 仅在紧邻数字时纠正，不误伤英文单词', () => {
  assert.match(normalize('2O26.O3.Ol'), /2026\.03\.01/);
  assert.match(normalize('BEST BEFORE'), /BEST BEFORE/);
  assert.match(normalize('LOT'), /LOT/);
});

test('没有关键词：1 个日期 → 生产日期；2 个 → 较早生产、较晚到期；3 个及以上 → 不猜', () => {
  const one = parsePackaging('2026.03.01');
  assert.equal(one.production_date, '2026-03-01');
  assert.equal(one.sources.production_date, 'position');
  const two = parsePackaging('2028.09.01\n2026.03.01');
  assert.equal(two.production_date, '2026-03-01');
  assert.equal(two.expiry_date, '2028-09-01');
  const three = parsePackaging('2026.03.01 2026.04.01 2028.09.01');
  assert.equal(three.production_date, null);
  assert.equal(three.expiry_date, null);
  assert.ok(three.notes.some((n) => /多个日期/.test(n)));
});

test('一致性：生产日期晚于到期日期时两者都不采信', () => {
  const r = parsePackaging('生产日期 2028.09.01\n有效期至 2026.03.01');
  assert.equal(r.production_date, null);
  assert.equal(r.expiry_date, null);
  assert.ok(r.notes.some((n) => /晚于/.test(n)));
});

test('同时有到期日和保质期：优先到期日，不预填保质期', () => {
  const r = parsePackaging('生产日期 2026-03-01\n保质期 24个月\n有效期至 2028-02-29');
  assert.equal(r.expiry_date, '2028-02-29');
  assert.equal(r.shelf_life, null);
  assert.ok(r.notes.some((n) => /优先采用到期日/.test(n)));
});

test('"有效期至 …" 不会被当成"有效期 = 保质期时长"', () => {
  const r = parsePackaging('有效期至 2027-03-01');
  assert.equal(r.expiry_date, '2027-03-01');
  assert.equal(r.shelf_life, null);
});

test('无关文本：什么都不填', () => {
  const r = parsePackaging('净含量 50g\n请置于阴凉干燥处\n批号 AB12345');
  assert.equal(r.production_date, null);
  assert.equal(r.expiry_date, null);
  assert.equal(r.shelf_life, null);
});

test('空输入与异常输入不抛错', () => {
  for (const x of ['', null, undefined, '   ', '\n\n', 12345]) {
    const r = parsePackaging(x);
    assert.equal(r.production_date, null);
  }
});

test('单独时长（无"保质期"字样）：只出现一个且非 PAO 才采用，并标注 position', () => {
  const one = parsePackaging('36M');
  assert.deepEqual(one.shelf_life, { value: 36, unit: 'month' });
  assert.equal(one.sources.shelf_life, 'position');
  const withPao = parsePackaging('开封后 12M');
  assert.equal(withPao.shelf_life, null);
  const two = parsePackaging('24个月 36个月');
  assert.equal(two.shelf_life, null);
});

test('raws：保留识别到的原始文字，供界面让用户对照核对', () => {
  const r = parsePackaging(REAL_A);
  assert.equal(r.raws.production_date, '2026 年 03 月 01 日');
  assert.equal(r.raws.shelf_life, '18 个月');
  const b = parsePackaging(REAL_B);
  assert.equal(b.raws.production_date, '2026.03.01');
  assert.equal(b.raws.expiry_date, '2028.09.01');
  // 位置兜底也要带原文
  assert.equal(parsePackaging('2026.03.01').raws.production_date, '2026.03.01');
  // 被丢弃的字段不能残留原文
  const dropped = parsePackaging('生产日期 2028.09.01\n有效期至 2026.03.01');
  assert.deepEqual(dropped.raws, {});
  const both = parsePackaging('生产日期 2026-03-01\n保质期 24个月\n有效期至 2028-02-29');
  assert.equal(both.raws.shelf_life, undefined);
});

// 已知限制（2026-11-11 实测）：tesseract 把原图 "2025年11月08日" 读成 "2025 年 1 月 08 日"。
// "2025-01-08" 是合法日期，解析层无法也不应该猜测它错了，所以这里断言的是"忠实解析"，
// 防线在界面：预填后复述原文「2025 年 1 月 08 日」并要求用户对照照片核对。
test('已知限制：引擎把 11 月读成 1 月时，解析结果是合法日期，但原文可见以便核对', () => {
  const r = parsePackaging('生产 日 期 : 2025 年 1 月 08 日\n保质 期 : 12 个 月');
  assert.equal(r.production_date, '2025-01-08');
  assert.equal(r.raws.production_date, '2025 年 1 月 08 日');
  assert.deepEqual(r.shelf_life, { value: 12, unit: 'month' });
});
