import { parsePackaging } from './dateparse.js';

// 浏览器端 OCR：tesseract.js 与语言包全部自托管在 /vendor/tesseract/（国内访问稳定，图片不出设备）。
// 只在用户点「识别日期」时才加载，不进主 bundle，不影响首屏。

const BASE = '/vendor/tesseract';
let loadPromise = null;
let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('识别组件加载失败，请检查网络后重试'));
    document.head.appendChild(s);
  });
}

function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!loadPromise) loadPromise = loadScript(`${BASE}/tesseract.min.js`);
      await loadPromise;
      const worker = await window.Tesseract.createWorker(['chi_sim', 'eng'], 1, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: BASE,
        langPath: `${BASE}/lang`,
        gzip: true,
        logger: (m) => { if (onProgress) onProgress(m); },
      });
      return worker;
    })().catch((e) => { workerPromise = null; loadPromise = null; throw e; });
  }
  return workerPromise;
}

// 灰度 + 对比度拉伸 + 限制最长边。手机拍的照片常是 4000px 以上，直接识别又慢又吃内存；
// 包装日期是小字，缩得太小会糊，所以限制在 1800px。
async function preprocess(file, maxSide = 1800) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g] += 1;
  }
  // 取 1% / 99% 分位做线性拉伸，抗个别极亮/极暗像素
  const total = w * h;
  let lo = 0; let hi = 255; let acc = 0;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v -= 1) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
  if (hi - lo > 20) {
    const k = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * k) | 0));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 返回 { text, parsed }。onStatus(text) 用于界面显示进度文案。
export async function recognizePackaging(file, onStatus = () => {}) {
  onStatus('正在加载识别组件（首次约 10 秒）…');
  const worker = await getWorker((m) => {
    if (m.status === 'loading tesseract core') onStatus('正在加载识别引擎…');
    else if (m.status === 'loading language traineddata') onStatus('正在加载中文语言包…');
    else if (m.status === 'initializing api') onStatus('正在初始化…');
    else if (m.status === 'recognizing text') onStatus(`正在识别… ${Math.round((m.progress || 0) * 100)}%`);
  });
  onStatus('正在处理图片…');
  const canvas = await preprocess(file);
  const { data } = await worker.recognize(canvas);
  const text = data.text || '';
  return { text, confidence: data.confidence, parsed: parsePackaging(text) };
}
