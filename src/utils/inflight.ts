// ============================================================
// inflight.ts — heavy 请求并发锁（同用户在飞 1 笔）
// 模块级 Map（Workers 每 isolate 各一份，近似保护够用）；
// 仅 mode='hold'（预扣费）的 heavy 请求占用，免费/BYOK 不锁。
// ============================================================

const inflight = new Map<string, true>();

export function tryAcquire(userId: string): boolean {
  if (inflight.has(userId)) return false;
  inflight.set(userId, true);
  return true;
}

export function releaseSlot(userId: string): void {
  inflight.delete(userId);
}
