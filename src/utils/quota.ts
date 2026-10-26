// ============================================================
// quota.ts — 批改次数额度（业务层 · 成功计数）
// ============================================================
// 与 billing 的分工：
//   billing  = 钱（钱包 / 预扣 / 付费档 / BYOK），调 hold 时带 skipQuota 直通免费档；
//   本模块   = 次数（口径是「**成功**批改 N 次」，失败不计数）。
// 计数写入 quota_events，只在拿到合法批改结果并落库前 +1。
//
// 规则：
//   游客（未登录，设备 cookie 标识）：每天 3 次，且必须是「当天唯一一篇作文的
//        一稿/二稿/三稿」——每篇最多 3 稿、每稿最多成功批改 1 次。
//   登录用户：每天 10 次。
//   付费通道（DeepSeek/积分）与自备 Key：按量计费，不占免费次数。
// ============================================================

import type { D1Database } from '@cloudflare/workers-types';

export const GUEST_DAILY_REVIEWS = 3;
export const MEMBER_DAILY_REVIEWS = 10;

/** 游客额外约束：每天 1 篇、每篇最多 3 稿；每日 OCR 3 次（仅百度通道） */
export const GUEST_DAILY_ESSAYS = 1;
export const GUEST_MAX_DRAFTS = 3;
export const GUEST_DAILY_OCR = 3;

/** 北京日期（与 billing 的 periodKey 同口径，避免跨时区跨日错位） */
export function beijingDay(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export type QuotaScope = 'guest' | 'member';
export type QuotaKind = 'review' | 'ocr';

export interface QuotaState {
  scope: QuotaScope;
  day: string;
  /** 免费通道每日批改次数上限 */
  limit: number;
  used: number;
  remaining: number;
  /** 游客专属约束（登录用户为 null / false） */
  essay_limit: number | null;
  essay_used: number | null;
  draft_limit: number | null;
  per_draft_once: boolean;
}

export interface GateFailure {
  ok: false;
  status: 403 | 409 | 429;
  code: string;
  error: string;
}
export type GateResult = { ok: true; state: QuotaState } | GateFailure;

// ── 计数查询 ──

async function usedCount(db: D1Database, userId: string, day: string, kind: QuotaKind): Promise<number> {
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM quota_events WHERE user_id = ? AND day = ? AND kind = ?',
  ).bind(userId, day, kind).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 游客今日已建作文数（created_at 存 UTC，按 +8h 归到北京日期） */
async function essaysToday(db: D1Database, userId: string, day: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM essays WHERE user_id = ? AND date(created_at, '+8 hours') = ?",
  ).bind(userId, day).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 该稿是否已经有成功批改记录（游客「每稿只能一次」的判据） */
async function draftReviewed(db: D1Database, userId: string, draftId: number): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 AS x FROM quota_events WHERE user_id = ? AND draft_id = ? AND kind = 'review' LIMIT 1",
  ).bind(userId, draftId).first();
  return !!row;
}

// ── 对外：额度状态（前端展示 + 门禁判定共用）──

export async function quotaState(db: D1Database, userId: string, isGuest: boolean): Promise<QuotaState> {
  const day = beijingDay();
  const used = await usedCount(db, userId, day, 'review');
  const limit = isGuest ? GUEST_DAILY_REVIEWS : MEMBER_DAILY_REVIEWS;
  return {
    scope: isGuest ? 'guest' : 'member',
    day,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    essay_limit: isGuest ? GUEST_DAILY_ESSAYS : null,
    essay_used: isGuest ? await essaysToday(db, userId, day) : null,
    draft_limit: isGuest ? GUEST_MAX_DRAFTS : null,
    per_draft_once: isGuest,
  };
}

// ── 对外：成功计数 ──

/** 只在「成功」后调用；失败路径绝不调用 */
export async function recordSuccess(
  db: D1Database, userId: string, kind: QuotaKind,
  essayId?: number | null, draftId?: number | null,
): Promise<void> {
  await db.prepare(
    'INSERT INTO quota_events (user_id, day, kind, essay_id, draft_id) VALUES (?, ?, ?, ?, ?)',
  ).bind(userId, beijingDay(), kind, essayId ?? null, draftId ?? null).run();
}

