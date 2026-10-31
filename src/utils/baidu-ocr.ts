// ============================================================
// baidu-ocr.ts — 百度云 OCR 封装（手写体 → 高精度 → 标准 自动降级）
// ============================================================
// 端点降级链（按识别质量排序，额度耗尽/未开通自动切下一个）：
//   1. handwriting    手写体识别：专为手写优化（涂改痕迹检测、20+语种）；
//                     免费测试额度约 200 次（一次性）
//   2. accurate_basic 通用文字识别（高精度版）：个人认证 1000 次/月，超出 ~0.015 元/次
//   3. general        通用文字识别（标准版）：兜底（兄弟项目长期在用的端点）
// 额度/未开通的错误码：17（每天请求量超限）、19（请求总量超限）
// → 标记该端点本进程内耗尽，降级到下一端点；18（QPS 超限）是秒级瞬时窗口：
//   等 1s 同端点重试一次，仍失败只本次降级、不拉黑。其余错误直接抛出。
// 鉴权：AK/SK 换 access_token（30 天有效，进程内缓存 + 并发去重，110/111 自动刷新）
// 请求：application/x-www-form-urlencoded，image 字段为去掉 data: 头的 base64
// 限制：base64 urlencode 后 ≤4MB，最短边 ≥15px，最长边 ≤4096px

const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const OCR_BASE = 'https://aip.baidubce.com/rest/2.0/ocr/v1';

/** 降级链（名称即 URL 末段） */
const ENDPOINTS = ['handwriting', 'accurate_basic', 'general'] as const;

/** 端点中文名（接口返回 engine 用） */
export const BAIDU_ENDPOINT_LABELS: Record<string, string> = {
  handwriting: '百度·手写体识别',
  accurate_basic: '百度·高精度版',
  general: '百度·标准版',
};

/** 进程内已耗尽额度的端点（17/19 是日/总量限制，isolate 生命周期内不再尝试） */
const exhausted = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** access_token 缓存（有效期 30 天，提前 24h 视为过期以留缓冲）*/
let cachedToken: { token: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string> | null = null;

async function getAccessToken(ak: string, sk: string): Promise<string> {
  const cached = cachedToken;
  if (cached && cached.expiresAt > Date.now() + 24 * 3600 * 1000) return cached.token;

  // 并发去重：多个请求同时冷启动时只取一次 token
  if (!tokenRequest) {
    tokenRequest = (async () => {
      const url = `${TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(ak)}&client_secret=${encodeURIComponent(sk)}`;
      const resp = await fetch(url);
      const data: any = await resp.json().catch(() => null);
      if (!resp.ok || !data?.access_token) {
        throw new Error(`获取百度 access_token 失败：${data?.error_description || `HTTP ${resp.status}`}`);
      }
      const expiresIn = Number(data.expires_in) || 2592000;
      cachedToken = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
      return data.access_token;
    })().finally(() => { tokenRequest = null; });
  }
  return tokenRequest;
}

/** 识别文字：沿降级链逐端点尝试，返回 { text, endpoint }。token 失效自动刷新重试一次。 */
export async function baiduOcr(
  ak: string,
  sk: string,
  base64Image: string,
): Promise<{ text: string; endpoint: string }> {
  let token = await getAccessToken(ak, sk);
  let lastErr: any = null;
  let attempted = 0;
  let qpsSkipped = 0;

  for (const endpoint of ENDPOINTS) {
    if (exhausted.has(endpoint)) continue;
    attempted++;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await recognize(token, endpoint, base64Image);
        if (text.trim()) return { text: text.trim(), endpoint };
        break;   // 识别成功但无文字 → 换下一端点（可能是不适配的字体）
      } catch (err: any) {
        const code = err?.code;
        const isTokenError = code === 110 || code === 111 || code === 401;
        if (isTokenError && attempt === 0) {
          // access_token 失效/过期：清缓存重新获取后再试一次
          cachedToken = null;
          token = await getAccessToken(ak, sk);
          continue;
        }
        // 17=每天请求量超限 19=请求总量超限：持久性额度问题 → 本 isolate 内不再尝试该端点
        if (code === 17 || code === 19) {
          exhausted.add(endpoint);
          console.error(`[baidu-ocr] 端点 ${endpoint} 额度耗尽（code ${code}），降级到下一端点`);
          break;
        }
        // 18=QPS 超限：秒级瞬时窗口，不是额度耗尽。等 1s 同端点重试一次；
        // 重试仍 18 → 本次调用降级到下一端点，但【不】拉黑——否则一次 QPS 尖峰会把
        // 最优端点在本 isolate 生命周期内永久跳过（极端时三端点全入黑名单，
        // 之后所有请求连发都不发就报错，用户重试也无效）。
        if (code === 18) {
          if (attempt === 0) {
            await sleep(1100);
            continue;
          }
          qpsSkipped++;
          console.error(`[baidu-ocr] 端点 ${endpoint} QPS 超限（重试后仍失败），本次降级到下一端点（不拉黑）`);
          break;
        }
        lastErr = err;
        break;
      }
    }
  }

  if (lastErr) throw lastErr;
  if (attempted === 0) {
    // 三个端点全部因 17/19 在册：报真实原因，避免用户对着「未识别到文字」反复重传
    throw new Error('百度 OCR 免费额度已用尽，请改用大模型识别');
  }
  if (qpsSkipped > 0 && qpsSkipped === attempted) {
    throw new Error('百度 OCR 触发限流（QPS），请稍等几秒后重试');
  }
  throw new Error('百度 OCR：全部端点均未识别到文字');
}

async function recognize(token: string, endpoint: string, base64Image: string): Promise<string> {
  const url = `${OCR_BASE}/${endpoint}?access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ image: base64Image, paragraph: 'true' }),
  });

  const raw = await resp.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = null; }

  if (!resp.ok || !data || data.error_code) {
    const err = new Error(`百度 OCR 识别失败（${endpoint}）：${data?.error_msg || data?.error_code || `HTTP ${resp.status}`}`);
    (err as any).code = data?.error_code ?? resp.status;
    throw err;
  }
  return layoutText(data);
}

/** 按位置还原文本：先按段落分组，段内按 (top, left) 排序还原阅读顺序。
 *  accurate_basic 不含位置/段落信息 → 按接口返回顺序逐行拼接（通常已是阅读顺序）。 */
function layoutText(data: any): string {
  const lines: { w: string; para?: number; top: number; left: number }[] = [];
  for (const r of data.words_result || []) {
    const w = String(r.words || '').trim();
    if (!w) continue;
    const loc = r.location || {};
    lines.push({ w, para: r.paragraph_id, top: Number(loc.top) || 0, left: Number(loc.left) || 0 });
  }
  if (lines.length === 0) return '';

  // 无段落信息时按接口返回顺序拼接（通常已是阅读顺序）
  const hasPara = lines.every(l => typeof l.para === 'number');
  if (!hasPara) return lines.map(l => l.w).join('\n');

  const groups = new Map<number, typeof lines>();
  for (const l of lines) {
    if (!groups.has(l.para!)) groups.set(l.para!, []);
    groups.get(l.para!)!.push(l);
  }

  return [...groups.values()]
    .sort((a, b) => minTop(a) - minTop(b) || minLeft(a) - minLeft(b))
    .map(group => group.sort((a, b) => a.top - b.top || a.left - b.left).map(l => l.w).join(' '))
    .join('\n\n');
}

function minTop(group: { top: number }[]): number {
  return Math.min(...group.map(l => l.top));
}
function minLeft(group: { left: number }[]): number {
  return Math.min(...group.map(l => l.left));
}
