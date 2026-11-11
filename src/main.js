import { api, getToken, clearToken, onAuthLost } from './api.js';
import { state, loadGroups } from './state.js';
import { esc, hideModal } from './ui.js';
import { IC } from './icons.js';
import { renderLogin } from './auth.js';
import { renderItems } from './items.js';
import { renderManuals } from './manuals.js';
import { renderSettings, bindSettings } from './settings.js';

const TABS = [
  { id: 'items', label: '保质期', icon: IC.clock, render: () => renderItems() },
  { id: 'manuals', label: '说明书', icon: IC.book, render: () => renderManuals() },
  { id: 'settings', label: '设置', icon: IC.settings, render: () => renderSettings() },
];
let current = 'items';

function showLogin() {
  hideModal();
  state.user = null;
  renderLogin(boot);
}

function drawGroupSelect() {
  const sel = document.getElementById('group-filter');
  if (!sel) return;
  const multi = state.groups.length > 1;
  sel.hidden = !multi || current === 'settings';
  sel.innerHTML = `<option value="all">全部</option>${state.groups.map((g) =>
    `<option value="${g.id}" ${String(g.id) === String(state.filter) ? 'selected' : ''}>${esc(g.is_personal ? '个人空间' : g.name)}</option>`).join('')}`;
  sel.value = String(state.filter);
}

function go(tab) {
  current = tab;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.getElementById('top-title').textContent = TABS.find((t) => t.id === tab).label;
  drawGroupSelect();
  TABS.find((t) => t.id === tab).render();
}

async function onGroupsChange() {
  await loadGroups();
  drawGroupSelect();
  go(current);
}

function renderShell() {
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <header class="topbar">
        <h1 id="top-title"></h1>
        <select class="input" id="group-filter" aria-label="按家庭组筛选"></select>
      </header>
      ${TABS.map((t) => `<main class="view" id="view-${t.id}"></main>`).join('')}
      <nav class="tab-bar" role="tablist"><div class="tab-bar-inner">
        ${TABS.map((t) => `<button class="tab-btn" role="tab" data-tab="${t.id}" aria-selected="false">${t.icon(23)}<span>${t.label}</span></button>`).join('')}
      </div></nav>
    </div>`;
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  document.getElementById('group-filter').addEventListener('change', (e) => {
    state.filter = e.target.value;
    go(current);
  });
}

async function boot() {
  if (!getToken()) { showLogin(); return; }
  try {
    state.user = (await api.get('/api/me')).user;
    await loadGroups();
  } catch (e) {
    if (e.status === 401) return; // onAuthLost 已处理
    document.getElementById('app').innerHTML = `<div class="empty-state" style="padding-top:30vh"><p>${esc(e.message)}</p><button class="btn" id="retry">重试</button></div>`;
    document.getElementById('retry').addEventListener('click', boot);
    return;
  }
  renderShell();
  go('items');
}

onAuthLost(showLogin);
bindSettings({
  onGroupsChange,
  onLogout: () => { clearToken(); showLogin(); },
});
boot();
