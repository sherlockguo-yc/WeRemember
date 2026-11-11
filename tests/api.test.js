import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDB } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ensureBootstrapInvite } from '../server/routes/auth.js';
import { runDispatch } from '../server/lib/dispatch.js';
import { sendServerChan, sendMail } from '../server/lib/channels.js';
import { addDays, todayBJ } from '../server/lib/dates.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]);

async function setup(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-'));
  const db = openDB(':memory:');
  let nowMs = Date.UTC(2026, 10, 11, 1, 0); // 北京时间 2026-11-11 09:00
  const sent = { serverchan: [], email: [], push: [] };
  const ctx = {
    db, dataDir, jwtSecret: 'test-secret', env: { ADMIN_INVITE_CODE: 'BOOT123', SMTP_USER: 'bot@qq.com', SMTP_PASS: 'x', ...over.env },
    vapid: { publicKey: 'test-public-key', privateKey: 'test-private-key', subject: 'mailto:bot@qq.com' },
    now: () => nowMs,
    senders: {
      serverchan: async (key, title, md) => { sent.serverchan.push({ key, title, md }); return over.scFail ? { ok: false, error: 'boom' } : { ok: true }; },
      email: async (to, title, text) => { sent.email.push({ to, title, text }); return { ok: true }; },
      push: async (sub, payload) => {
        sent.push.push({ endpoint: sub.endpoint, payload });
        return over.pushResult ? over.pushResult(sub) : { ok: true };
      },
    },
  };
  ensureBootstrapInvite(db, ctx.env);
  const app = createApp(ctx);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { token, json, raw, headers } = {}) => {
    const h = { ...(headers || {}) };
    if (token) h.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (raw) { h['Content-Type'] = 'application/octet-stream'; body = raw; }
    const res = await fetch(base + url, { method, headers: h, body });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  const register = async (username, code) => {
    const r = await call('POST', '/api/auth/register', { json: { username, password: 'secret1', invite_code: code } });
    return r;
  };
  const close = () => { server.closeAllConnections(); server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { ctx, db, call, register, close, sent, setNow: (v) => { nowMs = v; }, getNow: () => nowMs };
}

async function twoUsers(s) {
  const a = (await s.register('alice', 'BOOT123')).body;
  const inv = await s.call('POST', '/api/admin/invites', { token: a.token });
  const b = (await s.register('bob', inv.body.code)).body;
  return { a, b };
}

test('首个管理员用环境变量邀请码注册，之后该码作废', async () => {
  const s = await setup();
  const r = await s.register('alice', 'BOOT123');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.is_admin, 1);
  const again = await s.register('bob', 'BOOT123');
  assert.equal(again.status, 400);
  assert.match(again.body.error, /已被使用/);
  s.close();
});

test('已有管理员后，环境变量邀请码不再被重新播种', async () => {
  const s = await setup();
  await s.register('alice', 'BOOT123');
  s.db.prepare('DELETE FROM invites').run();
  ensureBootstrapInvite(s.db, s.ctx.env);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM invites').get().c, 0);
  s.close();
});

test('注册邀请码：一次性、7 天过期、不存在', async () => {
  const s = await setup();
  const a = (await s.register('alice', 'BOOT123')).body;
  const inv = await s.call('POST', '/api/admin/invites', { token: a.token });
  assert.equal(inv.status, 201);
  assert.equal((await s.register('bob', inv.body.code)).status, 200);
  assert.equal((await s.register('carol', inv.body.code)).body.error, '邀请码已被使用');
  assert.equal((await s.register('dave', 'NOPE')).body.error, '邀请码不存在');

  const inv2 = await s.call('POST', '/api/admin/invites', { token: a.token });
  s.setNow(s.getNow() + 8 * 24 * 3600 * 1000);
  assert.equal((await s.register('erin', inv2.body.code)).body.error, '邀请码已过期');
  s.close();
});

