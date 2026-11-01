// ============================================================
// ai.ts — AI 调用封装（OpenAI Chat Completions 格式）
// 复用自 english-reading-assistant 的通用调用层：
//   多端点 failover（按 Cloudflare 1015 的 retry-after 排班）、
//   response_format 兼容回退、超时、extractJSON 容错、错误中文化。
// 业务提示词见 prompts.ts；结果校验见 validate.ts。
// ============================================================

/** 单次 AI 请求超时（毫秒）；Cloudflare 客户端空闲超时约 100s，必须留出预算。
 *  40s 曾把 8000-token 的批改主调用（实测 33-70s 生成）掐成必现超时——提到 75s。
 *  流式调用（stream=true）不受此上限约束：字节持续流动，改用空闲超时（见 STREAM_IDLE_TIMEOUT_MS）。 */
const AI_TIMEOUT_MS = 75000;
/** 流式请求的空闲超时：超过该时长没有收到任何新 chunk 才判定连接死亡（每个 chunk 重置计时） */
const STREAM_IDLE_TIMEOUT_MS = 60000;
/** 单个批改等请求的全局时间预算（含 failover / 等待） */
const AI_TOTAL_BUDGET_MS = 90000;

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

/** 端点封堵到期时间（进程内，多 isolate 各记一份，够用且零依赖）。
 *  key 含任意 BYOK baseUrl，带容量上限防长命 isolate 缓慢膨胀（正常个位数）。 */
const endpointBanUntil = new Map<string, number>();

function banEndpoint(url: string, sec: number) {
  endpointBanUntil.set(url, Date.now() + sec * 1000);
  // 容量守卫：先清过期项，仍超限则丢弃最早的记录（封堵早已失效，丢了无害）
  if (endpointBanUntil.size > 100) {
    const now = Date.now();
    for (const [k, until] of endpointBanUntil) {
      if (until <= now) endpointBanUntil.delete(k);
    }
    while (endpointBanUntil.size > 100) {
      const oldest = endpointBanUntil.keys().next().value;
      if (oldest === undefined) break;
      endpointBanUntil.delete(oldest);
    }
  }
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
  if (/abort|timed? ?out|调用超时/i.test(raw)) {
    return 'AI 接口响应超时，请稍后重试';
  }
  const status = raw.match(/^AI API error (\d{3})/)?.[1];
  if (status === '400' || status === '401' || status === '403') {
    return 'AI 配置无效或已被上游拒绝，请到「设置」检查模型、接口地址和 Key';
  }
  if (status === '500' || status === '502' || status === '503' || status === '504') {
    return 'AI 接口暂时不可用，请稍后重试';
  }
  console.error('[ai] 未分类错误（仅日志保留原文）:', raw);
  return 'AI 调用失败，请稍后重试';
}

/** contentPart 类型：文本 / 图片 data URL */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

/** callAI 返回值：内容 + 成功那次的 token 用量（计费结算用）。
 *  缓存命中/未命中是 DeepSeek 的实际计费维度（命中价远低于未命中），逐次透传给结算。 */
