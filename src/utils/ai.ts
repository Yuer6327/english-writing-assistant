// ============================================================
// ai.ts — AI 调用封装（OpenAI Chat Completions 格式）
// 复用自 english-reading-assistant 的通用调用层：
//   多端点 failover（按 Cloudflare 1015 的 retry-after 排班）、
//   response_format 兼容回退、超时、extractJSON 容错、错误中文化。
// 业务提示词见 prompts.ts；结果校验见 validate.ts。
// ============================================================

/** 调用 AI 超时（毫秒）。批改/润色输出较长，放宽到 90s */
const AI_TIMEOUT_MS = 90000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── 多端点调度（按 1015 的 retry-after 排班）──
// Agnes 公用免费 API 有中国大陆 / 国际两个官方端点，**各自独立限流**：
//   apihub.agnes-ai.cn  → 429 / error code: 1015 / retry-after: 253
//   apihub.agnes-ai.com → 200 OK
// 即"一个封住不代表另一个也封住"，retry-after 就是权威的解封倒计时。
// ⚠️ 1015 的请求本身会加剧封堵（retry-after 会从 12s 恶化到 852s），
//    所以必须尽量少打被封的端点，而不是轮着猛冲。

/** 端点封堵到期时间（进程内，多 isolate 各记一份，够用且零依赖） */
const endpointBanUntil = new Map<string, number>();

function banEndpoint(url: string, sec: number) {
  endpointBanUntil.set(url, Date.now() + sec * 1000);
}

function banRemainingSec(url: string): number {
  const until = endpointBanUntil.get(url) ?? 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

/** 排班：未封堵的端点按配置顺序在前；都封堵时"先解封"的在前 */
function orderEndpoints(baseUrl: string | string[]): string[] {
  const urls = (Array.isArray(baseUrl) ? baseUrl : [baseUrl])
    .map(u => u.replace(/\/$/, ''))
    .filter((u, i, arr) => !!u && arr.indexOf(u) === i);
  if (urls.length <= 1) return urls;
  return [...urls].sort((a, b) => {
    const ra = banRemainingSec(a), rb = banRemainingSec(b);
    if ((ra === 0) !== (rb === 0)) return ra === 0 ? -1 : 1;   // 未封堵的优先
    return ra - rb;                                            // 都封堵：先解封的优先
  });
}

// 进程内缓存：已确认"带 response_format 会失败、去掉后成功"的模型。
// Agnes 模型名一律不带该参数（文档未列出）。
const skipResponseFormatModels = new Set<string>();

function isRateLimitMessage(msg: string): boolean {
  return /\b429\b/.test(msg) || /rate limit/i.test(msg);
}

/** Cloudflare 挡在具体 host 上（error code: 1015）：是"这个端点被限流"，不是 Agnes 账户 RPM */
function isCloudflareEndpointBlock(msg: string): boolean {
  return /error code:\s*1015/i.test(msg) || (/\b429\b/.test(msg) && /\b1015\b/.test(msg));
}

// ── 1015 / 429 处理策略 ──
// 1) 每个端点独立给出精确 retry-after，同一时刻差异极大 → 挑最快解封的等；
// 2) 封堵窗口是分钟级 → 请求内死磕没有意义；
// 3) retry-after 在预算内（≤12s）就地等掉、用户无感；超出预算就快速失败，
//    把精确秒数回传前端，由前端倒计时后再续跑。
const EDGE_WAIT_BUDGET_MS = 12000;   // 单次请求内最多为 1015 等待多久
const EDGE_WAIT_MAX_TIMES = 2;       // 预算内最多等几次

/** 上游错误可携带 retry-after（Cloudflare 限流会给出精确等待秒数） */
interface UpstreamError extends Error {
  retryAfterSec?: number;
}

/** 读取上游给的 retry-after（秒）；没有则返回 null */
export function aiRetryAfterSec(err: unknown): number | null {
  const v = (err as UpstreamError | undefined)?.retryAfterSec;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 限流类错误（Cloudflare 1015 边缘限流 / Agnes 账户 RPM）：可重试，但重试前必须退避 */
export function isAIRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return isCloudflareEndpointBlock(msg) || isRateLimitMessage(msg);
}

/** 把上游原始报错转成用户能看懂的中文提示 */
export function friendlyAIError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? '')).trim();
  if (isCloudflareEndpointBlock(raw)) {
    const sec = aiRetryAfterSec(err);
    const hint = sec === null
      ? '请稍等 1 分钟再试'
      : `请等约 ${sec >= 90 ? Math.ceil(sec / 60) + ' 分钟' : sec + ' 秒'}后再试`;
    return `免费 AI 接口被 Cloudflare 限流（429 / error code: 1015），${hint}；`
      + '这是共享免费接口的公共额度限制，在「设置」中改用自备 API Key 可彻底避免';
  }
  if (isRateLimitMessage(raw)) {
    return '免费 AI 接口调用过于频繁（每分钟约 20 次），请稍等约 1 分钟再试';
  }
  if (/abort|timed? ?out/i.test(raw)) {
    return 'AI 接口响应超时，请稍后重试';
  }
  return raw ? raw.slice(0, 300) : 'AI 调用失败';
}