test('非管理员不能生成注册邀请码；注册自动创建个人空间', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  assert.equal((await s.call('POST', '/api/admin/invites', { token: b.token })).status, 403);
  const g = await s.call('GET', '/api/groups', { token: b.token });
  assert.equal(g.body.groups.length, 1);
  assert.equal(g.body.groups[0].is_personal, true);
  assert.ok(a.token);
  s.close();
});

test('登录与注册接口按 IP 限流', async () => {
  const s = await setup();
  let last;
  for (let i = 0; i < 21; i++) last = await s.call('POST', '/api/auth/login', { json: { username: 'x', password: 'y' } });
  assert.equal(last.status, 429);
  s.close();
});

test('未登录访问受保护接口返回 401', async () => {
  const s = await setup();
  assert.equal((await s.call('GET', '/api/items')).status, 401);
  assert.equal((await s.call('GET', '/api/manuals/1/file')).status, 401);
  s.close();
});

test('家庭组共享：B 加入后看到 A 的物品，B 处理后 A 的待处理区同步消失', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  const grp = (await s.call('POST', '/api/groups', { token: a.token, json: { name: '我家' } })).body.group;
  assert.ok(grp.invite_code);

  const item = (await s.call('POST', '/api/items', {
    token: a.token, json: { group_id: grp.id, name: '牛奶', category: 'food', expiry_date: '2027-03-01' },
  })).body.item;

  assert.equal((await s.call('GET', '/api/items', { token: b.token })).body.items.length, 0);
  assert.equal((await s.call('POST', '/api/groups/join', { token: b.token, json: { code: grp.invite_code } })).status, 200);
  assert.equal((await s.call('GET', '/api/items', { token: b.token })).body.items.length, 1);

  assert.equal((await s.call('POST', `/api/items/${item.id}/handle`, { token: b.token, json: { kind: 'discarded' } })).status, 200);
  // 幂等
  assert.equal((await s.call('POST', `/api/items/${item.id}/handle`, { token: b.token, json: { kind: 'used' } })).status, 200);
  assert.equal((await s.call('GET', '/api/items', { token: a.token })).body.items.length, 0);
  const hist = (await s.call('GET', '/api/items?scope=history', { token: a.token })).body.items;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].processed_kind, 'discarded');

  await s.call('POST', `/api/items/${item.id}/restore`, { token: a.token });
  assert.equal((await s.call('GET', '/api/items', { token: a.token })).body.items.length, 1);
  s.close();
});

test('权限隔离：非成员看不到、改不了、也不能往别人的组里加', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  const grp = (await s.call('POST', '/api/groups', { token: a.token, json: { name: '我家' } })).body.group;
  const item = (await s.call('POST', '/api/items', { token: a.token, json: { group_id: grp.id, name: '牛奶', category: 'food' } })).body.item;

  assert.equal((await s.call('PUT', `/api/items/${item.id}`, { token: b.token, json: { name: 'x', category: 'food' } })).status, 404);
  assert.equal((await s.call('POST', `/api/items/${item.id}/handle`, { token: b.token, json: { kind: 'used' } })).status, 404);
  assert.equal((await s.call('DELETE', `/api/items/${item.id}`, { token: b.token })).status, 404);
  assert.equal((await s.call('POST', '/api/items', { token: b.token, json: { group_id: grp.id, name: 'x', category: 'food' } })).status, 403);
  assert.equal((await s.call('GET', `/api/items?group_id=${grp.id}`, { token: b.token })).status, 403);
  assert.equal((await s.call('GET', `/api/groups/${grp.id}`, { token: b.token })).status, 403);
  s.close();
});