export interface AIResult {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/** 统一调用 AI，带超时。json=true 时要求返回 JSON。contentParts 存在时走多模态（手写 OCR / 看图批改）。
 *  temperature 显式覆盖默认温度（json 0.3 / 纯文本 0.7）。
 *  多端点/重试路径透传"成功那次"的 usage（失败重试的中间成本不单独计费，吸收进加价倍率 N）。 */
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
  deadline: number = Date.now() + AI_TOTAL_BUDGET_MS,
): Promise<AIResult> {
  // json 请求带 response_format 仅是"强制输出 JSON"的开关。部分端点不支持该参数
  // （Agnes 文档未列出该字段），失败后去掉重试一次即可——提示词本身已强制"输出纯 JSON"。
  const responseFormatKey = `${model}@${Array.isArray(baseUrl) ? baseUrl.join(',') : baseUrl}`;
  const skipFormat = /^agnes-/i.test(model) || skipResponseFormatModels.has(responseFormatKey);

  if (json && skipFormat) {
    return callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, false, contentParts, maxTokens, temperature, deadline);
  }

  // 其余 json 请求先带 response_format；失败后去掉该参数重试一次并缓存
  if (json) {
    try {
      return await callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, true, contentParts, maxTokens, temperature, deadline);
    } catch (firstErr: any) {
      const firstMsg = String(firstErr?.message ?? '');
      // 限流、鉴权、配置和服务端错误重试 response_format 没有意义；
      // abort/超时同理——不是参数问题，回退重试只会再烧一次上游计费（2026-11-01 故障复盘）。
      if (isRateLimitMessage(firstMsg) || isCloudflareEndpointBlock(firstMsg)
        || /^AI API error (401|403|404|5\d\d)/.test(firstMsg) || /abort|timed? ?out/i.test(firstMsg)) {
        throw firstErr;
      }
      console.error(`[callAI] 带 response_format 调用失败（${firstMsg || '未知错误'}），去掉该参数重试`);
      const retry = await callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, false, contentParts, maxTokens, temperature, deadline);
      // 容量守卫：key 含任意 BYOK model@baseUrl，长命 isolate 下防缓慢膨胀
      if (skipResponseFormatModels.size >= 200) skipResponseFormatModels.clear();
      skipResponseFormatModels.add(responseFormatKey);
      return retry;
    }
  }

  // json=false（纯文本）：原样请求
  return callAIEndpoints(apiKey, baseUrl, model, systemPrompt, userPrompt, false, contentParts, maxTokens, temperature, deadline);
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
  deadline: number = Date.now() + AI_TOTAL_BUDGET_MS,
): Promise<AIResult> {
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
      // 入口就地等待同样受 deadline 与等待次数约束：否则「入口短睡 → 全 1015 → 尾部短睡 →
      // 入口短睡…」的节奏会让 deadline 检查被跳过，最坏在 90s 预算外再多睡一轮，
      // 响应总时长越过 ~100s 边缘空闲超时 → 用户拿到网关错误页而非本应回传的 429 JSON。
      const waitMs = soonest * 1000 + 300;
      if (Date.now() + waitMs > deadline) throw new Error('AI 调用超时');
      waits++;
      if (waits > EDGE_WAIT_MAX_TIMES) break;
      console.error(`[callAI] 所有端点均在封堵期，就地等 ${waitMs}ms（第 ${waits} 次等待）`);
      await sleep(waitMs);
    }

    let allEdgeBlocked = true;
    let soonestOfRound: { url: string; sec: number } | null = null;

    for (const url of order) {
      if (Date.now() >= deadline) throw new Error('AI 调用超时');
      try {
        const result = await callAIFetch(apiKey, url, model, systemPrompt, userPrompt, json, contentParts, maxTokens, temperature, deadline);
        if (result.content && result.content.trim()) return result;
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
            const retry = await callAIFetch(apiKey, url, model, systemPrompt, userPrompt, json, contentParts, maxTokens, temperature, deadline);
            if (retry.content && retry.content.trim()) return retry;
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
        if (Date.now() + delayMs > deadline) throw new Error('AI 调用超时');
    console.error(`[callAI] 全部端点 1015，等 ${delayMs}ms 后重试（第 ${waits} 次）`);
    await sleep(delayMs);
  }

  console.error(`[callAI] 端点全部失败：${lastError?.message}`);
  const finalErr: UpstreamError = lastError ?? new Error('AI 调用失败');
  if (lastRetryAfterSec !== null) finalErr.retryAfterSec = lastRetryAfterSec;
  throw finalErr;
}

/**
 * 流式版 AI 调用（SSE）：字节持续流动，长生成（大 JSON / 长文）不再受单请求 40-75s 超时
 * 与边缘 ~100s 空闲限制的掐杀——空闲超过 STREAM_IDLE_TIMEOUT_MS 才判定连接死亡。
 * usage 取自末块（stream_options.include_usage）；参数不支持（400/404/415）时自动回退
 * 非流式重试一次（并记忆 skipFormat）；限流/鉴权/5xx/abort 照常上抛，由调用方既定语义处理。
 */
