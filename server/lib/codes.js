import crypto from 'crypto';

// 去掉易混淆字符（0/O、1/I/L）
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function uniqueCode(len, exists) {
  for (let i = 0; i < 20; i++) {
    const c = randomCode(len);
    if (!exists(c)) return c;
  }
  throw new Error('生成邀请码失败');
}
