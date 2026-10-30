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
