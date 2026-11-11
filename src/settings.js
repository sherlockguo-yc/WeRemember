import { api } from './api.js';
import { state, loadGroups } from './state.js';
import {
  esc, toast, showModal, hideModal, confirmDialog, modalHead, bindClose, withBusy, fmtTs,
} from './ui.js';
import { IC } from './icons.js';
import { pushState, enablePush, disablePush } from './push.js';

let profile = null;
let afterGroupsChange = () => {};
let logout = () => {};
export function bindSettings({ onGroupsChange, onLogout }) {
  afterGroupsChange = onGroupsChange;
  logout = onLogout;
}

const toggle = (id, on) => `
  <label class="toggle-switch" aria-label="开关">
    <input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="toggle-track"></span>
  </label>`;

const hourOptions = (cur) => Array.from({ length: 24 }, (_, h) =>
  `<option value="${h}" ${h === cur ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请手动选择复制', true); }
}

export async function renderSettings() {
  const view = document.getElementById('view-settings');
  view.innerHTML = '<div class="loading">加载中…</div>';
  let logs = [];
  try {
    [profile, logs] = await Promise.all([
      api.get('/api/me').then((r) => r.user),
      api.get('/api/me/dispatch-log').then((r) => r.logs).catch(() => []),
    ]);
    await loadGroups();
  } catch (e) {
    view.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p><button class="btn" id="retry">重试</button></div>`;
    view.querySelector('#retry').addEventListener('click', renderSettings);
    return;
  }
  const p = profile;
  const failed = logs.filter((l) => l.status === 'failed')[0];
  const CH = { serverchan: '微信', email: '邮件', push: '设备通知' };

  view.innerHTML = `
    <div class="panel">
      <h3>账号<small>${esc(p.username)}</small></h3>
      <div class="field"><label class="lbl" for="s-name">昵称</label>
        <div class="field-row ratio"><input class="input" id="s-name" maxlength="20" value="${esc(p.display_name)}">
        <button class="btn" id="s-save-name">保存昵称</button></div></div>
      <div class="inline-actions">
        <button class="btn sm" id="s-pass">修改密码</button>
        <button class="btn sm danger" id="s-logout">退出登录</button>
      </div>
    </div>

    <div class="panel">
      <h3>提醒方式<small>${IC.bell(14)}</small></h3>
      <div class="field"><label class="lbl" for="s-hour">每天几点发送汇总（北京时间）</label>
        <select class="input" id="s-hour">${hourOptions(p.notify_hour)}</select>
        <div class="hint">App 内首页的「需要处理」永远可见。下面的渠道是额外的主动推送，每天最多一条汇总。</div></div>

      <div class="row"><div class="grow"><div class="title">微信（Server酱）</div>
        <div class="sub">个人微信的「服务通知」，免费版每天 5 条，足够汇总使用</div></div>${toggle('s-sc-on', p.notify_serverchan)}</div>
      <div class="field" style="margin-top:.6rem"><label class="lbl" for="s-sc-key">SendKey</label>
        <input class="input" id="s-sc-key" placeholder="${p.has_serverchan_key ? '已保存，留空表示不修改' : '在 sct.ftqq.com 微信扫码登录后获取'}" value="${esc(p.serverchan_key)}" autocomplete="off">
        <div class="hint">打开 <a href="https://sct.ftqq.com/" target="_blank" rel="noopener">sct.ftqq.com</a>，微信扫码登录，复制页面上的 SendKey 粘贴到这里。</div></div>
      <div class="inline-actions"><button class="btn sm" id="s-sc-test">${IC.bell(16)}发送测试消息</button></div>

      <div class="row" style="margin-top:1rem"><div class="grow"><div class="title">邮件</div>
        <div class="sub">${p.mail_available ? `发件地址：${esc(p.mail_sender)}，请加入白名单避免进垃圾箱` : '服务器尚未配置发件邮箱，暂不可用'}</div></div>${toggle('s-em-on', p.notify_email)}</div>
      <div class="field" style="margin-top:.6rem"><label class="lbl" for="s-email">收件邮箱</label>
        <input class="input" id="s-email" type="email" inputmode="email" placeholder="you@qq.com" value="${esc(p.email)}" autocomplete="email"></div>
      <div class="inline-actions"><button class="btn sm" id="s-em-test" ${p.mail_available ? '' : 'disabled'}>${IC.bell(16)}发送测试邮件</button></div>

      <div class="row" style="margin-top:1rem"><div class="grow"><div class="title">本设备通知</div>
        <div class="sub" id="s-push-sub">检测中…</div></div>
        <label class="toggle-switch" aria-label="本设备通知"><input type="checkbox" id="s-push-on" disabled><span class="toggle-track"></span></label></div>
      <div class="inline-actions"><button class="btn sm" id="s-push-test" hidden>${IC.bell(16)}发送测试通知</button></div>

      <div class="err" id="s-err" role="alert"></div>
      <div class="btn-row"><button class="btn primary" id="s-save-notify">保存提醒设置</button></div>
      ${failed ? `<div class="hint warn" style="margin-top:.7rem">最近一次发送失败：${esc(CH[failed.channel] || failed.channel)}（${esc(failed.date)}）${esc(failed.error)}</div>` : ''}
    </div>

    <div class="panel">
      <h3>家庭组<small>和家人共享同一份清单</small></h3>
      <div id="g-list">${state.groups.map((g) => `
        <div class="row click" data-gid="${g.id}">
          <div class="grow"><div class="title">${esc(g.is_personal ? '个人空间' : g.name)}</div>
            <div class="sub">${g.is_personal ? '仅自己可见' : `${g.member_count} 位成员${g.is_owner ? ' · 你是组长' : ''}`}</div></div>
        </div>`).join('')}</div>
      <div class="inline-actions">
        <button class="btn sm" id="g-create">${IC.plus(16)}创建家庭组</button>
        <button class="btn sm" id="g-join">${IC.users(16)}用邀请码加入</button>
      </div>
    </div>

    ${p.is_admin ? `
    <div class="panel">
      <h3>注册邀请码<small>管理员</small></h3>
      <div class="hint" style="margin:0 0 .6rem">生成后发给要注册的人，一次性有效，7 天内使用。</div>
      <button class="btn sm" id="inv-new">${IC.plus(16)}生成邀请码</button>
      <div id="inv-list" style="margin-top:.6rem"></div>
    </div>` : ''}

    ${logs.length ? `
    <div class="panel"><h3>最近发送记录</h3>
      ${logs.map((l) => `<div class="row"><div class="grow"><div class="title">${esc(l.date)} · ${esc(CH[l.channel] || l.channel)}</div>
        <div class="sub">${l.status === 'ok' ? `<span class="log-ok">已发送 ${l.item_count} 件</span>` : `<span class="log-fail">失败：${esc(l.error)}</span>`}</div></div></div>`).join('')}
    </div>` : ''}
  `;

  const $ = (s) => view.querySelector(s);

  $('#s-save-name').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    try { await api.put('/api/me', { display_name: $('#s-name').value }); toast('昵称已保存'); } catch (ex) { toast(ex.message, true); }
  }));
  $('#s-logout').addEventListener('click', logout);
  $('#s-pass').addEventListener('click', openPassword);

  const readNotify = () => ({
    notify_hour: Number($('#s-hour').value),
    serverchan_key: $('#s-sc-key').value.trim(),
    notify_serverchan: $('#s-sc-on').checked,
    email: $('#s-email').value.trim(),
    notify_email: $('#s-em-on').checked,
  });
  const saveNotify = async (quiet) => {
    $('#s-err').textContent = '';
    try {
      profile = (await api.put('/api/me', readNotify())).user;
      if (!quiet) toast('提醒设置已保存');
      return true;
    } catch (ex) { $('#s-err').textContent = ex.message; return false; }
  };
  $('#s-save-notify').addEventListener('click', (e) => withBusy(e.currentTarget, () => saveNotify(false)));
  const testChannel = (btnSel, channel) => $(btnSel).addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    // 先保存当前输入，再用已保存的值测试，避免"测的不是看到的"
    if (!(await saveNotify(true))) return;
    try { await api.post('/api/me/test-channel', { channel }); toast('测试消息已发送，请查收'); } catch (ex) { toast(ex.message, true); }
  }));
  testChannel('#s-sc-test', 'serverchan');
  testChannel('#s-em-test', 'email');
  testChannel('#s-push-test', 'push');
  bindPush(view);

  $('#g-create').addEventListener('click', openCreateGroup);
  $('#g-join').addEventListener('click', openJoinGroup);
  view.querySelectorAll('[data-gid]').forEach((r) => r.addEventListener('click', () => openGroup(Number(r.dataset.gid))));

  if (p.is_admin) {
    const drawInvites = async () => {
      try {
        const { invites } = await api.get('/api/admin/invites');
        const st = { available: '可用', used: '已使用', expired: '已过期' };
        $('#inv-list').innerHTML = invites.length ? invites.map((i) => `
          <div class="row"><div class="grow"><span class="code-box">${esc(i.code)}</span>
            <div class="sub">${st[i.state]}${i.used_by_name ? `（${esc(i.used_by_name)}）` : ''} · 有效期至 ${esc(fmtTs(i.expires_at))}</div></div>
            ${i.state === 'available' ? `<button class="icon-btn" data-copy="${esc(i.code)}" aria-label="复制">${IC.copy(18)}</button>` : ''}</div>`).join('') : '<div class="hint">还没有生成过邀请码</div>';
        $('#inv-list').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
      } catch (ex) { $('#inv-list').innerHTML = `<div class="hint warn">${esc(ex.message)}</div>`; }
    };
    $('#inv-new').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      try { const r = await api.post('/api/admin/invites'); await copyText(r.code); await drawInvites(); } catch (ex) { toast(ex.message, true); }
    }));
    drawInvites();
  }
}