test('个人空间不能被加入、改名；退出家庭组后看不到该组数据', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  const personal = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0];
  assert.equal(personal.invite_code, null);
  assert.equal((await s.call('PUT', `/api/groups/${personal.id}`, { token: a.token, json: { name: 'x' } })).status, 400);
  assert.equal((await s.call('POST', `/api/groups/${personal.id}/leave`, { token: a.token })).status, 400);

  const grp = (await s.call('POST', '/api/groups', { token: a.token, json: { name: '我家' } })).body.group;
  await s.call('POST', '/api/groups/join', { token: b.token, json: { code: grp.invite_code } });
  await s.call('POST', '/api/items', { token: a.token, json: { group_id: grp.id, name: '牛奶', category: 'food' } });
  await s.call('POST', `/api/groups/${grp.id}/leave`, { token: b.token });
  assert.equal((await s.call('GET', '/api/items', { token: b.token })).body.items.length, 0);
  // 组长退出时移交，数据仍保留给 B 以外的成员（此处只剩 A）
  assert.equal((await s.call('GET', '/api/items', { token: a.token })).body.items.length, 1);
  s.close();
});

test('物品列表：按到期日升序，无到期日置底；状态标签', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const mk = (j) => s.call('POST', '/api/items', { token: a.token, json: { group_id: gid, category: 'food', ...j } });
  await mk({ name: '无日期' });
  await mk({ name: '远', expiry_date: '2028-01-01' });
  await mk({ name: '已过期', expiry_date: '2026-10-01' });
  const items = (await s.call('GET', '/api/items', { token: a.token })).body.items;
  assert.deepEqual(items.map((i) => i.name), ['已过期', '远', '无日期']);
  assert.equal(items[0].state.key, 'expired');
  assert.equal(items[2].state.key, 'unset');
  s.close();
});

test('编辑到期日后按新日期重新判定，不补发已越过的阶段', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  s.db.prepare("UPDATE users SET notify_serverchan = 1, serverchan_key = 'KEY12345678' WHERE username = 'alice'").run();
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const today = todayBJ(s.getNow());
  const item = (await s.call('POST', '/api/items', {
    token: a.token, json: { group_id: gid, name: '酸奶', category: 'food', production_date: addDays(today, -300), expiry_date: addDays(today, 365) },
  })).body.item;
  // 改成 5 天后到期：基准（生产日期）不变，直接进入后几个阶段，但这次编辑本身不应补发之前的
  await s.call('PUT', `/api/items/${item.id}`, { token: a.token, json: { group_id: gid, name: '酸奶', category: 'food', production_date: addDays(today, -300), expiry_date: addDays(today, 5) } });
  const state = s.db.prepare('SELECT last_stage FROM reminder_state WHERE item_id = ?').get(item.id);
  assert.ok(state.last_stage >= 4);
  const rep = await runDispatch(s.db, s.ctx.senders, s.getNow());
  assert.equal(rep.length, 0);
  s.close();
});

test('汇总发送：每渠道每天一条，含物品名、组名、剩余天数', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  const grp = (await s.call('POST', '/api/groups', { token: a.token, json: { name: '我家' } })).body.group;
  await s.call('POST', '/api/groups/join', { token: b.token, json: { code: grp.invite_code } });
  s.db.prepare("UPDATE users SET notify_serverchan = 1, serverchan_key = 'KEY12345678', notify_email = 1, email = 'a@qq.com' WHERE username = 'alice'").run();

  const today = todayBJ(s.getNow());
  for (const [name, exp] of [['牛奶', addDays(today, 2)], ['酸奶', addDays(today, -4)], ['火腿', addDays(today, 400)]]) {
    await s.call('POST', '/api/items', { token: b.token, json: { group_id: grp.id, name, category: 'food', production_date: addDays(today, -200), expiry_date: exp } });
  }

  const rep = await runDispatch(s.db, s.ctx.senders, s.getNow());
  assert.equal(rep.length, 2);
  assert.equal(s.sent.serverchan.length, 1);
  assert.equal(s.sent.email.length, 1);
  const md = s.sent.serverchan[0].md;
  assert.match(md, /牛奶（我家）\*\*：还剩 2 天/);
  assert.match(md, /酸奶（我家）\*\*：已过期 4 天/);
  assert.doesNotMatch(md, /火腿/);

  // 同一天再次调度：不再发送
  await runDispatch(s.db, s.ctx.senders, s.getNow() + 3600 * 1000);
  assert.equal(s.sent.serverchan.length, 1);
  assert.equal(s.sent.email.length, 1);
  s.close();
});

