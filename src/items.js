import { api } from './api.js';
import { state, groupQuery } from './state.js';
import {
  esc, toast, showModal, hideModal, confirmDialog, modalHead, bindClose, emptyState,
  withBusy, UNIT_LABEL, previewExpiry,
} from './ui.js';
import { IC } from './icons.js';
import { recognizePackaging } from './ocr.js';

let scope = 'active';
let seq = 0;

const remainText = (st) => {
  if (!st || st.key === 'unset') return '未设置到期日';
  if (st.remaining < 0) return `已过期 ${-st.remaining} 天`;
  if (st.remaining === 0) return '今天到期';
  return `还剩 ${st.remaining} 天`;
};
const URGENT = new Set(['notice', 'priority', 'soon', 'today', 'expired']);

function card(it) {
  const st = it.state;
  const meta = [
    `<span class="chip">${esc(it.category_label)}</span>`,
    !it.is_personal ? `<span class="chip">${IC.users(12)}${esc(it.group_name)}</span>` : '',
    it.expiry_date ? `<span>到期 ${esc(it.expiry_date)}</span>` : '',
  ].join('');
  if (scope === 'history') {
    const kindLabel = it.processed_kind === 'used' ? '已用完' : '已丢弃';
    return `
      <button class="card" data-id="${it.id}">
        <div><div class="name">${esc(it.name)}</div><div class="meta">${meta}</div>
          <div class="note-line">${esc(it.processed_by_name || '')} 标记</div></div>
        <div class="side"><span class="badge b-${esc(it.processed_kind)}">${kindLabel}</span></div>
      </button>`;
  }
  return `
    <button class="card s-${esc(st.key)}" data-id="${it.id}">
      <div>
        <div class="name">${esc(it.name)}</div>
        <div class="meta">${meta}</div>
        ${it.note ? `<div class="note-line">${esc(it.note)}</div>` : ''}
      </div>
      <div class="side">
        <span class="badge b-${esc(st.key)}">${esc(st.label)}</span>
        <div class="remain">${esc(remainText(st))}</div>
      </div>
    </button>`;
}