/** contentPart 类型：文本 / 图片 data URL */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

/** 统一调用 AI，带超时。json=true 时要求返回 JSON。contentParts 存在时走多模态（手写 OCR / 看图批改）。
 *  temperature 显式覆盖默认温度（json 0.3 / 纯文本 0.7）。 */
export async function callAI(
  apiKey: string,
  baseUrl: string | string[],
  model: string,
  systemPrompt: string,
  userPrompt: string,
  json: boolean = true,
  contentParts?: ContentPart[],
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  // json 请求带 response_format 仅是"强制输出 JSON"的开关。部分端点不支持该参数
  // （Agnes 文档未列出该字段），失败后去掉重试一次即可——提示词本身已强制"输出纯 JSON"。
  const responseFormatKey = `${model}@${Array.isArray(baseUrl) ? baseUrl.join(',') : baseUrl}`;
  const skipFormat = /^agnes-/i.test(model) || skipResponseFormatModels.has(responseFormatKey);

  if (json && skipFormat) {
    return callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, false, contentParts, maxTokens, temperature);
  }

  // 其余 json 请求先带 response_format；失败后去掉该参数重试一次并缓存
  if (json) {
    try {
      return await callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, true, contentParts, maxTokens, temperature);
    } catch (firstErr: any) {
      const firstMsg = String(firstErr?.message ?? '');
      // 429 / 1015 再打一轮只会加重限流，直接抛给上层
      if (isRateLimitMessage(firstMsg) || isCloudflareEndpointBlock(firstMsg)) {
        throw firstErr;
      }
      console.error(`[callAI] 带 response_format 调用失败（${firstMsg || '未知错误'}），去掉该参数重试`);
      const retry = await callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, false, contentParts, maxTokens, temperature);
      skipResponseFormatModels.add(responseFormatKey);
      return retry;
    }
  }

  // json=false（纯文本）：原样请求
  return callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, false, contentParts, maxTokens, temperature);
}

/** 多端点调度：按"谁先解封"排班逐个尝试。全部端点被 1015 封住且最早解封超出
 *  就地等待预算时，一个请求都不打，直接回报精确秒数给前端倒计时。 */