const PUSH_TEXT = {
  unsupported: '当前浏览器不支持通知',
  'need-install': 'iPhone 需先在 Safari 点「分享 → 添加到主屏幕」，再从主屏幕图标打开才能开启',
  denied: '通知权限已被拒绝，请在系统或浏览器设置里允许后重试',
  unavailable: '服务器未启用浏览器通知',
  off: '未开启。开启后，每天的汇总会推送到这台设备',
  on: '已开启，汇总会推送到这台设备',
};

async function bindPush(view) {
  const sw = view.querySelector('#s-push-on');
  const sub = view.querySelector('#s-push-sub');
  const testBtn = view.querySelector('#s-push-test');
  const draw = async () => {
    let r;
    try { r = await pushState(); } catch { r = { state: 'unavailable' }; }
    sub.textContent = PUSH_TEXT[r.state] || '';
    sw.checked = r.state === 'on';
    sw.disabled = !['on', 'off'].includes(r.state);
    testBtn.hidden = r.state !== 'on';
    return r.state;
  };
  await draw();
  sw.addEventListener('change', async () => {
    const want = sw.checked;
    sw.disabled = true;
    try {
      if (want) await enablePush(); else await disablePush();
      toast(want ? '已开启本设备通知' : '已关闭本设备通知');
    } catch (ex) { toast(ex.message || '操作失败', true); }
    await draw();
  });
}