export async function callAIStreaming(
  apiKey: string,
  baseUrl: string | string[],
  model: string,
  systemPrompt: string,
  userPrompt: string,
  json: boolean = true,
  contentParts?: ContentPart[],
  maxTokens?: number,
  temperature?: number,
  deadline: number = Date.now() + AI_TOTAL_BUDGET_MS,
): Promise<AIResult> {
  const formatKey = `${model}@${Array.isArray(baseUrl) ? baseUrl.join(',') : baseUrl}`;
  const useFormat = json && !/^agnes-/i.test(model) && !skipResponseFormatModels.has(formatKey);

  const streamOnce = async (endpointUrl: string, withFormat: boolean): Promise<AIResult> => {
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
    };
    armIdle();
    try {
      const url = `${endpointUrl.replace(/\/$/, '')}/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: contentParts && contentParts.length > 0 ? contentParts : userPrompt },
          ],
          temperature: temperature ?? 0.3,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
          ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        const err: UpstreamError = new Error(`AI API error ${resp.status}: ${errText}`);
        const retryAfterRaw = resp.headers.get('retry-after');
        if (retryAfterRaw !== null) err.retryAfterSec = parseInt(retryAfterRaw, 10);
        throw err;
      }
      if (!resp.body) throw new Error('流式响应缺少 body');

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let content = '';
      let usage: AIResult['usage'];
      let done = false;
      for (;;) {
        const { done: rdDone, value } = await reader.read();
        if (rdDone) break;
        if (Date.now() >= deadline) { controller.abort(); throw new Error('AI 调用超时'); }
        armIdle();
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { done = true; continue; }
          try {
            const j = JSON.parse(payload);
            if (j.usage && typeof j.usage.prompt_tokens === 'number') {
              usage = {
                prompt_tokens: j.usage.prompt_tokens,
                completion_tokens: j.usage.completion_tokens ?? 0,
              };
            }
            const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.text ?? '';
            if (delta) content += delta;
          } catch { /* 单帧解析失败忽略（SSE 容错） */ }
        }
        if (done) break;
      }
      if (!content.trim()) throw new Error(`AI 返回空内容（${endpointUrl}）`);
      return { content, usage };
    } catch (err: any) {
      if (/abort/i.test(String(err?.message ?? '')) && Date.now() < deadline) {
        throw new Error(`AI 流式连接空闲超时（${STREAM_IDLE_TIMEOUT_MS / 1000}s 无数据）`);
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  const urls = orderEndpoints(baseUrl);
  if (urls.length === 0) throw new Error('未配置 AI 接口地址');
  let lastError: Error | null = null;
  for (const url of urls) {
    if (Date.now() >= deadline) throw new Error('AI 调用超时');
    try {
      return await streamOnce(url, useFormat);
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      lastError = err instanceof Error ? err : new Error(msg);
      // 参数不支持（常见于代理/模型不认 response_format 或 stream）：记忆并回退非流式
      if (/^AI API error (400|415|422)/.test(msg)) {
        skipResponseFormatModels.add(formatKey);
        console.error(`[callAI] 流式参数不被支持（${msg.slice(0, 80)}），回退非流式`);
        return callAI(apiKey, baseUrl, model, systemPrompt, userPrompt, json, contentParts, maxTokens, temperature, deadline);
      }
      // 限流/鉴权/模型不存在/服务端错误：换端点也无济于事，立即上抛（与 callAIEndpoints 同语义）
      if (isRateLimitMessage(msg) || isCloudflareEndpointBlock(msg) || /^AI API error (401|403|404|5\d\d)/.test(msg)) {
        throw err;
      }
      // 其余（网络抖动等）：换下一端点
      console.error(`[callAI] 流式端点 ${url} 失败（${msg.slice(0, 80)}），尝试下一端点`);
    }
  }
  throw lastError ?? new Error('AI 流式调用失败');
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
  deadline: number = Date.now() + AI_TOTAL_BUDGET_MS,
): Promise<AIResult> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(AI_TIMEOUT_MS, deadline - Date.now()));
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
    // usage 逐字段宽松解析：上游各自的缓存拆分字段名不一（DeepSeek 顶层 *cache*_tokens，
    // OpenAI 系在 prompt_tokens_details.cached_tokens），拿得到就透传，拿不到不阻塞计费
    const usage = data.usage && typeof data.usage.prompt_tokens === 'number'
      ? (() => {
        const u = data.usage;
        const hit = typeof u.prompt_cache_hit_tokens === 'number' ? u.prompt_cache_hit_tokens
          : typeof u.prompt_tokens_details?.cached_tokens === 'number' ? u.prompt_tokens_details.cached_tokens
          : undefined;
        const miss = typeof u.prompt_cache_miss_tokens === 'number' ? u.prompt_cache_miss_tokens
          : hit !== undefined && typeof u.prompt_tokens === 'number' ? u.prompt_tokens - hit
          : undefined;
        return {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: u.completion_tokens ?? 0,
          ...(hit !== undefined && hit >= 0 ? { prompt_cache_hit_tokens: hit } : {}),
          ...(miss !== undefined && miss >= 0 ? { prompt_cache_miss_tokens: miss } : {}),
        };
      })()
      : undefined;
    return { content: data.choices?.[0]?.message?.content ?? '', usage };
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