test('发送时刻未到不发；服务恢复后补发当天汇总', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  s.db.prepare("UPDATE users SET notify_serverchan = 1, serverchan_key = 'KEY12345678', notify_hour = 9 WHERE username = 'alice'").run();
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const today = todayBJ(s.getNow());
  await s.call('POST', '/api/items', { token: a.token, json: { group_id: gid, name: '牛奶', category: 'food', expiry_date: addDays(today, -1) } });

  const before = Date.UTC(2026, 10, 11, 0, 30); // 北京 08:30
  assert.equal((await runDispatch(s.db, s.ctx.senders, before)).length, 0);
  const late = Date.UTC(2026, 10, 11, 8, 0); // 北京 16:00，错过 9:00 后恢复
  assert.equal((await runDispatch(s.db, s.ctx.senders, late)).length, 1);
  s.close();
});

test('一个渠道失败不影响其他渠道；失败有间隔与次数上限，不重发已成功的', async () => {
  const s = await setup({ scFail: true });
  const { a } = await twoUsers(s);
  s.db.prepare("UPDATE users SET notify_serverchan = 1, serverchan_key = 'KEY12345678', notify_email = 1, email = 'a@qq.com' WHERE username = 'alice'").run();
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const today = todayBJ(s.getNow());
  await s.call('POST', '/api/items', { token: a.token, json: { group_id: gid, name: '牛奶', category: 'food', expiry_date: addDays(today, -1) } });

  const t0 = s.getNow();
  const r1 = await runDispatch(s.db, s.ctx.senders, t0);
  assert.deepEqual(r1.map((r) => [r.channel, r.ok]).sort(), [['email', true], ['serverchan', false]]);

  assert.equal((await runDispatch(s.db, s.ctx.senders, t0 + 5 * 60000)).length, 0); // 间隔内不重试
  assert.equal((await runDispatch(s.db, s.ctx.senders, t0 + 31 * 60000)).length, 1); // 只重试失败的
  assert.equal(s.sent.email.length, 1);
  await runDispatch(s.db, s.ctx.senders, t0 + 62 * 60000);
  assert.equal((await runDispatch(s.db, s.ctx.senders, t0 + 93 * 60000)).length, 0); // 3 次上限
  assert.equal(s.sent.serverchan.length, 3);

  const logs = (await s.call('GET', '/api/me/dispatch-log', { token: a.token })).body.logs;
  assert.equal(logs.find((l) => l.channel === 'serverchan').status, 'failed');
  s.close();
});

test('没有配置任何渠道：不发送，也不影响列表', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const today = todayBJ(s.getNow());
  await s.call('POST', '/api/items', { token: a.token, json: { group_id: gid, name: '牛奶', category: 'food', expiry_date: addDays(today, -1) } });
  assert.equal((await runDispatch(s.db, s.ctx.senders, s.getNow())).length, 0);
  const items = (await s.call('GET', '/api/items', { token: a.token })).body.items;
  assert.equal(items[0].state.key, 'expired');
  s.close();
});

test('个人设置：邮箱/SendKey 校验、脱敏回显、开启前必须已填写', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  const put = (j) => s.call('PUT', '/api/me', { token: a.token, json: j });
  assert.equal((await put({ email: 'bad' })).status, 400);
  assert.equal((await put({ serverchan_key: 'a b' })).status, 400);
  assert.equal((await put({ notify_email: true })).status, 400);
  assert.equal((await put({ notify_serverchan: true })).status, 400);
  assert.equal((await put({ notify_hour: 24 })).status, 400);

  const ok = await put({ email: 'a@qq.com', serverchan_key: 'SCT123456789abc', notify_email: true, notify_serverchan: true, notify_hour: 20 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.serverchan_key, 'SCT1****9abc');
  // 回传脱敏值视为未修改
  await put({ serverchan_key: ok.body.user.serverchan_key });
  assert.equal(s.db.prepare("SELECT serverchan_key k FROM users WHERE username='alice'").get().k, 'SCT123456789abc');
  s.close();
});

