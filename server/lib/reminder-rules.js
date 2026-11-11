import { addDays, addMonths, diffDays, isValidDate, parseDate } from './dates.js';

// 提醒点：剩余时间占总保质期的比例（需求文档 3.3）
export const RATIOS = {
  food: [0.5, 0.25, 0.1, 0.03],
  skincare: [0.35, 0.15, 0.05],
};

export const CATEGORIES = Object.keys(RATIOS);
export const CATEGORY_LABEL = { food: '食品', skincare: '护肤品' };
export const REPEAT_EVERY_DAYS = 3;

export const KIND_TEXT = {
  notice: '开始留意，规划使用',
  priority: '该优先使用了',
  soon: '马上过期，尽快用掉',
  today: '今天到期，请不要再使用',
  expired: '已过期，请丢弃，避免误用',
};

export const KIND_LABEL = {
  normal: '正常',
  notice: '留意',
  priority: '优先使用',
  soon: '临期',
  today: '今天到期',
  expired: '已过期',
};

// 距到期天数的提醒点（降序，不含到期当天）
export function reminderOffsets(category, totalDays) {
  const ratios = RATIOS[category] || RATIOS.food;
  if (!(totalDays > 0)) return [];
  const set = new Set();
  for (const r of ratios) {
    const o = Math.max(1, Math.ceil(totalDays * r));
    if (o <= totalDays) set.add(o);
  }
  return [...set].sort((a, b) => b - a);
}

// 到期日 = 直接填写的到期日；否则 = 生产日期 + 保质期
export function computeExpiry({ production_date, shelf_life_value, shelf_life_unit, expiry_date }) {
  if (expiry_date) return expiry_date;
  const v = Number(shelf_life_value);
  if (production_date && v > 0) {
    if (shelf_life_unit === 'day') return addDays(production_date, v);
    if (shelf_life_unit === 'month') return addMonths(production_date, v);
    if (shelf_life_unit === 'year') return addMonths(production_date, v * 12);
  }
  return null;
}

// 当前所处阶段：已越过的提醒点个数（含到期当天这一档）
export function stageOf(item, today) {
  if (!item.expiry_date) return { stage: 0, remaining: null, points: 0 };
  const total = diffDays(item.expiry_date, item.base_date);
  const offsets = reminderOffsets(item.category, total);
  const remaining = diffDays(item.expiry_date, today);
  const thresholds = [...offsets, 0];
  const stage = thresholds.filter((t) => remaining <= t).length;
  return { stage, remaining, points: offsets.length };
}

export function kindOf(stage, points, remaining) {
  if (stage === 0) return 'normal';
  if (stage > points) return remaining < 0 ? 'expired' : 'today';
  if (stage === points) return 'soon';
  return stage === 1 ? 'notice' : 'priority';
}

// 给 App 内列表用的状态
export function itemState(item, today) {
  if (!item.expiry_date) return { key: 'unset', label: '未设置到期日', remaining: null, stage: 0 };
  const { stage, remaining, points } = stageOf(item, today);
  const key = kindOf(stage, points, remaining);
  return { key, label: KIND_LABEL[key], remaining, stage };
}

// 今天是否应产生一条提醒事件；返回 null 表示无需提醒
export function dueReminder(item, today) {
  if (item.status !== 'active' || !item.expiry_date) return null;
  const { stage, remaining, points } = stageOf(item, today);
  if (stage === 0) return null;
  const last = item.last_stage || 0;
  if (stage > last) {
    return { stage, remaining, kind: kindOf(stage, points, remaining) };
  }
  if (remaining < 0 && stage === last && item.last_reminded_on
    && diffDays(today, item.last_reminded_on) >= REPEAT_EVERY_DAYS) {
    return { stage, remaining, kind: 'expired' };
  }
  return null;
}

export function reminderLine(kind, remaining) {
  if (kind === 'expired') return `已过期 ${Math.abs(remaining)} 天，请丢弃，避免误用`;
  if (kind === 'today') return KIND_TEXT.today;
  return `还剩 ${remaining} 天，${KIND_TEXT[kind]}`;
}

// 校验并规整一个物品的输入；返回 { error } 或 { value }
export function normalizeItemInput(body, today) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: '请填写物品名称' };
  if (name.length > 50) return { error: '名称最长 50 字' };
  if (!CATEGORIES.includes(body.category)) return { error: '请选择分类' };
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 200) return { error: '备注最长 200 字' };

  const production_date = body.production_date || null;
  const expiry_in = body.expiry_date || null;
  if (production_date && !isValidDate(production_date)) return { error: '生产日期格式不正确' };
  if (expiry_in && !isValidDate(expiry_in)) return { error: '到期日期格式不正确' };

  let shelf_life_value = null;
  let shelf_life_unit = null;
  if (body.shelf_life_value !== undefined && body.shelf_life_value !== null && body.shelf_life_value !== '') {
    const v = Number(body.shelf_life_value);
    if (!Number.isInteger(v) || v <= 0 || v > 999) return { error: '保质期必须是 1-999 的整数' };
    if (!['day', 'month', 'year'].includes(body.shelf_life_unit)) return { error: '请选择保质期单位' };
    shelf_life_value = v;
    shelf_life_unit = body.shelf_life_unit;
  }

  const expiry_date = computeExpiry({ production_date, shelf_life_value, shelf_life_unit, expiry_date: expiry_in });
  if (expiry_date && !isValidDate(expiry_date)) return { error: '到期日期超出范围' };
  if (expiry_date && production_date && parseDate(expiry_date) < parseDate(production_date)) {
    return { error: '到期日期不能早于生产日期' };
  }
  if (expiry_date && Number(expiry_date.slice(0, 4)) > 2200) return { error: '到期日期超出范围' };

  // 到期日由直接填写得到时，不保留与之矛盾的保质期时长
  if (expiry_in) { shelf_life_value = null; shelf_life_unit = null; }

  return {
    value: {
      name, category: body.category, note,
      production_date, shelf_life_value, shelf_life_unit, expiry_date,
      base_date: production_date || today,
    },
  };
}