async function callAIEndpoints(
  apiKey: string,
  baseUrl: string | string[],
  model: string,
  systemPrompt: string,
  userPrompt: string,
  json: boolean,
  contentParts?: ContentPart[],
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const urls = orderEndpoints(baseUrl);
  if (urls.length === 0) throw new Error('未配置 AI 接口地址');

  let lastError: UpstreamError | null = null;
  let lastRetryAfterSec: number | null = null;
  let waits = 0;

  for (;;) {
    const order = orderEndpoints(urls);

    const remaining = order.map(u => banRemainingSec(u));
    if (remaining.every(s => s > 0)) {
      const soonest = Math.min(...remaining);
      if (soonest * 1000 > EDGE_WAIT_BUDGET_MS) {
        console.error(`[callAI] 所有端点均在封堵期（最早解封还需 ${soonest}s），不浪费请求，直接回报`);
        const err: UpstreamError = new Error(`AI API error 429: error code: 1015 (retry-after ${soonest})`);
        err.retryAfterSec = soonest;
        throw err;
      }
      await sleep(soonest * 1000 + 300);
    }

    let allEdgeBlocked = true;
    let soonestOfRound: { url: string; sec: number } | null = null;

    for (const url of order) {
      try {
        const result = await callAIFetch(apiKey, url, model, systemPrompt, userPrompt, json, contentParts, maxTokens, temperature);
        if (result && result.trim()) return result;
        console.error(`[callAI] 端点 ${url} 返回空内容（HTTP 200），尝试下一端点`);
        lastError = new Error(`AI 返回空内容（${url}）`);
        allEdgeBlocked = false;
      } catch (err: any) {
        const e = err as UpstreamError;
        lastError = e instanceof Error ? e : new Error(String(err));
        const msg = lastError.message;

        if (isCloudflareEndpointBlock(msg)) {
          const sec = aiRetryAfterSec(e);
          if (sec !== null) {
            banEndpoint(url, sec);
            lastRetryAfterSec = lastRetryAfterSec === null ? sec : Math.min(lastRetryAfterSec, sec);
            if (!soonestOfRound || sec < soonestOfRound.sec) soonestOfRound = { url, sec };
          }
          console.error(`[callAI] 端点 ${url} 被 Cloudflare 限流（1015）retry-after=${sec === null ? '未提供' : sec + 's'}`);
          continue;
        }

        allEdgeBlocked = false;

        // 账户 RPM：额度问题，换端点无效；短等后同端点再打一次
        if (isRateLimitMessage(msg)) {
          const sec = aiRetryAfterSec(e);
          await sleep(sec === null ? 1000 : Math.min(sec * 1000 + 300, 5000));
          try {
            const retry = await callAIFetch(apiKey, url, model, systemPrompt, userPrompt, json, contentParts, maxTokens, temperature);
            if (retry && retry.trim()) return retry;
          } catch (retryErr: any) {
            lastError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          }
          throw lastError;
        }
      }
    }

    if (!allEdgeBlocked) break;

    const soonestSec = soonestOfRound?.sec ?? null;
    waits++;
    if (soonestSec === null || soonestSec * 1000 > EDGE_WAIT_BUDGET_MS || waits > EDGE_WAIT_MAX_TIMES) {
      console.error('[callAI] 全部端点 1015，超出就地等待预算，快速失败交给前端倒计时');
      break;
    }
    const delayMs = soonestSec * 1000 + 300 + Math.floor(Math.random() * 300);
    console.error(`[callAI] 全部端点 1015，等 ${delayMs}ms 后重试（第 ${waits} 次）`);
    await sleep(delayMs);
  }

  console.error(`[callAI] 端点全部失败：${lastError?.message}`);
  const finalErr: UpstreamError = lastError ?? new Error('AI 调用失败');
  if (lastRetryAfterSec !== null) finalErr.retryAfterSec = lastRetryAfterSec;
  throw finalErr;
}

/** 单端点实际请求（一次 /chat/completions 调用） */
async function callAIFetch(
  apiKey: string,
  endpointUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  json: boolean,
  contentParts?: ContentPart[],
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  // 多模态请求：content 为图片/文本 parts 数组
  const userContent: any = contentParts && contentParts.length > 0
    ? contentParts
    : userPrompt;

  try {
    const url = `${endpointUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: userContent },
        ],
        temperature: temperature ?? (json ? 0.3 : 0.7),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const retryAfterRaw = resp.headers.get('retry-after');
      const retryAfterSec = retryAfterRaw === null ? NaN : parseInt(retryAfterRaw, 10);
      const diag = ['cf-ray', 'cf-mitigated', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']
        .map(h => { const v = resp.headers.get(h); return v ? `${h}=${v}` : ''; })
        .filter(Boolean).join(' ');
      console.error(`[callAI] ${url} → HTTP ${resp.status}${diag ? ' | ' + diag : ''} | ${errText.slice(0, 120)}`);
      const err: UpstreamError = new Error(`AI API error ${resp.status}: ${errText}`);
      if (Number.isFinite(retryAfterSec) && retryAfterSec >= 0) err.retryAfterSec = retryAfterSec;
      throw err;
    }

    const data: any = await resp.json();
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/** 尝试从 AI 返回中解析 JSON（容错）*/
export function extractJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* continue */ }
  }

  throw new Error('AI 返回内容无法解析为 JSON');
}
