import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reminderOffsets, computeExpiry, stageOf, dueReminder, itemState, normalizeItemInput,
} from '../server/lib/reminder-rules.js';
import { addMonths, addDays, diffDays, todayBJ, hourBJ } from '../server/lib/dates.js';

test('需求文档示例：食品 1 年 = 365 天', () => {
  assert.deepEqual(reminderOffsets('food', 365), [183, 92, 37, 11]);
});

test('需求文档示例：护肤品 3 年 = 1095 天', () => {
  assert.deepEqual(reminderOffsets('skincare', 1095), [384, 165, 55]);
});

test('需求文档示例：食品 3 个月 = 90 天', () => {
  assert.deepEqual(reminderOffsets('food', 90), [45, 23, 9, 3]);
});

test('极短保质期：去重且至少提前 1 天', () => {
  assert.deepEqual(reminderOffsets('food', 3), [2, 1]);
  assert.deepEqual(reminderOffsets('food', 1), [1]);
  assert.deepEqual(reminderOffsets('food', 0), []);
});

test('到期日：直接填写优先；否则生产日期 + 保质期', () => {
  assert.equal(computeExpiry({ expiry_date: '2027-05-01', production_date: '2026-01-01', shelf_life_value: 1, shelf_life_unit: 'year' }), '2027-05-01');
  assert.equal(computeExpiry({ production_date: '2026-01-31', shelf_life_value: 1, shelf_life_unit: 'month' }), '2026-02-28');
  assert.equal(computeExpiry({ production_date: '2026-03-01', shelf_life_value: 1, shelf_life_unit: 'year' }), '2027-03-01');
  assert.equal(computeExpiry({ production_date: '2026-03-01', shelf_life_value: 10, shelf_life_unit: 'day' }), '2026-03-11');
  assert.equal(computeExpiry({ shelf_life_value: 1, shelf_life_unit: 'year' }), null);
  assert.equal(computeExpiry({}), null);
});

test('月份运算：闰年与跨年', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(diffDays('2027-01-01', '2026-12-31'), 1);
});

test('北京时间：UTC 16:30 已是次日', () => {
  const ms = Date.UTC(2026, 10, 10, 16, 30);
  assert.equal(todayBJ(ms), '2026-11-11');
  assert.equal(hourBJ(ms), 0);
});

const food = (over = {}) => ({
  status: 'active', category: 'food', base_date: '2026-01-01', expiry_date: '2027-01-01',
  last_stage: 0, last_reminded_on: null, ...over,
});

test('阶段随日期推进：只前进', () => {
  const item = food(); // 总 365 天，提醒点 183/92/37/11
  const at = (remaining) => stageOf(item, addDays('2027-01-01', -remaining)).stage;
  assert.equal(at(300), 0);
  assert.equal(at(183), 1);
  assert.equal(at(92), 2);
  assert.equal(at(37), 3);
  assert.equal(at(11), 4);
  assert.equal(at(0), 5);
  assert.equal(at(-5), 5);
});

test('语义：首个=留意，中间=优先，最后=临期，当天，过期后', () => {
  const item = food();
  const kind = (remaining) => itemState(item, addDays('2027-01-01', -remaining)).key;
  assert.equal(kind(200), 'normal');
  assert.equal(kind(183), 'notice');
  assert.equal(kind(92), 'priority');
  assert.equal(kind(37), 'priority');
  assert.equal(kind(11), 'soon');
  assert.equal(kind(0), 'today');
  assert.equal(kind(-1), 'expired');
});

test('补录不轰炸：越过多个提醒点时只产出当前阶段一条', () => {
  const item = food({ last_stage: 0 });
  const today = addDays('2027-01-01', -20); // 已越过 3 个提醒点
  const d = dueReminder(item, today);
  assert.equal(d.stage, 3);
  assert.equal(d.kind, 'priority');
});

test('已发过的阶段不重复提醒；进入新阶段才再提醒', () => {
  const item = food({ last_stage: 3, last_reminded_on: '2026-12-12' });
  assert.equal(dueReminder(item, '2026-12-13'), null);
  assert.equal(dueReminder(item, '2026-12-21').stage, 4);
});

test('过期后每 3 天提醒一次', () => {
  const item = food({ last_stage: 5, last_reminded_on: '2027-01-01' });
  assert.equal(dueReminder(item, '2027-01-02'), null);
  assert.equal(dueReminder(item, '2027-01-03'), null);
  assert.equal(dueReminder(item, '2027-01-04').kind, 'expired');
});

test('已处理或无到期日不提醒', () => {
  assert.equal(dueReminder(food({ status: 'used' }), '2027-02-01'), null);
  assert.equal(dueReminder(food({ expiry_date: null }), '2027-02-01'), null);
});

test('录入时已过期：允许保存，下次直接进入过期阶段', () => {
  const item = food({ expiry_date: '2026-06-01' });
  const d = dueReminder(item, '2026-06-10');
  assert.equal(d.kind, 'expired');
});

test('只有到期日、无生产日期：基准取录入日', () => {
  const r = normalizeItemInput({ name: '牛奶', category: 'food', expiry_date: '2027-01-01' }, '2026-11-11');
  assert.equal(r.value.base_date, '2026-11-11');
  assert.equal(r.value.expiry_date, '2027-01-01');
});

test('录入校验', () => {
  const t = '2026-11-11';
  const bad = (b) => normalizeItemInput({ name: 'x', category: 'food', ...b }, t).error;
  assert.ok(normalizeItemInput({ name: '', category: 'food' }, t).error);
  assert.ok(bad({ category: 'toy' }));
  assert.ok(bad({ production_date: '2026-13-01' }));
  assert.ok(bad({ production_date: '2026-02-30' }));
  assert.ok(bad({ shelf_life_value: 0, shelf_life_unit: 'day' }));
  assert.ok(bad({ shelf_life_value: -3, shelf_life_unit: 'day' }));
  assert.ok(bad({ shelf_life_value: 1.5, shelf_life_unit: 'day' }));
  assert.ok(bad({ shelf_life_value: 1 }));
  assert.ok(bad({ production_date: '2026-05-01', expiry_date: '2026-04-01' }));
  assert.ok(bad({ name: 'a'.repeat(51) }));
  assert.ok(bad({ note: 'a'.repeat(201) }));
  // 两个日期都没有：允许
  assert.equal(normalizeItemInput({ name: 'x', category: 'skincare' }, t).value.expiry_date, null);
});
