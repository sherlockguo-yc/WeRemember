import { api } from './api.js';
import { state, groupQuery } from './state.js';
import {
  esc, toast, showModal, hideModal, confirmDialog, modalHead, bindClose, emptyState, withBusy, fmtSize, fmtTs,
} from './ui.js';
import { IC } from './icons.js';

const MAX = 20 * 1024 * 1024;
const COMMON_CATS = ['小家电', '厨房电器', '数码', '美容仪', '家居'];
let query = '';
let seq = 0;
let searchTimer;

function card(m) {
  return `
    <button class="card" data-id="${m.id}">
      <div>
        <div class="name">${esc(m.name)}</div>
        <div class="meta">
          ${m.category ? `<span class="chip">${esc(m.category)}</span>` : ''}
          ${!m.is_personal ? `<span class="chip">${IC.users(12)}${esc(m.group_name)}</span>` : ''}
          <span>${esc(fmtSize(m.size))} · ${esc(fmtTs(m.created_at))}</span>
        </div>
        ${m.note ? `<div class="note-line">${esc(m.note)}</div>` : ''}
      </div>
      <div class="side">${m.mime === 'application/pdf' ? IC.file(26) : IC.camera(26)}</div>
    </button>`;
}

export async function renderManuals() {
  const view = document.getElementById('view-manuals');
  const my = ++seq;
  view.innerHTML = `
    <div class="toolbar">
      <div class="search">${IC.search(18)}<input class="input" id="m-q" type="search" placeholder="搜索产品名 / 分类 / 备注" value="${esc(query)}" maxlength="50"></div>
    </div>
    <div id="manuals-body"><div class="loading">加载中…</div></div>
    <button class="fab" id="add-manual" aria-label="上传说明书">${IC.plus(26)}</button>`;
  view.querySelector('#add-manual').addEventListener('click', () => openUpload());
  const input = view.querySelector('#m-q');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = input.value.trim(); loadList(); }, 300);
  });
  loadList(my);
}

