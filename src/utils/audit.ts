// ============================================================
// audit.ts — 注入命中审计与累计门禁（F3）
// ============================================================
// 威胁模型：学生本人是攻击者，可每天换写法重试。单次防线（规则/shadow/硬顶）
// 挡住"这一次"，本模块把"偶尔成功"变回"必然不成功"：
//   近 7 天内 reviews.meta 里出现 ≥3 次 high 级命中 → 该用户后续所有批改
//   强制 harden（分数硬顶 ≤8/≤8/≤3 + 采样取最小值），无论当前稿是否干净。
// 设计约束（README/工单明确要求）：
//   · 只做"强制硬化 + 留痕"，不拒评、不扣次数、不封号（教育产品误伤代价大）；
//   · 查询必须在 billing.hold 之前（hold 后早退会留冻结额度，项目踩过）；
//   · 零新表：meta 已在存、user_flags 现成（复合主键 user_id+flag，插行即幂等）。
// ============================================================

import type { D1Database } from '@cloudflare/workers-types';

/** 近 N 天高置信注入命中次数（正文/题面/题图任一通道判 high 即计；
 *  另计 shadow 盲评裁决生效的稿子——那是"注入确认生效才交付"的更强信号，
 *  只走 suspicious/clean 稳态的攻击者同样逃不掉）。 */
export async function countHighInjectionHits(
  db: D1Database, userId: string, days = 7,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM reviews
      WHERE user_id = ?
        AND created_at > datetime('now', ?)
        AND ( json_extract(meta, '$.injection.essay.level') = 'high'
           OR json_extract(meta, '$.injection.topic.level') = 'high'
           OR json_extract(meta, '$.injection.image.level') = 'high'
           OR json_extract(meta, '$.injection.shadow.used') = 1 )`,
  ).bind(userId, `-${days} days`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 强制硬化标记的自愈窗口：打标后 30 天内快路径直通；窗口内无新命中则过期，
 *  重新走滚动计数评估（教育产品"不封号"定位——误标记必须有恢复路径，终判 P1-2）。 */
export const FORCED_HARDEN_TTL_DAYS = 30;

/** 记录/刷新"强制硬化"标记（user_flags 复合主键；确认触发时刷新时间戳维持 TTL 滑动）。 */
export async function markForcedHarden(db: D1Database, userId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO user_flags (user_id, flag) VALUES (?, 'forced_harden')
       ON CONFLICT (user_id, flag) DO UPDATE SET updated_at = datetime('now')`,
  ).bind(userId).run();
}

export async function hasUserFlag(
  db: D1Database, userId: string, flag: string,
  opts?: { maxAgeDays?: number },
): Promise<boolean> {
  const age = opts?.maxAgeDays;
  const row = age
    ? await db.prepare(
      `SELECT 1 AS x FROM user_flags
        WHERE user_id = ? AND flag = ? AND updated_at > datetime('now', ?) LIMIT 1`,
    ).bind(userId, flag, `-${age} days`).first()
    : await db.prepare(
      'SELECT 1 AS x FROM user_flags WHERE user_id = ? AND flag = ? LIMIT 1',
    ).bind(userId, flag).first();
  return !!row;
}

/**
 * F3 门禁：近 7 天 ≥3 次命中（high 或盲评裁决生效）→ 强制硬化。
 * 已打标的用户走 user_flags 快路径（跳过计数查询；标记带 {@link FORCED_HARDEN_TTL_DAYS}
 * 自愈窗口，过期后重新按计数评估）。查询失败 fail-open（返回 false，不阻塞批改——
 * 这层是加重防线，不是可用性边界）。
 */
export async function shouldForceHarden(db: D1Database, userId: string): Promise<boolean> {
  try {
    if (await hasUserFlag(db, userId, 'forced_harden', { maxAgeDays: FORCED_HARDEN_TTL_DAYS })) {
      return true;
    }
    const hits = await countHighInjectionHits(db, userId);
    if (hits < 3) return false;
    await markForcedHarden(db, userId);
    return true;
  } catch (err) {
    console.error('[audit] 注入累计查询失败（fail-open）:', err instanceof Error ? err.message : err);
    return false;
  }
}
