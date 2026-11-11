import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// 通过文件头判断真实类型，不信任客户端声明的 Content-Type / 扩展名
export function sniffType(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

export function storeFile(dataDir, kind, groupId, buf, ext) {
  const rel = path.join(kind, String(groupId), `${crypto.randomUUID()}.${ext}`);
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return rel;
}

export function absPath(dataDir, rel) {
  const abs = path.resolve(dataDir, rel);
  if (!abs.startsWith(path.resolve(dataDir) + path.sep)) throw new Error('非法路径');
  return abs;
}

export function removeFile(dataDir, rel) {
  if (!rel) return;
  try { fs.unlinkSync(absPath(dataDir, rel)); } catch { /* 文件已不存在 */ }
}