async function loadList(token = seq) {
  const body = document.getElementById('manuals-body');
  if (!body) return;
  let list;
  try {
    const q = [groupQuery(), query ? `q=${encodeURIComponent(query)}` : ''].filter(Boolean).join('&');
    list = (await api.get(`/api/manuals${q ? `?${q}` : ''}`)).manuals;
  } catch (e) {
    if (token !== seq) return;
    body.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p><button class="btn" id="retry">重试</button></div>`;
    body.querySelector('#retry').addEventListener('click', () => loadList(token));
    return;
  }
  if (token !== seq) return;
  if (!list.length) {
    body.innerHTML = query
      ? emptyState(IC.search(48), `没有找到「${query}」`, '换个关键词试试')
      : emptyState(IC.book(48), '还没有说明书', '点右下角 + 上传 PDF 或说明书照片，以后不用再问客服');
    return;
  }
  const byId = new Map(list.map((m) => [m.id, m]));
  body.innerHTML = `<div class="list">${list.map(card).join('')}</div>`;
  body.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => openPreview(byId.get(Number(c.dataset.id)))));
}

async function openPreview(m) {
  const mask = showModal(`
    ${modalHead(m.name)}
    <div id="pv"><div class="loading">加载中…</div></div>
    <div class="hint" style="margin-top:.5rem">${esc([m.category, m.is_personal ? '个人空间' : m.group_name, `${fmtSize(m.size)}`].filter(Boolean).join(' · '))}${m.note ? `<br>${esc(m.note)}` : ''}</div>
    <div class="btn-row">
      <button class="btn" data-do="download">${IC.download(18)}下载</button>
      <button class="btn" data-do="edit">${IC.edit(18)}编辑</button>
      <button class="btn danger" data-do="delete">${IC.trash(18)}删除</button>
    </div>`);
  bindClose(mask);
  let blobUrl = null;
  const release = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  mask._onClose = release;

  try {
    const blob = await api.blob(`/api/manuals/${m.id}/file`);
    blobUrl = URL.createObjectURL(blob);
    const pv = mask.querySelector('#pv');
    if (!pv) return;
    pv.innerHTML = m.mime === 'application/pdf'
      ? `<iframe class="preview-frame" src="${blobUrl}" title="${esc(m.name)}"></iframe>`
      : `<img class="preview-img" src="${blobUrl}" alt="${esc(m.name)}">`;
  } catch (e) {
    const pv = mask.querySelector('#pv');
    if (pv) pv.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`;
  }

  mask.querySelectorAll('[data-do]').forEach((btn) => btn.addEventListener('click', () => withBusy(btn, async () => {
    const act = btn.dataset.do;
    try {
      if (act === 'download') {
        const blob = await api.blob(`/api/manuals/${m.id}/file?download=1`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = m.file_name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else if (act === 'edit') {
        hideModal(); openEdit(m);
      } else if (act === 'delete') {
        const ok = await confirmDialog({ title: '删除说明书', message: `确定删除「${m.name}」？文件会一并删除，无法恢复。`, okText: '删除', danger: true });
        if (!ok) return;
        await api.del(`/api/manuals/${m.id}`);
        hideModal(); toast('已删除'); loadList();
      }
    } catch (e) { toast(e.message, true); }
  })));
}

const catDatalist = `<datalist id="cat-list">${COMMON_CATS.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;

function openEdit(m) {
  const mask = showModal(`
    ${modalHead('编辑说明书信息')}
    <form id="m-form" novalidate>
      <div class="field"><label class="lbl" for="m-name">产品名称</label>
        <input class="input" id="m-name" maxlength="50" value="${esc(m.name)}"></div>
      <div class="field"><label class="lbl" for="m-cat">分类（选填）</label>
        <input class="input" id="m-cat" list="cat-list" maxlength="20" value="${esc(m.category)}">${catDatalist}</div>
      <div class="field"><label class="lbl" for="m-note">备注（选填）</label>
        <input class="input" id="m-note" maxlength="200" value="${esc(m.note)}"></div>
      <div class="err" id="m-err" role="alert"></div>
      <div class="btn-row"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">保存</button></div>
    </form>`);
  bindClose(mask);
  mask.querySelector('#m-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    await withBusy(btn, async () => {
      try {
        await api.put(`/api/manuals/${m.id}`, {
          name: mask.querySelector('#m-name').value,
          category: mask.querySelector('#m-cat').value,
          note: mask.querySelector('#m-note').value,
        });
        hideModal(); toast('已保存'); loadList();
      } catch (ex) { mask.querySelector('#m-err').textContent = ex.message; }
    });
  });
}

function openUpload() {
  const multi = state.groups.length > 1;
  const defGroup = state.filter !== 'all' ? Number(state.filter) : (state.groups.find((g) => g.is_personal) || state.groups[0]).id;
  const mask = showModal(`
    ${modalHead('上传说明书')}
    <form id="m-form" novalidate>
      <div class="field"><label class="lbl" for="m-file">文件（PDF 或图片，最大 20MB）</label>
        <input class="input" id="m-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></div>
      <div class="field"><label class="lbl" for="m-name">产品名称</label>
        <input class="input" id="m-name" maxlength="50" placeholder="如：某某牌吹风机"></div>
      <div class="field"><label class="lbl" for="m-cat">分类（选填）</label>
        <input class="input" id="m-cat" list="cat-list" maxlength="20" placeholder="如：小家电">${catDatalist}</div>
      ${multi ? `<div class="field"><label class="lbl" for="m-group">放进哪个家庭组</label>
        <select class="input" id="m-group">${state.groups.map((g) => `<option value="${g.id}" ${g.id === defGroup ? 'selected' : ''}>${esc(g.is_personal ? '个人空间' : g.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label class="lbl" for="m-note">备注（选填）</label>
        <input class="input" id="m-note" maxlength="200" placeholder="如：型号 HD08，购于 2026 年 11 月"></div>
      <div class="err" id="m-err" role="alert"></div>
      <div class="btn-row"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">上传</button></div>
    </form>`);
  bindClose(mask);
  const $ = (s) => mask.querySelector(s);
  $('#m-file').addEventListener('change', () => {
    const f = $('#m-file').files[0];
    if (f && !$('#m-name').value) $('#m-name').value = f.name.replace(/\.[^.]+$/, '').slice(0, 50);
  });
  $('#m-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const err = $('#m-err');
    err.textContent = '';
    const file = $('#m-file').files[0];
    if (!file) { err.textContent = '请选择要上传的文件'; return; }
    if (file.size > MAX) { err.textContent = `文件 ${fmtSize(file.size)}，超过 20MB 限制`; return; }
    if (!$('#m-name').value.trim()) { err.textContent = '请填写产品名称'; return; }
    const params = new URLSearchParams({
      group_id: String($('#m-group')?.value || defGroup),
      name: $('#m-name').value.trim(),
      category: $('#m-cat').value.trim(),
      note: $('#m-note').value.trim(),
      file_name: file.name,
    });
    await withBusy(btn, async () => {
      btn.textContent = '上传中…';
      try {
        await api.upload(`/api/manuals?${params}`, file);
        hideModal(); toast('已上传'); loadList();
      } catch (ex) { err.textContent = ex.message; btn.textContent = '上传'; }
    });
  });
}
