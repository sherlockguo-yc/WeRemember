import { api } from './api.js';

export const state = {
  user: null,
  groups: [],
  filter: 'all', // 'all' 或组 id（字符串）
};

export async function loadGroups() {
  state.groups = (await api.get('/api/groups')).groups;
  if (state.filter !== 'all' && !state.groups.some((g) => String(g.id) === String(state.filter))) {
    state.filter = 'all';
  }
  return state.groups;
}

export const personalGroup = () => state.groups.find((g) => g.is_personal) || state.groups[0];
export const groupQuery = () => (state.filter === 'all' ? '' : `group_id=${encodeURIComponent(state.filter)}`);