export async function renderItems() {
  const view = document.getElementById('view-items');
  const my = ++seq;
  view.innerHTML = `
    <div class="toolbar">
      <div class="seg" role="tablist">
        <button data-scope="active" class="${scope === 'active' ? 'on' : ''}" role="tab">进行中</button>
        <button data-scope="history" class="${scope === 'history' ? 'on' : ''}" role="tab">历史</button>
      </div>
    </div>
    <div id="items-body"><div class="loading">加载中…</div></div>
    ${scope === 'active' ? `<button class="fab" id="add-item" aria-label="添加物品">${IC.plus(26)}</button>` : ''}`;
  view.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { scope = b.dataset.scope; renderItems(); }));
  view.querySelector('#add-item')?.addEventListener('click', () => openForm());

  const body = view.querySelector('#items-body');
  let items;
  try {
    const q = [`scope=${scope}`, groupQuery()].filter(Boolean).join('&');
    items = (await api.get(`/api/items?${q}`)).items;
  } catch (e) {
    if (my !== seq) return;
    body.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p><button class="btn" id="retry">重试</button></div>`;
    body.querySelector('#retry').addEventListener('click', renderItems);
    return;
  }
  if (my !== seq) return;

  if (!items.length) {
    body.innerHTML = scope === 'active'
      ? emptyState(IC.package(48), '还没有记录任何物品', '拿到护肤品或食品时，点右下角 + 记一下生产日期和保质期')
      : emptyState(IC.clock(48), '还没有已处理的物品');
    return;
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  let html;
  if (scope === 'history') {
    html = `<div class="list">${items.map(card).join('')}</div>`;
  } else {
    const urgent = items.filter((i) => URGENT.has(i.state.key));
    const rest = items.filter((i) => !URGENT.has(i.state.key));
    html = (urgent.length ? `<div class="section-title urgent">需要处理 <span class="count">${urgent.length}</span></div><div class="list">${urgent.map(card).join('')}</div>` : '')
      + (rest.length ? `<div class="section-title">其他物品 <span class="count">${rest.length}</span></div><div class="list">${rest.map(card).join('')}</div>` : '');
  }
  body.innerHTML = html;
  body.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => openDetail(byId.get(Number(c.dataset.id)))));
}

async function openDetail(it) {
  const st = it.state;
  const shelf = it.shelf_life_value ? `${it.shelf_life_value} ${UNIT_LABEL[it.shelf_life_unit]}` : '—';
  const active = it.status === 'active';
  const mask = showModal(`
    ${modalHead(it.name)}
    ${active ? `<div style="margin-bottom:.6rem"><span class="badge b-${esc(st.key)}">${esc(st.label)}</span> <strong>${esc(remainText(st))}</strong></div>` : ''}
    <dl class="detail-grid">
      <dt>分类</dt><dd>${esc(it.category_label)}</dd>
      <dt>所属</dt><dd>${esc(it.is_personal ? '个人空间' : it.group_name)}</dd>
      <dt>生产日期</dt><dd>${esc(it.production_date || '—')}</dd>
      <dt>保质期</dt><dd>${esc(shelf)}</dd>
      <dt>到期日期</dt><dd>${esc(it.expiry_date || '—')}</dd>
      ${it.note ? `<dt>备注</dt><dd>${esc(it.note)}</dd>` : ''}
      ${!active ? `<dt>处理</dt><dd>${esc(it.processed_kind === 'used' ? '已用完' : '已丢弃')}（${esc(it.processed_by_name || '')}）</dd>` : ''}
    </dl>
    <div class="photo-box" id="photo-box" hidden></div>
    ${active ? `
      <div class="btn-row">
        <button class="btn primary" data-do="used">${IC.check(18)}已用完</button>
        <button class="btn" data-do="discarded">${IC.trash(18)}已丢弃</button>
      </div>
      <div class="btn-row">
        <button class="btn" data-do="edit">${IC.edit(18)}编辑</button>
        <button class="btn danger" data-do="delete">删除记录</button>
      </div>` : `
      <div class="btn-row">
        <button class="btn" data-do="restore">${IC.undo(18)}撤销处理</button>
        <button class="btn danger" data-do="delete">删除记录</button>
      </div>`}
  `);
  bindClose(mask);

  if (it.has_photo) {
    api.blob(`/api/items/${it.id}/photo`).then((b) => {
      const box = mask.querySelector('#photo-box');
      if (!box) return;
      const url = URL.createObjectURL(b);
      box.innerHTML = `<img src="${url}" alt="包装照片">`;
      box.hidden = false;
    }).catch(() => { /* 照片丢失时静默，不影响主流程 */ });
  }

  mask.querySelectorAll('[data-do]').forEach((btn) => btn.addEventListener('click', () => withBusy(btn, async () => {
    const act = btn.dataset.do;
    try {
      if (act === 'used' || act === 'discarded') {
        await api.post(`/api/items/${it.id}/handle`, { kind: act });
        hideModal(); toast(act === 'used' ? '已标记为用完' : '已标记为丢弃'); renderItems();
      } else if (act === 'restore') {
        await api.post(`/api/items/${it.id}/restore`);
        hideModal(); toast('已撤销'); renderItems();
      } else if (act === 'edit') {
        hideModal(); openForm(it);
      } else if (act === 'delete') {
        const ok = await confirmDialog({ title: '删除记录', message: `确定删除「${it.name}」？删除后无法恢复。`, okText: '删除', danger: true });
        if (!ok) return;
        await api.del(`/api/items/${it.id}`);
        hideModal(); toast('已删除'); renderItems();
      }
    } catch (e) { toast(e.message, true); }
  })));
}

function openForm(item) {
  const editing = Boolean(item);
  const mode0 = editing && !item.shelf_life_value && item.expiry_date ? 'expiry' : 'duration';
  const multiGroup = state.groups.length > 1;
  const defaultGroup = editing ? item.group_id
    : (state.filter !== 'all' ? Number(state.filter) : (state.groups.find((g) => g.is_personal) || state.groups[0]).id);

  const mask = showModal(`
    ${modalHead(editing ? '编辑物品' : '添加物品')}
    <form id="item-form" novalidate>
      <div class="field">
        <label class="lbl" for="f-name">名称</label>
        <input class="input" id="f-name" maxlength="50" placeholder="如：某某牌面霜 / 牛奶" value="${esc(editing ? item.name : '')}">
      </div>
      <div class="field">
        <span class="lbl">分类</span>
        <div class="seg" id="f-cat">
          <button type="button" data-v="food">食品</button>
          <button type="button" data-v="skincare">护肤品</button>
        </div>
      </div>
      ${multiGroup ? `
      <div class="field">
        <label class="lbl" for="f-group">放进哪个家庭组</label>
        <select class="input" id="f-group" ${editing ? 'disabled' : ''}>
          ${state.groups.map((g) => `<option value="${g.id}" ${g.id === defaultGroup ? 'selected' : ''}>${esc(g.is_personal ? '个人空间' : g.name)}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="field">
        <label class="lbl" for="f-prod">生产日期（建议填写，提醒更准）</label>
        <input class="input" id="f-prod" type="date" value="${esc(editing ? item.production_date || '' : '')}">
      </div>
      <div class="field">
        <span class="lbl">到期日怎么确定</span>
        <div class="seg" id="f-mode">
          <button type="button" data-v="duration">按保质期时长</button>
          <button type="button" data-v="expiry">直接填到期日</button>
        </div>
      </div>
      <div class="field" id="w-duration">
        <div class="field-row ratio">
          <input class="input" id="f-val" type="number" inputmode="numeric" min="1" max="999" placeholder="保质期" value="${esc(editing && item.shelf_life_value ? item.shelf_life_value : '')}">
          <select class="input" id="f-unit">
            ${['month', 'year', 'day'].map((u) => `<option value="${u}" ${(editing && item.shelf_life_unit === u) ? 'selected' : ''}>${UNIT_LABEL[u]}</option>`).join('')}
          </select>
        </div>
        <div class="hint" id="f-preview"></div>
      </div>
      <div class="field" id="w-expiry">
        <input class="input" id="f-exp" type="date" value="${esc(editing ? item.expiry_date || '' : '')}" aria-label="到期日期">
        <div class="hint warn" id="f-noprod" hidden>没有生产日期时，提醒节奏按「今天」到到期日计算，会偏晚一些。</div>
      </div>
      <div class="field">
        <label class="lbl" for="f-note">备注（选填）</label>
        <input class="input" id="f-note" maxlength="200" placeholder="如：冰箱二层" value="${esc(editing ? item.note : '')}">
      </div>
      <div class="field">
        <span class="lbl">包装日期照片（选填）</span>
        <input class="input" id="f-photo" type="file" accept="image/*">
        <div class="inline-actions" id="ocr-row" hidden>
          <button type="button" class="btn sm" id="ocr-run">${IC.camera(16)}识别日期</button>
        </div>
        <div class="hint" id="ocr-hint">${editing && item.has_photo ? '已有照片，选择新照片会替换。' : '拍下包装上印日期的位置，可自动识别并预填，你核对后再保存。'}</div>
      </div>
      <div class="err" id="f-err" role="alert"></div>
      <div class="btn-row">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
  bindClose(mask);

  const $ = (s) => mask.querySelector(s);
  let cat = editing ? item.category : 'food';
  let mode = mode0;
  const syncSeg = (sel, val) => $(sel).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === val));
  const refresh = () => {
    syncSeg('#f-cat', cat); syncSeg('#f-mode', mode);
    $('#w-duration').hidden = mode !== 'duration';
    $('#w-expiry').hidden = mode !== 'expiry';
    const p = previewExpiry($('#f-prod').value, $('#f-val').value, $('#f-unit').value);
    $('#f-preview').textContent = mode === 'duration'
      ? (p ? `到期日：${p}` : '需要同时填写生产日期和保质期，才能算出到期日')
      : '';
    $('#f-noprod').hidden = !(mode === 'expiry' && !$('#f-prod').value);
  };
  $('#f-cat').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { cat = b.dataset.v; refresh(); } });
  $('#f-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { mode = b.dataset.v; refresh(); } });
  ['#f-prod', '#f-val', '#f-unit'].forEach((s) => $(s).addEventListener('input', refresh));
  refresh();

  // ---- 拍照识别：只预填，不自动保存；已填写的字段需用户确认才覆盖 ----
  const fillField = (sel, val) => { $(sel).value = val; $(sel).dispatchEvent(new Event('input', { bubbles: true })); };
  const flash = (sel) => {
    const el = $(sel);
    el.classList.add('ocr-filled');
    setTimeout(() => el.classList.remove('ocr-filled'), 4000);
  };
  $('#f-photo').addEventListener('change', () => {
    const f = $('#f-photo').files[0];
    $('#ocr-row').hidden = !f;
    if (f) $('#ocr-hint').textContent = '点「识别日期」自动读取包装上的日期；也可以直接保存照片，稍后再手动填写。';
  });
  $('#ocr-run').addEventListener('click', async (e) => {
    const file = $('#f-photo').files[0];
    const hint = $('#ocr-hint');
    if (!file) return;
    await withBusy(e.currentTarget, async () => {
      let r;
      try {
        r = await recognizePackaging(file, (t) => { hint.textContent = t; });
      } catch (ex) {
        hint.textContent = '';
        toast(ex.message || '识别失败，请手动填写', true);
        return;
      }
      const p = r.parsed;
      const unitText = (sl) => `${sl.value} ${UNIT_LABEL[sl.unit]}`;
      // 1) 先收集：每个字段 = { label, apply(), existing, next }
      const changes = [];
      if (p.production_date) {
        changes.push({ label: '生产日期', existing: $('#f-prod').value, next: p.production_date,
          apply: () => { fillField('#f-prod', p.production_date); flash('#f-prod'); } });
      }
      if (p.expiry_date) {
        changes.push({ label: '到期日期', existing: mode === 'expiry' ? $('#f-exp').value : '', next: p.expiry_date,
          apply: () => { mode = 'expiry'; refresh(); fillField('#f-exp', p.expiry_date); flash('#f-exp'); } });
      } else if (p.shelf_life) {
        const cur = mode === 'duration' && $('#f-val').value
          ? `${$('#f-val').value} ${UNIT_LABEL[$('#f-unit').value]}` : '';
        changes.push({ label: '保质期', existing: cur, next: unitText(p.shelf_life),
          apply: () => {
            mode = 'duration'; refresh();
            fillField('#f-val', String(p.shelf_life.value)); fillField('#f-unit', p.shelf_life.unit); flash('#f-val');
          } });
      }
      // 2) 只有"已有不同值"的字段才需要确认；有冲突时合并成一个对话框
      const conflicts = changes.filter((c) => c.existing && c.existing !== c.next);
      let overwrite = true;
      if (conflicts.length) {
        overwrite = await confirmDialog({
          title: '用识别结果替换已填内容？',
          message: conflicts.map((c) => `${c.label}：${c.existing} → ${c.next}`).join('；'),
          okText: '全部替换',
        });
      }
      // 3) 应用：无冲突的字段总是填；有冲突的字段仅在用户同意时填
      const filled = [];
      const skipped = [];
      for (const c of changes) {
        const isConflict = conflicts.includes(c);
        if (isConflict && !overwrite) { skipped.push(c.label); continue; }
        c.apply(); filled.push(c.label);
      }
      const guessed = Object.values(p.sources).includes('position');
      const lines = [];
      if (filled.length) {
        // 复述识别到的原始文字：OCR 最常见的错误是"差一位"（如 11 月读成 1 月），
        // 结果仍是合法日期，程序无法判断，只能让用户拿原文对照照片。
        const quoted = [
          ['生产日期', p.raws.production_date], ['到期日期', p.raws.expiry_date], ['保质期', p.raws.shelf_life],
        ].filter(([label, raw]) => raw && filled.includes(label)).map(([label, raw]) => `${label}读到的是「${raw}」`);
        lines.push(`已预填：${filled.join('、')}。${quoted.length ? `${quoted.join('，')}。` : ''}请对照照片核对数字再保存。`);
      }
      if (guessed) lines.push('部分日期没有文字标签，是按位置推测的，务必核对。');
      lines.push(...p.notes);
      if (!filled.length && !skipped.length) {
        lines.length = 0;
        lines.push('没有识别到日期。请让日期占满画面、光线充足再试一次，或直接手动填写。');
      }
      hint.textContent = lines.join(' ');
      hint.classList.toggle('warn', guessed || !filled.length || p.notes.length > 0);
    });
  });

  $('#item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const err = $('#f-err');
    err.textContent = '';
    const body = {
      group_id: Number($('#f-group')?.value || defaultGroup),
      name: $('#f-name').value,
      category: cat,
      note: $('#f-note').value,
      production_date: $('#f-prod').value || null,
    };
    if (mode === 'duration') {
      body.shelf_life_value = $('#f-val').value || null;
      body.shelf_life_unit = $('#f-unit').value;
    } else {
      body.expiry_date = $('#f-exp').value || null;
    }
    const file = $('#f-photo').files[0];
    if (file && file.size > 20 * 1024 * 1024) { err.textContent = '照片超过 20MB 限制'; return; }

    await withBusy(btn, async () => {
      try {
        const saved = editing ? await api.put(`/api/items/${item.id}`, body) : await api.post('/api/items', body);
        let photoFailed = false;
        if (file) {
          try { await api.upload(`/api/items/${saved.item.id}/photo`, file); } catch { photoFailed = true; }
        }
        hideModal();
        toast(photoFailed ? '物品已保存，但照片上传失败' : '已保存', photoFailed);
        renderItems();
      } catch (ex) { err.textContent = ex.message; }
    });
  });
}
