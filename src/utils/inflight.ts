// ============================================================
// inflight.ts — heavy 请求并发锁（同用户在飞 1 笔）
// 模块级 Map（Workers 每 isolate 各一份，近似保护够用）；
// 免费档与付费档占用，BYOK 不占。TTL 防 isolate 异常终止后永久残留。
// ============================================================

const inflight = new Map<string, { ts: number; token: string }>();
const LOCK_TTL_MS = 3 * 60_000;

export function tryAcquire(userId: string): string | null {
  const current = inflight.get(userId);
  if (current && Date.now() - current.ts < LOCK_TTL_MS) return null;
  const token = crypto.randomUUID();
  inflight.set(userId, { ts: Date.now(), token });
  return token;
}

export function releaseSlot(userId: string, token: string | null): void {
  if (token && inflight.get(userId)?.token === token) inflight.delete(userId);
}