test('服务器未配置发件邮箱：不能开启邮件提醒，也不能发测试邮件；Server酱不受影响', async () => {
  const s = await setup({ env: { SMTP_USER: '', SMTP_PASS: '' } });
  const { a } = await twoUsers(s);
  const put = (j) => s.call('PUT', '/api/me', { token: a.token, json: j });
  assert.equal((await put({ email: 'a@qq.com' })).status, 200);
  const r = await put({ notify_email: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /发件邮箱/);
  assert.equal((await s.call('POST', '/api/me/test-channel', { token: a.token, json: { channel: 'email' } })).status, 400);
  assert.equal((await put({ serverchan_key: 'SCT123456789abc', notify_serverchan: true })).status, 200);
  assert.equal((await s.call('GET', '/api/me', { token: a.token })).body.user.mail_available, false);
  s.close();
});

test('测试消息：调用对应渠道，失败返回具体原因', async () => {
  const s = await setup({ scFail: true });
  const { a } = await twoUsers(s);
  assert.equal((await s.call('POST', '/api/me/test-channel', { token: a.token, json: { channel: 'serverchan' } })).status, 400);
  await s.call('PUT', '/api/me', { token: a.token, json: { email: 'a@qq.com', serverchan_key: 'SCT123456789abc' } });
  const sc = await s.call('POST', '/api/me/test-channel', { token: a.token, json: { channel: 'serverchan' } });
  assert.equal(sc.status, 502);
  assert.equal(sc.body.error, 'boom');
  assert.equal((await s.call('POST', '/api/me/test-channel', { token: a.token, json: { channel: 'email' } })).status, 200);
  s.close();
});

test('说明书：上传 PDF 与图片、关键词搜索、预览、权限、超限', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const up = (name, buf, extra = '') => s.call('POST', `/api/manuals?group_id=${gid}&name=${encodeURIComponent(name)}${extra}`, { token: a.token, raw: buf });

  const pdf = await up('戴森吹风机', PDF, '&category=' + encodeURIComponent('小家电') + '&file_name=manual.pdf');
  assert.equal(pdf.status, 201);
  assert.equal(pdf.body.manual.mime, 'application/pdf');
  const png = await up('路由器', PNG);
  assert.equal(png.status, 201);

  assert.equal((await s.call('GET', '/api/manuals?q=' + encodeURIComponent('戴森'), { token: a.token })).body.manuals.length, 1);
  assert.equal((await s.call('GET', '/api/manuals?q=' + encodeURIComponent('小家电'), { token: a.token })).body.manuals.length, 1);
  assert.equal((await s.call('GET', '/api/manuals?q=%25', { token: a.token })).body.manuals.length, 0); // 通配符被转义
  assert.equal((await s.call('GET', '/api/manuals', { token: a.token })).body.manuals.length, 2);

  const file = await s.call('GET', `/api/manuals/${pdf.body.manual.id}/file`, { token: a.token });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(file.body, PDF);

  assert.equal((await s.call('GET', `/api/manuals/${pdf.body.manual.id}/file`, { token: b.token })).status, 404);
  assert.equal((await s.call('GET', `/api/manuals/${pdf.body.manual.id}/file`)).status, 401);

  assert.equal((await up('', PDF)).status, 400);
  assert.equal((await up('伪装', Buffer.from('<script>alert(1)</script>'))).status, 400);
  assert.equal((await up('空', Buffer.alloc(0))).status, 400);

  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(21 * 1024 * 1024)]);
  const tooBig = await up('大文件', big);
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.body.error, /20MB/);

  assert.equal((await s.call('DELETE', `/api/manuals/${pdf.body.manual.id}`, { token: a.token })).status, 200);
  assert.equal((await s.call('GET', `/api/manuals/${pdf.body.manual.id}/file`, { token: a.token })).status, 404);
  s.close();
});