function openPassword() {
  const mask = showModal(`
    ${modalHead('修改密码')}
    <form id="pw-form" novalidate>
      <div class="field"><label class="lbl" for="pw-old">原密码</label><input class="input" id="pw-old" type="password" autocomplete="current-password"></div>
      <div class="field"><label class="lbl" for="pw-new">新密码（6 位以上）</label><input class="input" id="pw-new" type="password" autocomplete="new-password"></div>
      <div class="err" id="pw-err" role="alert"></div>
      <div class="btn-row"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">确认修改</button></div>
    </form>`);
  bindClose(mask);
  mask.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await withBusy(e.target.querySelector('button[type=submit]'), async () => {
      try {
        await api.post('/api/me/password', { old_password: mask.querySelector('#pw-old').value, new_password: mask.querySelector('#pw-new').value });
        hideModal(); toast('密码已修改');
      } catch (ex) { mask.querySelector('#pw-err').textContent = ex.message; }
    });
  });
}

function openCreateGroup() {
  const mask = showModal(`
    ${modalHead('创建家庭组')}
    <form id="cg-form" novalidate>
      <div class="field"><label class="lbl" for="cg-name">组名</label><input class="input" id="cg-name" maxlength="30" placeholder="如：我家"></div>
      <div class="err" id="cg-err" role="alert"></div>
      <div class="btn-row"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">创建</button></div>
    </form>`);
  bindClose(mask);
  mask.querySelector('#cg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await withBusy(e.target.querySelector('button[type=submit]'), async () => {
      try {
        const { group } = await api.post('/api/groups', { name: mask.querySelector('#cg-name').value });
        hideModal(); toast('已创建'); await afterGroupsChange(); openGroup(group.id);
      } catch (ex) { mask.querySelector('#cg-err').textContent = ex.message; }
    });
  });
}

