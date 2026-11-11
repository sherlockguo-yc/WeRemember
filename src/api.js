const TOKEN_KEY = 'weremember_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let authLostHandler = () => {};
export function onAuthLost(fn) { authLostHandler = fn; }

async function request(method, url, { json, raw, auth = true } = {}) {
  const headers = {};
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (raw !== undefined) { headers['Content-Type'] = 'application/octet-stream'; body = raw; }

  let res;
  try {
    res = await fetch(url, { method, headers, body });
  } catch {
    throw new ApiError('网络连接失败，请检查网络后重试', 0);
  }
  if (res.status === 401 && auth) {
    clearToken();
    authLostHandler();
  }
  if (!res.ok) {
    let msg = '请求失败';
    try { msg = (await res.json()).error || msg; } catch { /* 非 JSON 错误页 */ }
    if (res.status === 413) msg = '文件超过 20MB 限制';
    throw new ApiError(msg, res.status);
  }
  return res;
}

const parse = async (p) => (await p).json();

export const api = {
  get: (url) => parse(request('GET', url)),
  post: (url, json) => parse(request('POST', url, { json: json ?? {} })),
  put: (url, json) => parse(request('PUT', url, { json })),
  del: (url) => parse(request('DELETE', url)),
  upload: (url, blob) => parse(request('POST', url, { raw: blob })),
  postPublic: (url, json) => parse(request('POST', url, { json, auth: false })),
  blob: async (url) => (await request('GET', url)).blob(),
};