test('包装照片：只收图片，权限校验，可删除', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const item = (await s.call('POST', '/api/items', { token: a.token, json: { group_id: gid, name: '面霜', category: 'skincare' } })).body.item;
  assert.equal((await s.call('POST', `/api/items/${item.id}/photo`, { token: a.token, raw: PDF })).status, 400);
  assert.equal((await s.call('POST', `/api/items/${item.id}/photo`, { token: a.token, raw: PNG })).status, 200);
  assert.equal((await s.call('GET', `/api/items/${item.id}/photo`, { token: a.token })).headers.get('content-type'), 'image/png');
  assert.equal((await s.call('GET', `/api/items/${item.id}/photo`, { token: b.token })).status, 404);
  assert.equal((await s.call('DELETE', `/api/items/${item.id}/photo`, { token: a.token })).status, 200);
  assert.equal((await s.call('GET', `/api/items/${item.id}/photo`, { token: a.token })).status, 404);
  s.close();
});

test('Server酱：成功/业务失败/网络异常/非法 Key', async () => {
  const mk = (res) => async () => ({ status: res.status, json: async () => res.json });
  assert.deepEqual(await sendServerChan('KEY12345678', 't', 'd', { fetchImpl: mk({ status: 200, json: { code: 0, message: '' } }) }), { ok: true });
  const bad = await sendServerChan('KEY12345678', 't', 'd', { fetchImpl: mk({ status: 400, json: { code: 40001, info: '错误的Key' } }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /错误的Key/);
  const net = await sendServerChan('KEY12345678', 't', 'd', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.match(net.error, /ECONNRESET/);
  assert.equal((await sendServerChan('../x', 't', 'd')).ok, false);

  let captured;
  await sendServerChan('KEY12345678', '标题\n换行', '正文', {
    fetchImpl: async (url, init) => { captured = { url, init }; return { status: 200, json: async () => ({ code: 0 }) }; },
  });
  assert.equal(captured.url, 'https://sctapi.ftqq.com/KEY12345678.send');
  assert.ok(!new URLSearchParams(captured.init.body).get('title').includes('\n'));
});

test('邮件：未配置发件箱/收件地址非法/发送异常', async () => {
  assert.match((await sendMail('a@qq.com', 's', 't', { env: {} })).error, /未配置/);
  assert.match((await sendMail('bad', 's', 't', { env: { SMTP_USER: 'x@qq.com', SMTP_PASS: 'p' } })).error, /格式/);
  const sent = [];
  const ok = await sendMail('a@qq.com', 's', 't', { env: { SMTP_USER: 'x@qq.com', SMTP_PASS: 'p' }, transport: { sendMail: async (m) => { sent.push(m); } } });
  assert.equal(ok.ok, true);
  assert.equal(sent[0].to, 'a@qq.com');
  const fail = await sendMail('a@qq.com', 's', 't', { env: { SMTP_USER: 'x@qq.com', SMTP_PASS: 'p' }, transport: { sendMail: async () => { throw new Error('auth failed'); } } });
  assert.match(fail.error, /auth failed/);
});

// ========== Web Push ==========

test('Web Push：订阅格式校验', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  const r1 = await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: null } });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /缺失/);
  const r2 = await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: { endpoint: 'not-https', keys: { p256dh: 'abc', auth: 'def' } } } });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /格式/);
  const r3 = await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: { endpoint: 'https://fcm.googleapis.com/v1/foo', keys: { p256dh: 'abc', auth: 'def' } } } });
  assert.equal(r3.status, 400);
  assert.match(r3.body.error, /Google/);
  s.close();
});

