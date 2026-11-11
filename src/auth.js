import { api, setToken } from './api.js';
import { withBusy } from './ui.js';
import { IC } from './icons.js';

export function renderLogin(onSuccess) {
  let mode = 'login';
  const root = document.getElementById('app');

  const draw = () => {
    const reg = mode === 'register';
    root.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-brand">
          <div class="logo">${IC.clock(34)}</div>
          <h1>WeRemember</h1>
          <p>保质期不再忘，说明书不再丢</p>
        </div>
        <form class="auth-card" id="auth-form" autocomplete="on">
          <div class="field">
            <label class="lbl" for="a-user">用户名</label>
            <input class="input" id="a-user" name="username" autocomplete="username" maxlength="20" required>
          </div>
          <div class="field">
            <label class="lbl" for="a-pass">密码${reg ? '（6 位以上）' : ''}</label>
            <input class="input" id="a-pass" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
          </div>
          ${reg ? `
          <div class="field">
            <label class="lbl" for="a-code">注册邀请码</label>
            <input class="input" id="a-code" name="code" autocapitalize="characters" autocomplete="off" required>
            <div class="hint">邀请码由管理员提供，一次性有效，7 天内使用。</div>
          </div>` : ''}
          <div class="err" id="a-err" role="alert"></div>
          <button class="btn primary block" type="submit">${reg ? '注册' : '登录'}</button>
        </form>
        <div class="auth-switch">
          ${reg ? '已有账号？' : '还没有账号？'}
          <button type="button" id="a-switch">${reg ? '去登录' : '用邀请码注册'}</button>
        </div>
      </div>`;
    root.querySelector('#a-switch').addEventListener('click', () => { mode = reg ? 'login' : 'register'; draw(); });
    root.querySelector('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const err = root.querySelector('#a-err');
      err.textContent = '';
      await withBusy(btn, async () => {
        try {
          const username = root.querySelector('#a-user').value.trim();
          const password = root.querySelector('#a-pass').value;
          const res = reg
            ? await api.postPublic('/api/auth/register', { username, password, invite_code: root.querySelector('#a-code').value.trim() })
            : await api.postPublic('/api/auth/login', { username, password });
          setToken(res.token);
          await onSuccess();
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    });
  };
  draw();
}