function openJoinGroup() {
  const mask = showModal(`
    ${modalHead('用邀请码加入家庭组')}
    <form id="jg-form" novalidate>
      <div class="field"><label class="lbl" for="jg-code">家庭组邀请码</label>
        <input class="input" id="jg-code" autocapitalize="characters" autocomplete="off" maxlength="12">
        <div class="hint">向组长要 6 位邀请码。这不是注册邀请码。</div></div>
      <div class="err" id="jg-err" role="alert"></div>
      <div class="btn-row"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">加入</button></div>
    </form>`);
  bindClose(mask);
  mask.querySelector('#jg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await withBusy(e.target.querySelector('button[type=submit]'), async () => {
      try {
        await api.post('/api/groups/join', { code: mask.querySelector('#jg-code').value });
        hideModal(); toast('已加入'); await afterGroupsChange();
      } catch (ex) { mask.querySelector('#jg-err').textContent = ex.message; }
    });
  });
}

async function openGroup(gid) {
  let data;
  try { data = await api.get(`/api/groups/${gid}`); } catch (e) { toast(e.message, true); return; }
  const { group, members } = data;
  const mask = showModal(`
    ${modalHead(group.is_personal ? '个人空间' : group.name)}
    ${group.is_personal ? '<div class="hint">个人空间只有你自己能看到，不能邀请他人，也不能退出。</div>' : `
      ${group.is_owner ? `
      <div class="field"><span class="lbl">家庭组邀请码</span>
        <div class="row" style="padding:0"><span class="code-box">${esc(group.invite_code)}</span>
          <button class="icon-btn" id="gd-copy" aria-label="复制">${IC.copy(18)}</button>
          <button class="btn sm" id="gd-reset">重置</button></div>
        <div class="hint">把它发给家人，对方在「设置 → 用邀请码加入」输入即可。</div></div>
      <div class="field"><label class="lbl" for="gd-name">组名</label>
        <div class="field-row ratio"><input class="input" id="gd-name" maxlength="30" value="${esc(group.name)}"><button class="btn" id="gd-rename">保存</button></div></div>` : ''}
      <span class="lbl">成员（${members.length}）</span>
      ${members.map((m) => `
        <div class="row"><div class="grow"><div class="title">${esc(m.display_name)}</div><div class="sub">${esc(m.username)}</div></div>
          ${group.is_owner && m.id !== state.user.id ? `<button class="btn sm danger" data-kick="${m.id}">移出</button>` : ''}</div>`).join('')}
      <div class="btn-row"><button class="btn danger" id="gd-leave">退出家庭组</button></div>`}
  `);
  bindClose(mask);
  const $ = (s) => mask.querySelector(s);
  $('#gd-copy')?.addEventListener('click', () => copyText(group.invite_code));
  $('#gd-reset')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({ title: '重置邀请码', message: '旧邀请码将立即失效，确定重置？' });
    if (!ok) return;
    await withBusy(e.target, async () => {
      try { await api.post(`/api/groups/${gid}/reset-code`); hideModal(); toast('已重置'); await afterGroupsChange(); openGroup(gid); } catch (ex) { toast(ex.message, true); }
    });
  });
  $('#gd-rename')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    try { await api.put(`/api/groups/${gid}`, { name: $('#gd-name').value }); hideModal(); toast('已保存'); await afterGroupsChange(); } catch (ex) { toast(ex.message, true); }
  }));
  mask.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '移出成员', message: '对方将看不到该组的数据，也不再收到该组的提醒。', okText: '移出', danger: true });
    if (!ok) return;
    try { await api.del(`/api/groups/${gid}/members/${b.dataset.kick}`); hideModal(); toast('已移出'); await afterGroupsChange(); openGroup(gid); } catch (ex) { toast(ex.message, true); }
  }));
  $('#gd-leave')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '退出家庭组', message: '退出后你将看不到该组的物品和说明书，也不再收到该组的提醒。', okText: '退出', danger: true });
    if (!ok) return;
    try { await api.post(`/api/groups/${gid}/leave`); hideModal(); toast('已退出'); await afterGroupsChange(); } catch (ex) { toast(ex.message, true); }
  });
}
