// ============================================================
// preclean.ts — 跨模型第二意见预清洗（第9轮注入纵深）
// ============================================================
// 单检测器漏检 = 零响应：无 span → 无 B 版盲评 → 无标记 → 无硬化，注入直达评分采样
// （LongCat/免费档实测可抬分，2026-11-06 用户反馈）。本文件在既有车道检测器之外，
// 用 agnes 免费模型按另一套措辞再检一遍（ensemble）：longcat/付费/BYOK 车道是跨模型
// 第二意见；free 车道与既有检测器同模型，靠 PRECLEAN 提示词的变体侧重补盲区。
// 恒走 agnes——longcat 限时限量免费，不作为防线依赖。
// 产物与语义检测器同契约：spans 逐字校验后并入既有 mark / redact / harden 响应链，
// 本层自身绝不拦截、绝不改写正文（清洗 = 检出 + 标记，不是重写——重写会摧毁 quote
// 逐字校验基准，且重写产物本身不可验证）。
// 失败（限流 / 超时 / 解析失败）一律 fail-open 跳过：免费模型不变成自断服务的单点。
// ============================================================

import { callAI, extractJSON, type AICallOpts, type AIResult } from './ai';
import { validateVerbatimSpans, type InjectionSpan } from './injection';
import { PRECLEAN_SYSTEM_PROMPT, buildSemanticDetectUser } from './prompts';
import type { ApiConfig } from '../types';

export interface PreCleanOutcome {
  /** false = 上游调用失败（fail-open，调用方按"无检测"处理并记审计） */
  ok: boolean;
  spans: InjectionSpan[];
  usage?: AIResult['usage'];
}

/** 预清洗输出的解析 + 逐字校验（纯函数，CI 可测）：清洗器的输出本身不可信——
 *  被注入的清洗器可以指认任意正文段落，只收能在原文逐字（或空白归一后）定位的片段。
 *  extractJSON 对垃圾输出是 throw 而非返回 null（限流打穿/网关剥空 body 也走这里），
 *  本函数吞掉解析异常返回空——调用方拿到的 spans 恒可用。 */
export function parsePreCleanSpans(text: string, content: string): InjectionSpan[] {
  try {
    return validateVerbatimSpans(text, extractJSON(content)?.spans);
  } catch {
    return [];
  }
}

/** 对单个不可信文本通道跑一次预清洗检测。绝不 throw（fail-open 契约）。 */
export async function preCleanChannel(
  cfg: ApiConfig,
  text: string,
  opts: { deadline: number; aiOpts?: AICallOpts },
): Promise<PreCleanOutcome> {
  try {
    const raw = await callAI(
      cfg.key, cfg.baseUrl, cfg.model,
      PRECLEAN_SYSTEM_PROMPT, buildSemanticDetectUser(text),
      true, undefined, 400, 0.1,
      opts.deadline, opts.aiOpts,
    );
    return { ok: true, spans: parsePreCleanSpans(text, raw.content), usage: raw.usage };
  } catch (err) {
    console.error('[preclean] 预清洗失败（跳过）:', err instanceof Error ? err.message : err);
    return { ok: false, spans: [] };
  }
}
