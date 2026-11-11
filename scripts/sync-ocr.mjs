// 把 OCR 需要的文件从 node_modules 同步到指定目录（默认 public/vendor/tesseract）。
// 本地开发（npm run build 之前）和 N150 的 restart.sh 共用这一份逻辑，避免两处各写一套。
//
// 只拷浏览器真正会请求的文件：
//   - tesseract.min.js / worker.min.js
//   - 3 个 LSTM core（普通 / SIMD / relaxed-SIMD，由浏览器按能力自动选择）
//   - chi_sim + eng 语言包（best_int 量化版：1.7MB + 2.9MB，比完整版小 10 倍，
//     实测在合成包装图上识别质量反而更好）
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function pkgDir(name, base) {
  // 兼容 N150 的软链布局：node_modules 在 $HOME/weremember-deps 下
  const pj = require.resolve(`${name}/package.json`, { paths: [base] });
  return path.dirname(pj);
}

export function syncTesseract(dest, base = process.cwd()) {
  const js = pkgDir('tesseract.js', base);
  const core = pkgDir('tesseract.js-core', base);
  const chi = pkgDir('@tesseract.js-data/chi_sim', base);
  const eng = pkgDir('@tesseract.js-data/eng', base);

  const files = [
    [path.join(js, 'dist/tesseract.min.js'), 'tesseract.min.js'],
    [path.join(js, 'dist/worker.min.js'), 'worker.min.js'],
    [path.join(js, 'LICENSE.md'), 'LICENSE-tesseract.js.txt'],
    [path.join(core, 'LICENSE'), 'LICENSE-tesseract.js-core.txt'],
    ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].map((v) => [path.join(core, `tesseract-core-${v}.wasm.js`), `tesseract-core-${v}.wasm.js`]),
    [path.join(chi, '4.0.0_best_int/chi_sim.traineddata.gz'), 'lang/chi_sim.traineddata.gz'],
    [path.join(eng, '4.0.0_best_int/eng.traineddata.gz'), 'lang/eng.traineddata.gz'],
  ];

  fs.mkdirSync(path.join(dest, 'lang'), { recursive: true });
  let bytes = 0;
  for (const [src, rel] of files) {
    if (!fs.existsSync(src)) throw new Error(`OCR 文件缺失：${src}`);
    const to = path.join(dest, rel);
    fs.copyFileSync(src, to);
    bytes += fs.statSync(to).size;
  }
  return { files: files.length, bytes };
}

// 直接运行：node scripts/sync-ocr.mjs [dest]
if (import.meta.url === `file://${process.argv[1]}`) {
  const dest = path.resolve(process.argv[2] || 'public/vendor/tesseract');
  const base = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd();
  const r = syncTesseract(dest, base);
  console.log(`OCR 资源已同步到 ${dest}（${r.files} 个文件，${(r.bytes / 1048576).toFixed(1)}MB）`);
}
