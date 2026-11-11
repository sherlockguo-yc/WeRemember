import { todayBJ, hourBJ } from './dates.js';
import { dueReminder, reminderLine, CATEGORY_LABEL } from './reminder-rules.js';
import { pushPayload } from './webpush.js';

const MAX_ATTEMPTS = 3;
const RETRY_GAP_MS = 30 * 60 * 1000;

export function enabledChannels(user, hasPush = false) {
  const ch = [];
  if (user.notify_serverchan && user.serverchan_key) ch.push('serverchan');
  if (user.notify_email && user.email) ch.push('email');
  if (hasPush) ch.push('push');
  return ch;
}

// 向该用户所有设备推送。至少一台成功即算成功；404/410 的失效订阅顺手清理。
// senders.push(sub, payload) -> { ok, gone?, error? }
export async function sendPushToUser(db, senders, userId, title, body) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!subs.length) return { ok: false, error: '没有已开启推送的设备' };
  const payload = pushPayload(title, body);
  const del = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');
  let okCount = 0;
  let lastError = '';
  for (const sub of subs) {
    const r = await senders.push(sub, payload);
    if (r.ok) okCount += 1;
    else {
      lastError = r.error || lastError;
      if (r.gone) del.run(sub.id);
    }
  }
  return okCount ? { ok: true } : { ok: false, error: lastError || '推送失败' };
}

// 用户所属各组中、仍在进行的物品，附带该用户的提醒进度
function activeItemsFor(db, userId) {
  return db.prepare(`
    SELECT i.*, g.name AS group_name, g.is_personal,
           COALESCE(rs.last_stage, 0) AS last_stage, rs.last_reminded_on AS last_reminded_on
    FROM items i
    JOIN family_groups g ON g.id = i.group_id
    JOIN group_members gm ON gm.group_id = i.group_id AND gm.user_id = ?
    LEFT JOIN reminder_state rs ON rs.item_id = i.id AND rs.user_id = ?
    WHERE i.status = 'active' AND i.expiry_date IS NOT NULL
    ORDER BY i.expiry_date ASC, i.id ASC
  `).all(userId, userId);
}

// 生成今天的汇总并推进该用户的提醒进度。同一用户同一天只生成一次（第一次非空时落库）。
export function composeDigest(db, user, today) {
  const existing = db.prepare('SELECT payload FROM digests WHERE user_id = ? AND date = ?').get(user.id, today);
  if (existing) return JSON.parse(existing.payload);

  const lines = [];
  const upsert = db.prepare(`
    INSERT INTO reminder_state (user_id, item_id, last_stage, last_reminded_on) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET last_stage = excluded.last_stage, last_reminded_on = excluded.last_reminded_on
  `);
  const tx = db.transaction(() => {
    for (const item of activeItemsFor(db, user.id)) {
      const due = dueReminder(item, today);
      if (!due) continue;
      lines.push({
        item_id: item.id,
        name: item.name,
        category: CATEGORY_LABEL[item.category] || item.category,
        group_name: item.is_personal ? '' : item.group_name,
        kind: due.kind,
        remaining: due.remaining,
        text: reminderLine(due.kind, due.remaining),
      });
      upsert.run(user.id, item.id, due.stage, today);
    }
    if (lines.length) {
      db.prepare('INSERT INTO digests (user_id, date, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(user.id, today, JSON.stringify(lines), Date.now());
    }
  });
  tx();
  return lines;
}

const KIND_ORDER = { expired: 0, today: 1, soon: 2, priority: 3, notice: 4 };

export function formatDigest(lines) {
  const sorted = [...lines].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  const expired = sorted.filter((l) => l.kind === 'expired' || l.kind === 'today').length;
  const title = expired
    ? `WeRemember：${expired} 件已过期或今日到期`
    : `WeRemember：${sorted.length} 件物品需要留意`;
  const label = (l) => `${l.name}${l.group_name ? `（${l.group_name}）` : ''}`;
  const markdown = sorted.map((l) => `- **${label(l)}**：${l.text}`).join('\n\n');
  const text = sorted.map((l) => `· ${label(l)}：${l.text}`).join('\n');
  return { title, markdown, text };
}

export function isPaused(db, userId, today, channel, now) {
  const row = db.prepare('SELECT * FROM dispatch_log WHERE user_id = ? AND date = ? AND channel = ?').get(userId, today, channel);
  if (!row) return false;
  if (row.status === 'ok') return true;
  if (row.attempts >= MAX_ATTEMPTS) return true;
  return now - row.last_attempt_at < RETRY_GAP_MS;
}

function recordAttempt(db, userId, today, channel, result, count, now) {
  db.prepare(`
    INSERT INTO dispatch_log (user_id, date, channel, status, attempts, item_count, error, last_attempt_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, date, channel) DO UPDATE SET
      status = excluded.status, attempts = attempts + 1, item_count = excluded.item_count,
      error = excluded.error, last_attempt_at = excluded.last_attempt_at
  `).run(userId, today, channel, result.ok ? 'ok' : 'failed', count, result.ok ? '' : result.error, now);
}

// 一次调度：对每个开启了渠道、且已到发送时刻的用户发送当天汇总。
// senders = { serverchan(key, title, markdown), email(to, title, text), push(sub, payload) }，便于测试注入。
export async function runDispatch(db, senders, now = Date.now()) {
  const today = todayBJ(now);
  const hour = hourBJ(now);
  const users = db.prepare('SELECT * FROM users').all();
  const pushUsers = new Set(db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all().map((r) => r.user_id));
  const report = [];
  for (const user of users) {
    const channels = enabledChannels(user, pushUsers.has(user.id));
    if (!channels.length || hour < user.notify_hour) continue;
    const pending = channels.filter((c) => !isPaused(db, user.id, today, c, now));
    if (!pending.length) continue;

    const lines = composeDigest(db, user, today);
    if (!lines.length) continue;
    const msg = formatDigest(lines);

    for (const channel of pending) {
      let result;
      if (channel === 'serverchan') result = await senders.serverchan(user.serverchan_key, msg.title, msg.markdown);
      else if (channel === 'email') result = await senders.email(user.email, msg.title, msg.text);
      else result = await sendPushToUser(db, senders, user.id, msg.title, msg.text);
      recordAttempt(db, user.id, today, channel, result, lines.length, now);
      report.push({ user: user.username, channel, ok: result.ok, error: result.error });
    }
  }
  return report;
}