// ── 对外：门禁 ──

/**
 * 批改前门禁。lane 为 'free' 时才受次数限制；
 * 付费(BYOK/DeepSeek) 只返回状态，不做次数判定。
 */
export async function checkReviewGate(
  db: D1Database, userId: string, isGuest: boolean,
  opts: { lane: string; draftId: number },
): Promise<GateResult> {
  const state = await quotaState(db, userId, isGuest);
  if (opts.lane !== 'free') return { ok: true, state };

  if (isGuest && await draftReviewed(db, userId, opts.draftId)) {
    return {
      ok: false, status: 403, code: 'guest_draft_reviewed',
      error: '这稿已经批改过了。写下一篇（二稿/三稿）才能再批改——游客每天 3 次，一稿、二稿、三稿各一次。',
    };
  }
  if (state.used >= state.limit) {
    return isGuest
      ? {
        ok: false, status: 403, code: 'guest_quota_exhausted',
        error: `游客每天 ${GUEST_DAILY_REVIEWS} 次免费批改（一稿、二稿、三稿各一次）已用完，登录后每天 ${MEMBER_DAILY_REVIEWS} 次。`,
      }
      : {
        ok: false, status: 409, code: 'quota_exhausted',
        error: `今日 ${MEMBER_DAILY_REVIEWS} 次免费批改已用完。可切换「DeepSeek（积分）」或「我的 Key」，或明天再来。`,
      };
  }
  return { ok: true, state };
}

/** 游客建作文门禁：每天 1 篇 */
export async function checkEssayGate(
  db: D1Database, userId: string, isGuest: boolean,
): Promise<{ ok: true } | GateFailure> {
  if (!isGuest) return { ok: true };
  const used = await essaysToday(db, userId, beijingDay());
  if (used >= GUEST_DAILY_ESSAYS) {
    return {
      ok: false, status: 403, code: 'guest_essay_limit',
      error: `游客每天写 ${GUEST_DAILY_ESSAYS} 篇（一稿、二稿、三稿共 3 次批改），今天这篇已经建好了；登录后不限篇数。`,
    };
  }
  return { ok: true };
}

/** 游客建稿门禁：每篇最多 3 稿（一稿/二稿/三稿） */
export async function checkDraftGate(
  db: D1Database, userId: string, isGuest: boolean, essayId: number, nextVersion: number,
): Promise<{ ok: true } | GateFailure> {
  if (!isGuest) return { ok: true };
  if (nextVersion > GUEST_MAX_DRAFTS) {
    return {
      ok: false, status: 403, code: 'guest_draft_limit',
      error: `游客每篇最多 ${GUEST_MAX_DRAFTS} 稿（一稿/二稿/三稿），登录后可继续写四稿、五稿。`,
    };
  }
  const day = beijingDay();
  const otherEssays = await db.prepare(
    "SELECT COUNT(*) AS n FROM essays WHERE user_id = ? AND id <> ? AND date(created_at, '+8 hours') = ?",
  ).bind(userId, essayId, day).first<{ n: number }>();
  if ((otherEssays?.n ?? 0) > 0) {
    return {
      ok: false, status: 403, code: 'guest_essay_limit',
      error: '游客每天只能写一篇作文，登录后可以同时写多篇。',
    };
  }
  return { ok: true };
}

/** 游客 OCR 门禁：仅百度通道 + 每天 3 次；登录用户走 billing 的 ocr:baidu 额度 */
export async function checkGuestOcrGate(
  db: D1Database, userId: string, isGuest: boolean, mode: string,
): Promise<{ ok: true } | GateFailure> {
  if (!isGuest) return { ok: true };
  if (mode !== 'baidu') {
    return {
      ok: false, status: 403, code: 'login_required',
      error: '大模型视觉识别需要登录后使用；游客可先用「百度 OCR」识别手写稿。',
    };
  }
  const used = await usedCount(db, userId, beijingDay(), 'ocr');
  if (used >= GUEST_DAILY_OCR) {
    return {
      ok: false, status: 403, code: 'guest_ocr_limit',
      error: `游客每天 ${GUEST_DAILY_OCR} 次图片识别，今天已用完；登录后每天 5 次且可用大模型识别。`,
    };
  }
  return { ok: true };
}
