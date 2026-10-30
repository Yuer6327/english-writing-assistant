// 共享的图片与多模态输入限制。
export const MAX_IMAGES = 3;
export const MAX_IMAGE_CHARS = 400_000;

/** 通用多模态图片估值（每张） */
export const IMAGE_TOKEN_ESTIMATE = 1600;
/** DeepSeek 官方文档：每张图片消耗 token 上限 1024 */
export const DEEPSEEK_IMAGE_TOKEN_ESTIMATE = 1024;

/** 图片 token 按张估算，不能按 base64 字符数折算。 */
export function estimateImageTokens(
  images: string[],
  provider?: string,
  model?: string,
): number {
  const isDeepSeek = provider === 'deepseek' || /deepseek/i.test(model ?? '');
  return images.length * (isDeepSeek ? DEEPSEEK_IMAGE_TOKEN_ESTIMATE : IMAGE_TOKEN_ESTIMATE);
}

/**
 * 文本 token 估算（预扣冻结额用）。
 * 旧口径 `chars / 3` 按英文经验值来的，对中文严重低估：DeepSeek 的中文约 0.6 token/字、
 * 英文约 0.25 token/字符。一篇 2 万字的中文作文按 /3 只冻结 6.7k tokens，实际 ~12k，
 * 差额走「结算补扣」把余额扣成负数 —— 平台默默吃亏。按 CJK/非 CJK 分别计价后，
 * 冻结额贴近真实成本；高估的部分 settle 时自动退差。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字 + 扩展 + 全角标点区间都按 0.6 token/字
    if (cp >= 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.6 + other / 4);
}