test('Web Push：订阅 → 查询状态 → 测试推送 → 取消订阅', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  const sub = { endpoint: 'https://updates.push.services.mozilla.com/123', keys: { p256dh: 'abc123', auth: 'def456' } };
  // 订阅前：状态返回 subscribed=false
  const status1 = await s.call('POST', '/api/push/status', { token: a.token, json: { endpoint: sub.endpoint } });
  assert.equal(status1.body.subscribed, false);
  // 订阅
  const r1 = await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: sub } });
  assert.equal(r1.status, 200);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 1);
  // 订阅后：状态返回 subscribed=true
  const status2 = await s.call('POST', '/api/push/status', { token: a.token, json: { endpoint: sub.endpoint } });
  assert.equal(status2.body.subscribed, true);
  // 测试推送
  const testRes = await s.call('POST', '/api/me/test-channel', { token: a.token, json: { channel: 'push' } });
  assert.equal(testRes.status, 200);
  assert.equal(s.sent.push.length, 1);
  assert.equal(s.sent.push[0].endpoint, sub.endpoint);
  assert.match(s.sent.push[0].payload.body, /已配置成功/);
  // 取消订阅
  const r2 = await s.call('POST', '/api/push/unsubscribe', { token: a.token, json: { endpoint: sub.endpoint } });
  assert.equal(r2.status, 200);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 0);
  s.close();
});

test('Web Push：同一 endpoint 换账号后，推送归属转给当前账号', async () => {
  const s = await setup();
  const { a, b } = await twoUsers(s);
  const endpoint = 'https://web.push.apple.com/xyz';
  const sub = { endpoint, keys: { p256dh: 'abc', auth: 'def' } };
  await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: sub } });
  let owner = s.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  assert.equal(owner.user_id, a.user.id);
  // B 用户同一台设备订阅，endpoint 转归 B
  await s.call('POST', '/api/push/subscribe', { token: b.token, json: { subscription: sub } });
  owner = s.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  assert.equal(owner.user_id, b.user.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 1);
  s.close();
});

test('Web Push：汇总推送、失效订阅自动清理、至少一台成功即算成功', async () => {
  const s = await setup({
    pushResult: (sub) => (sub.endpoint.includes('GONE') ? { ok: false, gone: true, error: '已失效' } : { ok: true }),
  });
  const { a } = await twoUsers(s);
  const gid = (await s.call('GET', '/api/groups', { token: a.token })).body.groups[0].id;
  const today = todayBJ(s.getNow());
  await s.call('POST', '/api/items', { token: a.token, json: { group_id: gid, name: '牛奶', category: 'food', expiry_date: addDays(today, -1) } });
  // 登记两台设备：一台已失效、一台正常
  const sub1 = { endpoint: 'https://web.push.apple.com/GONE', keys: { p256dh: 'abc1', auth: 'def1' } };
  const sub2 = { endpoint: 'https://web.push.apple.com/OK', keys: { p256dh: 'abc2', auth: 'def2' } };
  await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: sub1 } });
  await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: sub2 } });
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 2);
  // runDispatch 成功发送，失效订阅被清理
  const rep = await runDispatch(s.db, s.ctx.senders, s.getNow());
  assert.equal(rep.length, 1);
  assert.equal(rep[0].ok, true);
  assert.equal(s.sent.push.length, 2);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c, 1);
  assert.equal(s.db.prepare('SELECT endpoint FROM push_subscriptions').get().endpoint, sub2.endpoint);
  s.close();
});

test('Web Push：超过 10 台设备拒绝新订阅', async () => {
  const s = await setup();
  const { a } = await twoUsers(s);
  for (let i = 0; i < 10; i += 1) {
    await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: { endpoint: `https://web.push.apple.com/${i}`, keys: { p256dh: 'abc', auth: 'def' } } } });
  }
  const r = await s.call('POST', '/api/push/subscribe', { token: a.token, json: { subscription: { endpoint: 'https://web.push.apple.com/11', keys: { p256dh: 'abc', auth: 'def' } } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /最多.*10.*设备/);
  s.close();
});
