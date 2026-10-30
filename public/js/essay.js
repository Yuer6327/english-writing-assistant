// ============================================================
// essay.js — 作文工作台（swup 管理：导出 init/cleanup）
// 题目展示 / 稿件 Tabs / 新稿件（拍照OCR·输入·预填二稿）/
// 批改渲染（分数卡+原文高亮+问题卡）/ 片段精修 / 全文润色 / 导出
// ============================================================

import {
  api, toast, getSession, loginHref, escapeHtml, renderBold, formatBeijingTime, countWords,
  compressImageFile, gradeFor,
} from './api.js?v=20261027c';
import { openExportModal, closeExportModal } from './export.js?v=20261027c';

let generation = 0;
let state = null;            // { essay, drafts, polishes }
let activeDraftId = null;
let editingDraft = false;    // 稿件编辑模式
let selBtn = null;           // 选中片段的浮动精修按钮
let delegatedBound = false;  // document 级委托只绑一次（swup 重复进页不叠加）
const pendingOps = new Set(); // 跨重新渲染保持的写操作锁（防重复计费/提交）
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** 会话：游客（未登录）只能用免费通道批改，其余 AI 功能需登录 */
let isGuest = false;
let sessionQuota = null;
let sessionName = '';

function busyButton(btn, label, hint = '') {
  btn.dataset.idleHtml = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('btn-busy');
  btn.setAttribute('aria-label', hint ? `${label}，${hint}` : label);
  btn.title = hint;
  btn.innerHTML = `<span class="spinner spinner-sm"></span><span>${label}</span>${hint ? `<span class="busy-time">${hint}</span>` : ''}`;
}

function idleButton(btn) {
  btn.disabled = false;
  btn.classList.remove('btn-busy');
  btn.removeAttribute('title');
  btn.removeAttribute('aria-label');
  if (btn.dataset.idleHtml) btn.innerHTML = btn.dataset.idleHtml;
  delete btn.dataset.idleHtml;
}

/** 写操作在飞时锁住同一面板其它操作，避免切换 Tab 前的重复扣费/提交 */
function setPanelControlsLocked(anchor, locked) {
  anchor.closest('.card')?.querySelectorAll('button, select, input, textarea').forEach(el => {
    if (el !== anchor) el.disabled = locked;
  });
}

// ── 模型车道（free / deepseek / byok）：可用选项由 billing 决定 ──
const laneInfo = { paidEnabled: false, byokConfigured: false, loaded: false };
let reviewLane = null;       // 批改上次选择（内存记忆）
let polishLane = null;       // 精修上次选择
let lastCharge = null;       // { reviewId, points, lane } 本次批改消耗（renderReview 展示）

async function loadLaneInfo() {
  if (laneInfo.loaded) return;
  // 游客没有钱包/自备 Key，不去碰计费接口（那会 401 触发整页跳登录）
  if (isGuest) { laneInfo.loaded = true; return; }
  try {
    const me = await api.billing.me();
    laneInfo.paidEnabled = !!me.paid_enabled;
    laneInfo.byokConfigured = !!me.byok_configured;
    laneInfo.loaded = true;
  } catch { /* billing 不可用时仅显示免费通道 */ }
}

/** 默认车道：已配置我的 Key → byok，否则免费通道（与服务端默认规则一致） */
function defaultLane() {
  return laneInfo.byokConfigured && !isGuest ? 'byok' : 'free';
}

/** 剩余免费次数徽标文案 */
function remainingLabel() {
  if (!sessionQuota) return '';
  return `剩余 ${sessionQuota.remaining}/${sessionQuota.limit}`;
}

/** 模型选择 <select> HTML（id 唯一）；value 归一到合法车道 */
function modelSelectHtml(id, remembered) {
  if (isGuest) {
    return `<select class="form-input" id="${id}" aria-label="模型通道（游客仅免费通道）" style="width:auto;padding:4px 8px;font-size:13px" title="游客只能使用免费通道">
      <option value="free">免费通道 · ${escapeHtml(remainingLabel())}</option>
    </select>`;
  }
  const value = ['free', 'deepseek', 'byok'].includes(remembered)
    ? remembered : defaultLane();
  const opts = [
    `<option value="free"${value === 'free' ? ' selected' : ''}>免费通道（今日剩余 ${sessionQuota ? sessionQuota.remaining : '—'} 次）</option>`,
    laneInfo.paidEnabled
      ? `<option value="deepseek"${value === 'deepseek' ? ' selected' : ''}>DeepSeek（积分）</option>` : '',
    laneInfo.byokConfigured
      ? `<option value="byok"${value === 'byok' ? ' selected' : ''}>我的 Key（自备）</option>` : '',
  ].join('');
  return `<select class="form-input" id="${id}" aria-label="选择模型通道" style="width:auto;padding:4px 8px;font-size:13px">${opts}</select>`;
}

/** 选中积分档时的提示文案（选中 DeepSeek 时显示在按钮旁） */
const PAID_HINT = '约 0.05~0.5 积分/次 · 多退少补';

function bindPaidHint(selectEl, hintEl) {
  if (!selectEl || !hintEl) return;
  const sync = () => { hintEl.style.display = selectEl.value === 'deepseek' ? 'inline' : 'none'; };
  selectEl.addEventListener('change', sync);
  sync();
}

/** 402 余额不足弹窗（兑换/充值入口深链设置页） */
function showInsufficientBalance() {
  wbModal(`
    <div style="text-align:center;padding:8px 0">
      <div style="font-size:34px;margin-bottom:10px">😔</div>
      <div style="font-weight:600;font-size:16px;margin-bottom:14px">积分余额不足</div>
      <div class="chip-row" style="justify-content:center;margin-bottom:18px">
        <span class="chip">兑换码充值</span>
        <span class="chip">自备 Key</span>
        <span class="chip">免费额度</span>
      </div>
      <div style="display:flex;gap:10px;justify-content:center">
        <a class="btn btn-primary" href="/settings.html#billing" style="text-decoration:none">去充值</a>
        <button type="button" class="btn" id="btn-402-close">知道了</button>
      </div>
    </div>
  `, { title: '余额不足' });
  const closeBtn = document.getElementById('btn-402-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeWbModal());
}

/** 游客限制 / 需登录功能的统一引导弹窗 */
function showLoginPrompt(title, desc) {
  wbModal(`
    <div style="text-align:center;padding:8px 0">
      <div style="font-size:34px;margin-bottom:10px">🔓</div>
      <div style="font-weight:600;font-size:16px;margin-bottom:10px">${escapeHtml(title)}</div>
      <div style="font-size:13px;color:var(--text-soft);line-height:1.8;margin-bottom:16px">${escapeHtml(desc)}</div>
      <div class="chip-row" style="justify-content:center;margin-bottom:18px">
        <span class="chip">每天 10 次免费批改</span>
        <span class="chip">不限篇数 · 不限稿数</span>
        <span class="chip">精修 / 润色 / 大模型识别</span>
      </div>
      <div style="display:flex;gap:10px;justify-content:center">
        <a class="btn btn-primary" href="${loginHref()}" rel="nofollow" style="text-decoration:none">登录</a>
        <button type="button" class="btn" id="btn-login-cancel">知道了</button>
      </div>
    </div>
  `, { title });
  const closeBtn = document.getElementById('btn-login-cancel');
  if (closeBtn) closeBtn.addEventListener('click', () => closeWbModal());
}

const GUEST_LIMIT_CODES = new Set([
  'login_required', 'guest_quota_exhausted', 'guest_draft_reviewed',
  'guest_essay_limit', 'guest_draft_limit', 'guest_ocr_limit', 'guest_ip_limit',
]);

/** 统一错误分流：402 → 余额不足；游客受限 → 登录引导；返回 true 表示已处理 */
function handleBillingError(err) {
  if (!err) return false;
  if (err.code === 'insufficient_balance') {
    showInsufficientBalance();
    return true;
  }
  if (GUEST_LIMIT_CODES.has(err.code)) {
    showLoginPrompt(err.code === 'login_required' ? '登录后可用' : '游客额度提示', err.message);
    return true;
  }
  return false;
}

const cnNum = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function cleanup() {
  generation++;
  removeSelBtn();
  closeWbModal(null, true);
  closeExportModal();
  if (delegatedBound) {
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('touchend', onMouseUp);
    delegatedBound = false;
  }
}

export async function init() {
  const gen = ++generation;
  // 客服端软探测：游客也能进工作台（额度按「成功批改」由服务端计）
  const session = await getSession();
  if (!session || gen !== generation) return;
  isGuest = !session.logged_in;
  sessionQuota = session.quota || null;
  sessionName = session.username || '已登录';
  laneInfo.loaded = false;
  laneInfo.paidEnabled = false;
  laneInfo.byokConfigured = false;
  reviewLane = null;
  polishLane = null;
  lastCharge = null;

  const id = new URLSearchParams(location.search).get('id');
  if (!id) { window.swupNavigate('/'); return; }

  renderSessionBanner();
  // 车道信息与作文数据相互独立：并行拉取，统一确认后再渲染
  await reload(id, gen, loadLaneInfo());
  bindDelegated();
  resumePendingReview(id, gen);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 页面刷新后恢复在途批改：每 3s 拉一次详情，出现新结果即渲染 */
async function resumePendingReview(essayId, gen) {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('pending-review:'));
  for (const key of keys) {
    let marker = null;
    try { marker = JSON.parse(localStorage.getItem(key)); } catch { /* ignore */ }
    const draftId = Number(key.split(':')[1]);
    const draft = state?.drafts?.find(d => d.id === draftId);
    if (!marker || !draft || gen !== generation) { localStorage.removeItem(key); continue; }
    const opKey = `review:${draftId}`;
    if (pendingOps.has(opKey)) continue;
    pendingOps.add(opKey);
    activeDraftId = draftId;
    renderTabs(); renderDraftPanel(); renderReview();
    try {
      for (let i = 0; i < 60; i++) {
        await sleep(3000);
        if (gen !== generation) return;
        const data = await api.getEssay(essayId);
        if (gen !== generation) return;
        const latest = (data.drafts.find(x => x.id === draftId)?.reviews || []).at(-1);
        if (latest && latest.id !== marker.previous_review_id) {
          state = data;
          activeDraftId = draftId;
          renderHeader(); renderTopic(); renderTabs(); renderDraftPanel(); renderReview();
          toast('批改完成，结果已自动恢复', 'success');
          localStorage.removeItem(key);
          return;
        }
      }
    } catch { /* 下一轮继续 */ }
    finally {
      pendingOps.delete(opKey);
      if (gen === generation && activeDraftId === draftId) renderDraftPanel();
    }
  }
}

/** 顶部会话条：游客剩余次数 / 登录态剩余次数 */
function renderSessionBanner() {
  const el = document.getElementById('session-banner');
  if (!el) return;
  const q = sessionQuota;
  const chips = q
    ? (isGuest
      ? `<span class="chip accent">今日剩余 ${q.remaining}/${q.limit} 次批改</span>
         <span class="chip">一稿二稿三稿 · 每稿一次</span>`
      : `<span class="chip accent">今日剩余 ${q.remaining}/${q.limit} 次免费批改</span>
         <span class="chip">付费通道不计次</span>`)
    : '';
  el.innerHTML = isGuest
    ? `<div class="session-bar session-guest"><span class="session-who">游客试用</span>${chips}
         <a class="btn btn-primary btn-sm" href="${loginHref()}" rel="nofollow">登录（每天 10 次）</a></div>`
    : `<div class="session-bar"><span class="session-who">${escapeHtml(sessionName)}</span>${chips}</div>`;
}

// ============================================================
// 数据加载与整体渲染
// ============================================================
async function reload(essayId, gen = generation, beforeRender = null) {
  if (gen !== generation) return;
  const headerEl = document.getElementById('wb-header');
  if (headerEl) headerEl.innerHTML = '<div class="card"><span class="spinner"></span> 加载中...</div>';

  let data;
  try {
    // 可传入并行任务；两者都成功/自行兜底后才渲染，避免车道信息闪烁
    [data] = await Promise.all([api.getEssay(essayId), beforeRender]);
  } catch (err) {
    if (gen !== generation || !headerEl) return;
    headerEl.innerHTML = `<div class="card">加载失败：${escapeHtml(err.message)} <a href="/">返回列表</a></div>`;
    return;
  }
  if (gen !== generation) return;
  state = data;

  if (!activeDraftId || !state.drafts.find(d => d.id === activeDraftId)) {
    activeDraftId = state.drafts.length ? state.drafts[state.drafts.length - 1].id : null;
  }
  editingDraft = false;
  renderHeader();
  renderTopic();
  renderTabs();
  renderDraftPanel();
  renderReview();
}

function activeDraft() {
  return state.drafts.find(d => d.id === activeDraftId) || null;
}

function latestReview(draft) {
  if (!draft || !draft.reviews.length) return null;
  return draft.reviews[draft.reviews.length - 1];
}

// ── 头部：标题 + 操作 ──
function renderHeader() {
  const e = state.essay;
  document.getElementById('wb-header').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div>
        <div style="font-size:13px;color:var(--text-light);margin-bottom:4px"><a href="/">← 我的作文</a></div>
        <h1 style="font-size:22px" id="wb-title">${escapeHtml(e.title)}</h1>
        <div style="font-size:12px;color:var(--text-light);margin-top:4px">
          <span class="badge badge-completed">${escapeHtml(e.genre_label)}</span>
          满分 ${e.genre_total} 分 · 创建于 ${formatBeijingTime(e.created_at)}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap">
        ${isGuest
          ? `<button class="btn" id="btn-prompt" title="提示词按模式配置，登录后可编辑" style="padding:6px 14px;font-size:13px">批改提示词 🔒</button>`
          : `<button class="btn" id="btn-prompt" style="padding:6px 14px;font-size:13px">批改提示词</button>`}
        <button class="btn" id="btn-export" style="padding:6px 14px;font-size:13px">导出报告</button>
        <button class="btn" id="btn-delete-essay" style="padding:6px 14px;font-size:13px">删除作文</button>
      </div>
    </div>`;

  document.getElementById('btn-prompt').addEventListener('click', () => {
    if (isGuest) { showLoginPrompt('登录后可用', '提示词按模式单独配置。游客先用默认模板批改，登录后可自定义。'); return; }
    openPromptModal();
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    openExportModal({ mode: 'report', getData: () => buildReportPayload() });
  });
  document.getElementById('btn-delete-essay').addEventListener('click', async (ev) => {
    if (!confirm(`确定删除作文「${state.essay.title}」及其全部稿件、批改记录？`)) return;
    const gen = generation;
    const essayId = state.essay.id;
    const key = `delete-essay:${essayId}`;
    if (pendingOps.has(key)) return;
    pendingOps.add(key);
    busyButton(ev.currentTarget, '删除中');
    try {
      await api.deleteEssay(essayId);
      if (gen !== generation) return;
      toast('已删除', 'success');
      window.swupNavigate('/');
    } catch (err) {
      if (gen === generation) {
        toast(err.message, 'error');
        idleButton(ev.currentTarget);
      }
    } finally {
      pendingOps.delete(key);
    }
  });
}

// ── 题目区（可折叠）──
function renderTopic() {
  const e = state.essay;
  const imgs = (e.topic_images || []).map((u, i) => `
    <img src="${escapeHtml(u)}" alt="题目图片 ${i + 1}" style="max-width:100%;max-height:280px;border:1px solid var(--border);border-radius:var(--radius);margin-top:8px">`).join('');
  document.getElementById('wb-topic').innerHTML = `
    <details class="card" style="margin-bottom:16px" ${state.drafts.length ? '' : 'open'}>
      <summary style="cursor:pointer;font-weight:600;font-size:14px">题目</summary>
      <div style="margin-top:10px;font-size:14px;line-height:1.8;color:var(--text-soft);white-space:pre-wrap">${escapeHtml(e.topic_text)}</div>
      ${imgs ? `<div>${imgs}</div>` : ''}
    </details>`;
}

// ── 稿件 Tabs ──
function renderTabs() {
  const el = document.getElementById('wb-draft-tabs');
  if (!state.drafts.length) { el.innerHTML = ''; el.removeAttribute('role'); return; }
  el.setAttribute('role', 'tablist');
  el.setAttribute('aria-label', '稿件版本');
  el.innerHTML = state.drafts.map(d => {
    const rv = latestReview(d);
    const g = rv ? gradeFor(rv.result.score) : null;
    const active = d.id === activeDraftId;
    return `<button type="button" class="draft-tab ${active ? 'active' : ''}" data-tab="${d.id}"
      role="tab" aria-selected="${active ? 'true' : 'false'}" aria-controls="wb-draft-panel">
      ${cnNum[d.version - 1] || d.version}稿${rv ? `<span class="tab-score">${rv.result.score}${g ? ` · ${g.grade}` : ''}</span>` : ''}
    </button>`;
  }).join('') + '<button type="button" class="draft-tab draft-tab-add" id="tab-add">＋ 新稿件</button>';

  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    activeDraftId = +b.dataset.tab;
    editingDraft = false;
    renderTabs(); renderDraftPanel(); renderReview();
  }));
  el.querySelector('#tab-add').addEventListener('click', () => openDraftModal('text'));
}

// ── 稿件面板 ──
function renderDraftPanel() {
  const el = document.getElementById('wb-draft-panel');
  const d = activeDraft();
  if (!d) {
    el.innerHTML = `
      <div class="card" style="text-align:center;padding:32px;color:var(--text-soft)">
        还没有稿件。点击下方开始第一稿。
        <div style="margin-top:16px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-first-photo">📷 拍照/上传手写稿</button>
          <button class="btn" id="btn-first-text">✏️ 直接输入</button>
        </div>
      </div>`;
    el.querySelector('#btn-first-photo').addEventListener('click', () => openDraftModal('photo'));
    el.querySelector('#btn-first-text').addEventListener('click', () => openDraftModal('text'));
    return;
  }

  const rv = latestReview(d);
  const stale = rv && rv.reviewed_text && rv.reviewed_text !== d.text;
  const reviewPending = pendingOps.has(`review:${d.id}`);
  const rewritePending = pendingOps.has(`rewrite:${d.id}`);
  const deletePending = pendingOps.has(`delete-draft:${d.id}`);
  const sourceLabel = { photo: '拍照识别', text: '直接输入', polish: '精修/润色采纳' }[d.source] || d.source;
  const hwScore = d.handwriting_score !== null && d.handwriting_score !== undefined
    ? ` · 书写质量 ${(d.handwriting_score * 100).toFixed(0)}%` : '';
  // 游客限制：每篇最多 3 稿、无精修/润色/自定义提示词
  const draftLocked = isGuest && sessionQuota?.draft_limit !== null && sessionQuota?.draft_limit !== undefined
    && d.version >= sessionQuota.draft_limit;
  const rewriteLocked = isGuest;
  const reviewExhausted = !!sessionQuota && sessionQuota.remaining <= 0;

  el.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-light)">
          ${cnNum[d.version - 1] || d.version}稿 · ${sourceLabel} · ${d.word_count} 词${hwScore}
          ${rv ? ` · 批改于 ${formatBeijingTime(rv.created_at)}${d.reviews.length > 1 ? `（第 ${d.reviews.length} 次）` : ''}` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${editingDraft
            ? `<button class="btn btn-primary" id="btn-save-draft" style="padding:5px 12px;font-size:13px">保存稿件</button>
               <button class="btn" id="btn-cancel-edit" style="padding:5px 12px;font-size:13px">取消</button>`
            : `${modelSelectHtml('review-model-select', reviewLane)}
               <button class="btn btn-primary ${reviewPending ? 'btn-busy' : ''}" id="btn-review" style="padding:5px 12px;font-size:13px" ${reviewPending ? 'disabled title="预计约 1 分钟"' : (reviewExhausted ? 'title="今日免费次数已用完，点一下试试可切换的通道"' : '')}>${reviewPending ? '<span class="spinner spinner-sm"></span><span>批改中</span><span class="busy-time">约 1 分钟</span>' : (rv ? '重新批改' : '开始批改')}</button>
               <button class="btn" id="btn-edit-draft" style="padding:5px 12px;font-size:13px" ${reviewPending || rewritePending || deletePending ? 'disabled' : ''}>编辑稿件</button>
               <button class="btn" id="btn-new-draft" style="padding:5px 12px;font-size:13px" ${reviewPending || rewritePending || deletePending ? 'disabled' : ''} ${draftLocked ? 'title="游客每篇最多 3 稿，登录后可继续写"' : ''}>✍️ 写${cnNum[d.version] || d.version + 1}稿${draftLocked ? ' 🔒' : ''}</button>
               <button class="btn ${rewritePending ? 'btn-busy' : ''}" id="btn-rewrite" style="padding:5px 12px;font-size:13px" ${rewritePending ? 'disabled title="预计约 1 分钟"' : reviewPending || deletePending ? 'disabled' : ''} ${rewriteLocked ? 'title="全文润色需要登录"' : ''}>${rewritePending ? '<span class="spinner spinner-sm"></span><span>润色中</span><span class="busy-time">约 1 分钟</span>' : `全文润色${rewriteLocked ? ' 🔒' : ''}`}</button>
               <button class="btn" id="btn-del-draft" style="padding:5px 12px;font-size:13px" ${deletePending ? 'disabled' : ''}>${deletePending ? '删除中...' : '删除'}</button>
               <span id="review-paid-hint" class="muted" style="display:none;font-size:12px">${PAID_HINT}</span>`}
        </div>
      </div>
      ${stale ? '<div style="font-size:12px;color:#d64545;margin-bottom:8px">⚠ 稿件在上次批改后已修改，建议重新批改</div>' : ''}
      ${editingDraft
        ? `<textarea class="form-input" id="draft-editor" rows="14" style="font-size:15px;line-height:1.9">${escapeHtml(d.text)}</textarea>
           <div class="wordcount-hint" id="draft-wc" style="margin-top:6px"></div>`
        : `<div class="essay-annotated" id="draft-text-view">${renderAnnotated(d)}</div>
           <div style="margin-top:10px"><span class="chip">${isGuest ? '🔒 片段精修需登录' : '✨ 选中句子可精修'}</span></div>`}
    </div>`;

  if (editingDraft) {
    const ta = el.querySelector('#draft-editor');
    const wc = el.querySelector('#draft-wc');
    const updateWc = () => {
      const n = countWords(ta.value);
      const soft = state.essay.word_limits || { minWords: 200, maxWords: 500, softMinWords: 200, softMaxWords: 500 };
      wc.textContent = `${n} 词（考试要求 ${soft.minWords}-${soft.maxWords} 词）`;
      wc.className = 'wordcount-hint ' + (n >= soft.softMinWords && n <= soft.softMaxWords ? 'ok' : 'bad');
    };
    ta.addEventListener('input', updateWc);
    updateWc();
    el.querySelector('#btn-save-draft').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const text = ta.value.trim();
      if (text.length < 10) { toast('稿件内容过短', 'error'); return; }
      const gen = generation;
      const essayId = state.essay.id;
      busyButton(btn, '保存中');
      try {
        await api.updateDraft(d.id, text);
        if (gen !== generation) return;
        toast('稿件已保存', 'success');
        await reload(essayId, gen);
      } catch (err) {
        if (gen === generation) {
          toast(err.message, 'error');
          idleButton(btn);
        }
      }
    });
    el.querySelector('#btn-cancel-edit').addEventListener('click', () => {
      editingDraft = false; renderDraftPanel();
    });
  } else {
    bindPaidHint(el.querySelector('#review-model-select'), el.querySelector('#review-paid-hint'));
    el.querySelector('#btn-review').addEventListener('click', runReview);
    el.querySelector('#btn-edit-draft').addEventListener('click', () => { editingDraft = true; renderDraftPanel(); });
    el.querySelector('#btn-new-draft').addEventListener('click', () => {
      if (isGuest && sessionQuota?.draft_limit !== null && sessionQuota?.draft_limit !== undefined
        && d.version >= sessionQuota.draft_limit) {
        showLoginPrompt('登录后继续写', `游客每篇最多 ${sessionQuota.draft_limit} 稿（一稿、二稿、三稿）。登录后可继续写四稿、五稿，并保留全部历史。`);
        return;
      }
      openDraftModal('text', d.text);
    });
    el.querySelector('#btn-rewrite').addEventListener('click', runFullRewrite);
    el.querySelector('#btn-del-draft').addEventListener('click', async (ev) => {
      if (!confirm(`确定删除${cnNum[d.version - 1] || d.version}稿及其批改记录？`)) return;
      const gen = generation;
      const essayId = state.essay.id;
      const key = `delete-draft:${d.id}`;
      if (pendingOps.has(key)) return;
      pendingOps.add(key);
      busyButton(ev.currentTarget, '删除中');
      setPanelControlsLocked(ev.currentTarget, true);
      try {
        await api.deleteDraft(d.id);
        if (gen !== generation) return;
        toast('已删除', 'success');
        activeDraftId = null;
        await reload(essayId, gen);
      } catch (err) {
        if (gen === generation) {
          toast(err.message, 'error');
          idleButton(ev.currentTarget);
          setPanelControlsLocked(ev.currentTarget, false);
        }
      } finally {
        pendingOps.delete(key);
        if (gen === generation && !state.drafts.some(x => x.id === d.id)) return;
      }
    });
    bindIssueMarks(el);
  }
}

// ============================================================
// 原文高亮标注：quote 定位（原文 substring → 空白归一映射兜底）
// ============================================================
function buildNormMap(text) {
  const map = [];
  let norm = '';
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!lastSpace) { norm += ' '; map.push(i); lastSpace = true; }
    } else {
      norm += text[i]; map.push(i); lastSpace = false;
    }
  }
  while (norm.endsWith(' ')) { norm = norm.slice(0, -1); map.pop(); }
  return { norm, map };
}

function locateQuote(text, normInfo, quote) {
  let idx = text.indexOf(quote);
  if (idx >= 0) return { start: idx, end: idx + quote.length };
  const nq = quote.replace(/\s+/g, ' ').trim();
  const ni = normInfo.norm.indexOf(nq);
  if (ni >= 0) {
    const start = normInfo.map[ni];
    const end = normInfo.map[ni + nq.length - 1] + 1;
    return { start, end };
  }
  return null;
}

function renderAnnotated(draft) {
  const rv = latestReview(draft);
  const text = draft.text;
  if (!rv || !rv.result.issues || !rv.result.issues.length) {
    return escapeHtml(text);
  }
  const normInfo = buildNormMap(text);
  const spans = [];
  rv.result.issues.forEach((issue, i) => {
    if (issue.located === false) return;
    const loc = locateQuote(text, normInfo, issue.quote);
    if (loc) spans.push({ ...loc, issueIndex: i });
  });
  // 排序并去重叠
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const s of spans) {
    if (merged.length && s.start < merged[merged.length - 1].end) continue;
    merged.push(s);
  }
  let html = '';
  let pos = 0;
  for (const s of merged) {
    const issue = rv.result.issues[s.issueIndex] || {};
    const label = `第 ${s.issueIndex + 1} 处问题${issue.type ? `（${issue.type}）` : ''}，查看详解`;
    html += escapeHtml(text.slice(pos, s.start));
    html += `<span class="issue-mark" data-issue="${s.issueIndex}" role="button" tabindex="0" aria-label="${escapeHtml(label)}">${escapeHtml(text.slice(s.start, s.end))}</span>`;
    pos = s.end;
  }
  html += escapeHtml(text.slice(pos));
  return html;
}

function bindIssueMarks(el) {
  const jumpTo = (mark) => {
    const idx = +mark.dataset.issue;
    document.querySelectorAll('.issue-mark').forEach(m => m.classList.remove('active'));
    mark.classList.add('active');
    const card = document.querySelector(`[data-issue-card="${idx}"]`);
    if (card) {
      card.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
      card.style.outline = '2px solid var(--primary)';
      setTimeout(() => { card.style.outline = ''; }, 1600);
    }
  };
  el.querySelectorAll('.issue-mark').forEach(mark => {
    mark.addEventListener('click', () => jumpTo(mark));
    // 键盘等价路径：Enter / 空格
    mark.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        jumpTo(mark);
      }
    });
  });
}

// ============================================================
// 批改
// ============================================================
async function runReview(e) {
  const btn = e.currentTarget;
  const d = activeDraft();
  if (!d) return;
  const key = `review:${d.id}`;
  if (pendingOps.has(key)) return;
  pendingOps.add(key);
  const gen = generation;
  const essayId = state.essay.id;
  setPanelControlsLocked(btn, true);
  const selectEl = document.getElementById('review-model-select');
  const lane = selectEl ? selectEl.value : defaultLane();
  reviewLane = lane;   // 记忆本次选择（内存）
  busyButton(btn, '批改中', '可离开，结果会自动保存');
  const markerKey = `pending-review:${d.id}`;
  try {
    localStorage.setItem(markerKey, JSON.stringify({ started_at: Date.now(), previous_review_id: latestReview(d)?.id ?? null }));
    const res = await api.reviewDraft(d.id, lane);
    if (gen !== generation) return;
    if (res.quota) {
      sessionQuota = res.quota;
      renderSessionBanner();
    }
    lastCharge = {
      reviewId: res.review_id,
      points: res.points_charged ?? 0,
      lane: res.lane || (lane === 'deepseek' ? 'paid' : lane),
    };
    toast('批改完成', 'success');
    await reload(essayId, gen);
    const reviewEl = document.getElementById('wb-review');
    if (reviewEl) reviewEl.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  } catch (err) {
    if (gen !== generation) return;
    if (!handleBillingError(err))     toast(err.message, 'error');
    idleButton(btn);
    setPanelControlsLocked(btn, false);
  } finally {
    localStorage.removeItem(markerKey);
    pendingOps.delete(key);
    // 用户切 Tab 触发过重新渲染时，恢复新按钮；旧按钮已由 catch/reload 处理
    if (gen === generation && !btn.isConnected && activeDraftId === d.id) renderDraftPanel();
  }
}

function renderReview() {
  const el = document.getElementById('wb-review');
  const d = activeDraft();
  const rv = latestReview(d);
  if (!rv) { el.innerHTML = ''; return; }
  const r = rv.result || {};
  // 旧记录 / 残缺数据兜底：字段缺失时按 0 渲染，避免整块批改结果渲染失败
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const sub = r.subscores || {};

  const bars = [
    { name: '内容', val: num(sub.content), max: 9 },
    { name: '语言', val: num(sub.language), max: 9 },
    { name: '结构', val: num(sub.organization), max: 4 },
  ];
  const gradeInfo = gradeFor(r.score);
  // 本次批改的积分消耗（仅最新一次响应有值；0 = 免费/自备 Key）
  const chargeText = lastCharge && lastCharge.reviewId === rv.id
    ? (lastCharge.points > 0 ? ` · 本次消耗 ${(lastCharge.points / 10000).toFixed(2)} 积分` : ' · 免费')
    : '';

  let html = `
    <div class="section-title">批改结果 <span class="muted">${escapeHtml(rv.model || '')}${chargeText}</span></div>
    <div class="score-card">
      ${gradeInfo ? `
      <div class="score-main">
        <div class="grade-badge g-${gradeInfo.grade}">${gradeInfo.grade}</div>
        <div class="label">等第 · ${gradeInfo.label}</div>
      </div>` : ''}
      <div class="score-main">
        <div class="score-num">${num(r.score)}<small>/22</small></div>
        <div class="label">${num(r.score) >= 21 ? '系统内满分' : '总分'}</div>
      </div>
      <div class="score-bars">
        ${bars.map(b => `
          <div class="score-bar-row">
            <span class="name">${b.name}</span>
            <div class="score-bar-track"><div class="score-bar-fill" style="width:${(b.val / b.max) * 100}%"></div></div>
            <span class="val">${b.val}/${b.max}</span>
          </div>`).join('')}
        ${r.word_count_assessment ? `<div style="font-size:12px;color:var(--text-light)">${escapeHtml(r.word_count_assessment)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-light)">保守阅卷口径：系统上限 22/25，真实阅卷可给 23-25</div>
      </div>
    </div>`;

  if (r.overall_comment) {
    html += `<div class="card" style="margin-top:14px"><b>总评</b><div style="margin-top:6px;line-height:1.8">${escapeHtml(r.overall_comment)}</div></div>`;
  }

  if (r.diagnosis && (r.diagnosis.content || r.diagnosis.language || r.diagnosis.organization)) {
    html += `
      <div class="section-title">逐项诊断</div>
      <div class="diagnosis-grid">
        <div class="cell"><b>内容</b>${escapeHtml(r.diagnosis.content || '—')}</div>
        <div class="cell"><b>语言</b>${escapeHtml(r.diagnosis.language || '—')}</div>
        <div class="cell"><b>结构</b>${escapeHtml(r.diagnosis.organization || '—')}</div>
      </div>`;
  }

  if (r.issues && r.issues.length) {
    html += `<div class="section-title">问题清单 <span class="muted">共 ${r.issues.length} 处 · 点标注跳转</span></div>`;
    html += r.issues.map((iss, i) => `
      <div class="issue-card" data-issue-card="${i}">
        <div class="issue-head">
          <span class="issue-type-tag">${escapeHtml(iss.type)}</span>
          <span class="issue-quote">"${escapeHtml(iss.quote)}"</span>
          ${iss.located === false ? '<span class="chip">原文中未找到，可能含特殊字符</span>' : ''}
        </div>
        <div class="issue-arrow">→ ${escapeHtml(iss.correction)}</div>
        <div class="issue-exp">${escapeHtml(iss.explanation)}</div>
      </div>`).join('');
  }

  if (r.revised_essay) {
    html += `
      <div class="section-title">修改后的全文 <span class="muted">粗体为升级点</span></div>
      <div class="revised-essay">${renderBold(r.revised_essay)}</div>`;
  }

  if (r.suggestions && r.suggestions.length) {
    html += `<div class="section-title">提升建议</div><ul style="margin-left:20px;line-height:2">${
      r.suggestions.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
  }

  if (r.practice && r.practice.items && r.practice.items.length) {
    const p = r.practice;
    html += `
      <div class="section-title">巩固练习 <span class="muted">先译再看答案</span></div>
      ${p.intro ? `<div class="practice-intro">${escapeHtml(p.intro)}</div>` : ''}
      ${p.items.map((it, i) => `
        <div class="practice-card">
          <div class="practice-head">
            <span class="practice-num">${i + 1}</span>
            <div class="practice-zh">${escapeHtml(it.chinese)}</div>
          </div>
          ${it.target ? `<div class="practice-target">考点：${escapeHtml(it.target)}</div>` : ''}
          <button type="button" class="practice-toggle" data-index="${i}" aria-expanded="false">显示参考答案</button>
          <div class="practice-answer" data-index="${i}" hidden>${escapeHtml(it.answer)}</div>
        </div>`).join('')}`;
  }

  if (r.improvement) {
    const imp = r.improvement;
    const delta = imp.score_delta ?? 0;
    html += `
      <div class="improve-card">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="improve-delta ${delta < 0 ? 'neg' : ''}">${delta >= 0 ? '+' : ''}${delta} 分</span>
          <span style="font-size:13px;color:var(--text-soft)">较上一稿</span>
        </div>
        <div class="improve-lists">
          ${imp.fixed?.length ? `<div>✅ 已解决：<ul>${imp.fixed.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}
          ${imp.remaining?.length ? `<div>⏳ 仍存在：<ul>${imp.remaining.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}
          ${imp.regression?.length ? `<div>⚠ 新引入：<ul>${imp.regression.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}
        </div>
      </div>`;
  }

  el.innerHTML = html;

  // 巩固练习：展开/收起参考答案
  el.querySelectorAll('.practice-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const ans = el.querySelector(`.practice-answer[data-index="${btn.dataset.index}"]`);
      if (!ans) return;
      const show = ans.hasAttribute('hidden');
      if (show) ans.removeAttribute('hidden'); else ans.setAttribute('hidden', '');
      btn.textContent = show ? '收起参考答案' : '显示参考答案';
      btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    });
  });
}

// ============================================================
// 新稿件（拍照 OCR / 直接输入 / 预填二稿）
// ============================================================
function openDraftModal(mode, prefill) {
  const draftCount = state.drafts.length;
  const nextName = draftCount ? `${cnNum[draftCount] || draftCount + 1}稿` : '一稿';
  let images = [];

  const modal = wbModal(`
    <div style="display:flex;gap:6px;margin-bottom:16px">
      <button class="draft-tab ${mode === 'photo' ? 'active' : ''}" data-mode="photo">📷 拍照/图片识别</button>
      <button class="draft-tab ${mode === 'text' ? 'active' : ''}" data-mode="text">✏️ 输入/粘贴</button>
    </div>
    <div data-panel="photo" style="display:${mode === 'photo' ? 'block' : 'none'}">
      <div class="form-group">
        <label class="form-label">手写稿照片 <span style="font-weight:400;color:var(--text-light)">按顺序 · 最多 3 张</span></label>
        <input type="file" id="draft-img-input" accept="image/*" multiple capture="environment">
        <div class="img-thumbs" id="draft-img-thumbs"></div>
      </div>
      <div class="form-group">
        <label class="form-label">识别引擎</label>
        ${isGuest
          ? `<label style="font-size:13px;display:block" title="手写体 → 高精度 → 标准版自动降级，无书写质量分">
               <input type="radio" name="ocr-engine" value="baidu" checked> 百度 OCR
             </label>
             <div class="chip-row" style="margin-top:8px">
               <span class="chip accent">游客每天 3 次</span>
               <span class="chip">登录后可用大模型视觉（带书写质量分）</span>
             </div>`
          : `<label style="font-size:13px;display:block;margin-bottom:6px" title="逐字转写 + 书写质量评分，保留原始错误">
               <input type="radio" name="ocr-engine" value="vlm" checked> 大模型视觉 <span class="chip">推荐</span>
             </label>
             <label style="font-size:13px;display:block" title="手写体 → 高精度 → 标准版自动降级，无书写质量分">
               <input type="radio" name="ocr-engine" value="baidu"> 百度 OCR <span class="chip">省额度</span>
             </label>
             <div class="chip-row" style="margin-top:8px">
               <span class="chip">百度 5 次/日免费</span>
               <span class="chip">大模型按量计积分</span>
             </div>`}
      </div>
      <button class="btn btn-primary" id="btn-ocr">开始识别</button>
      <span id="ocr-status" style="font-size:13px;color:var(--text-soft);margin-left:10px"></span>
    </div>
    <div data-panel="text" style="display:${mode === 'text' ? 'block' : 'none'};margin-top:4px">
      <div class="form-group">
        <label class="form-label">作文全文（${nextName}${prefill ? '，已预填上一稿，修改后保存' : ''}）</label>
        <textarea class="form-input" id="draft-text" rows="12" style="font-size:15px;line-height:1.9">${escapeHtml(prefill || '')}</textarea>
        <div class="wordcount-hint" id="modal-wc" style="margin-top:6px"></div>
        <div id="ocr-meta" style="font-size:12px;color:var(--text-soft);margin-top:4px"></div>
      </div>
      <button class="btn btn-primary" id="btn-save-new-draft">保存${nextName}</button>
    </div>
  `, { title: '新建稿件' });

  let handwritingScore = null;
  let ocrImages = [];
  let lastSource = prefill ? 'text' : 'text';
  let ocrPending = false;
  let textRevision = 0;
  const setOcrLocked = locked => {
    modal.querySelectorAll('[data-mode], #draft-img-input, #draft-img-thumbs .rm').forEach(el => { el.disabled = locked; });
  };

  const photoPanel = modal.querySelector('[data-panel="photo"]');
  const textPanel = modal.querySelector('[data-panel="text"]');
  modal.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    modal.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const m = b.dataset.mode;
    photoPanel.style.display = m === 'photo' ? 'block' : 'none';
    textPanel.style.display = m === 'text' ? 'block' : 'none';
  }));

  // 图片上传
  const thumbs = modal.querySelector('#draft-img-thumbs');
  const renderImgs = () => {
    thumbs.innerHTML = images.map((url, i) => `
      <div class="thumb"><img src="${escapeHtml(url)}" alt="手写稿 ${i + 1}"><button type="button" class="rm" data-rm="${i}" title="移除这张图片" aria-label="移除手写稿图片 ${i + 1}">×</button></div>`).join('');
    thumbs.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => {
      images.splice(+b.dataset.rm, 1);
      renderImgs();
    }));
  };
  modal.querySelector('#draft-img-input').addEventListener('change', async (e) => {
    const available = 3 - images.length;
    const selected = [...e.target.files];
    const files = selected.slice(0, available);
    e.target.value = '';
    if (!files.length) { toast('最多 3 张', 'error'); return; }
    if (selected.length > files.length) toast('最多 3 张，超出部分已忽略', 'error');
    const gen = generation;
    const input = e.target;
    input.disabled = true;
    const results = await Promise.allSettled(files.map(f => compressImageFile(f)));
    if (gen !== generation || modal !== wbModalEl) return;
    for (const result of results) {
      if (result.status === 'fulfilled') images.push(result.value);
      else toast(result.reason?.message || '图片处理失败', 'error');
    }
    input.disabled = false;
    renderImgs();
  });

  // OCR
  modal.querySelector('#btn-ocr').addEventListener('click', async (e) => {
    if (!images.length) { toast('请先上传照片', 'error'); return; }
    if (ocrPending) return;
    const btn = e.currentTarget;
    const status = modal.querySelector('#ocr-status');
    const engine = modal.querySelector('input[name="ocr-engine"]:checked').value;
    const gen = generation;
    const requestImages = images.slice(); // 快照：完成后不能把新加图片误记为本轮 OCR 来源
    const startRevision = textRevision;
    ocrPending = true;
    setOcrLocked(true);
    busyButton(btn, '识别中', '约 1 分钟');
    status.innerHTML = '<span class="spinner spinner-sm"></span><span class="busy-time">约 1 分钟</span>';
    try {
      const res = await api.ocr(requestImages, engine);
      if (gen !== generation || modal !== wbModalEl) return;
      const ta = modal.querySelector('#draft-text');
      if (textRevision !== startRevision &&
          !confirm('识别已完成，但你已修改文本。要用识别结果覆盖当前文本吗？')) {
        status.innerHTML = '<span class="badge badge-pending">已保留当前文本</span>';
        return;
      }
      ta.value = res.text;
      textRevision++;
      handwritingScore = res.handwriting_score;
      ocrImages = requestImages;
      lastSource = 'photo';
      modal.querySelector('#ocr-meta').innerHTML =
        (res.handwriting_score !== null && res.handwriting_score !== undefined
          ? `书写质量：${(res.handwriting_score * 100).toFixed(0)}%` : `已识别（${res.endpoint || '百度 OCR'}）`)
        + (res.notes ? ` · ${escapeHtml(res.notes)}` : '');
      status.innerHTML = '<span class="badge badge-completed">识别完成</span>';
      modal.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('active'));
      modal.querySelector('[data-mode="text"]').classList.add('active');
      photoPanel.style.display = 'none';
      textPanel.style.display = 'block';
      updateWc();
    } catch (err) {
      if (gen === generation && modal === wbModalEl) {
        status.textContent = '';
        if (!handleBillingError(err)) toast(err.message, 'error');
      }
    } finally {
      ocrPending = false;
      if (gen === generation && modal === wbModalEl) {
        setOcrLocked(false);
        idleButton(btn);
      }
    }
  });

  // 词数
  const ta = modal.querySelector('#draft-text');
  const wcEl = modal.querySelector('#modal-wc');
  const updateWc = () => {
    const n = countWords(ta.value);
    const soft = state.essay.word_limits || { minWords: 200, maxWords: 500, softMinWords: 200, softMaxWords: 500 };
    wcEl.textContent = `${n} 词（考试要求 ${soft.minWords}-${soft.maxWords} 词）`;
    wcEl.className = 'wordcount-hint ' + (n >= soft.softMinWords && n <= soft.softMaxWords ? 'ok' : 'bad');
  };
  ta.addEventListener('input', () => { textRevision++; updateWc(); });
  updateWc();

  // 保存
  modal.querySelector('#btn-save-new-draft').addEventListener('click', async (e) => {
    const text = ta.value.trim();
    if (text.length < 10) { toast('稿件内容过短', 'error'); return; }
    const btn = e.currentTarget;
    const gen = generation;
    const essayId = state.essay.id;
    busyButton(btn, '保存中');
    try {
      const res = await api.createDraft(essayId, {
        text,
        source: lastSource,
        handwriting_score: lastSource === 'photo' ? handwritingScore : undefined,
        ocr_images: lastSource === 'photo' ? ocrImages : [],
      });
      if (gen !== generation) return;
      toast(`已保存为${nextName}`, 'success');
      closeWbModal(modal);
      activeDraftId = res.draft_id;
      await reload(essayId, gen);
    } catch (err) {
      if (gen === generation && modal === wbModalEl) {
        toast(err.message, 'error');
        idleButton(btn);
      }
    }
  });
}

// ============================================================
// 片段精修（选中文本 → 浮动按钮 → 面板）
// ============================================================
function bindDelegated() {
  if (delegatedBound) return;
  delegatedBound = true;
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('touchend', onMouseUp);
}

function onMouseUp() {
  const gen = generation;
  if (isGuest) { removeSelBtn(); return; }   // 游客不提供精修入口
  setTimeout(() => {
    if (gen !== generation) return;
    const view = document.getElementById('draft-text-view');
    if (!view || editingDraft) { removeSelBtn(); return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { removeSelBtn(); return; }
    const text = sel.toString().trim();
    if (text.length < 3 || text.length > 3000) { removeSelBtn(); return; }
    const anchor = sel.anchorNode;
    if (!anchor || !view.contains(anchor.nodeType === 1 ? anchor : anchor.parentNode)) { removeSelBtn(); return; }

    const range = sel.getRangeAt(0).getBoundingClientRect();
    showSelBtn(text, range);
  }, 0);
}

function showSelBtn(fragment, rect) {
  removeSelBtn();
  selBtn = document.createElement('button');
  selBtn.className = 'sel-polish-btn';
  selBtn.textContent = '✨ 精修选中片段';
  selBtn.addEventListener('mousedown', e => e.preventDefault());
  selBtn.addEventListener('click', () => {
    removeSelBtn();
    window.getSelection().removeAllRanges();
    openPolishModal(fragment);
  });
  document.body.appendChild(selBtn);
  const top = window.scrollY + rect.top - 36;
  const left = Math.min(Math.max(8, window.scrollX + rect.left), window.scrollX + document.documentElement.clientWidth - 160);
  selBtn.style.top = `${top}px`;
  selBtn.style.left = `${left}px`;
  selBtn.style.display = 'block';
}

function removeSelBtn() {
  if (selBtn) { selBtn.remove(); selBtn = null; }
}

function openPolishModal(fragment) {
  const modal = wbModal(`
    <div class="form-group">
      <label class="form-label">选中片段</label>
      <div style="background:var(--bg-soft);border-radius:var(--radius);padding:10px 12px;font-size:14px;line-height:1.8;font-style:italic;color:var(--text-soft)">
        "${escapeHtml(fragment)}"
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">精修要求（可选）</label>
      <input type="text" class="form-input" id="polish-instruction" maxlength="1000"
        placeholder="如：换更高级的句式 / 更口语化一些 / 补一个例证">
    </div>
    <div class="form-group" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <label class="form-label" style="margin:0">模型</label>
      ${modelSelectHtml('polish-model-select', polishLane)}
      <span id="polish-paid-hint" class="muted" style="display:none;font-size:12px">${PAID_HINT}</span>
    </div>
    <button class="btn btn-primary" id="btn-run-polish">开始精修</button>
    <div id="polish-result" style="margin-top:16px"></div>
  `, { title: '片段精修' });

  bindPaidHint(modal.querySelector('#polish-model-select'), modal.querySelector('#polish-paid-hint'));

  modal.querySelector('#btn-run-polish').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const d = activeDraft();
    if (!d) return;
    const selectEl = modal.querySelector('#polish-model-select');
    const lane = selectEl ? selectEl.value : defaultLane();
    polishLane = lane;
    const gen = generation;
    busyButton(btn, '精修中', '约 1 分钟');
    try {
      const res = await api.polish(state.essay.id, {
        mode: 'fragment',
        fragment,
        instruction: modal.querySelector('#polish-instruction').value.trim(),
        draft_id: d.id,
        model_id: lane,
      });
      if (gen !== generation || modal !== wbModalEl) return;
      const chargeNote = res.points_charged > 0
        ? `<div class="muted" style="font-size:12px;margin-bottom:8px">本次消耗 ${(res.points_charged / 10000).toFixed(2)} 积分</div>` : '';
      renderPolishResult(modal.querySelector('#polish-result'), res.result, fragment, chargeNote);
      idleButton(btn);
      btn.textContent = '重新精修';
    } catch (err) {
      if (gen === generation && modal === wbModalEl && !handleBillingError(err)) toast(err.message, 'error');
    } finally {
      if (gen === generation && modal === wbModalEl && btn.disabled) idleButton(btn);
    }
  });
}

function renderPolishResult(container, result, fragment, prefixHtml = '') {
  const d = activeDraft();
  container.innerHTML = `
    ${prefixHtml}
    ${result.versions.map((v, vi) => `
      <div class="polish-version">
        <span class="style-tag">${escapeHtml(v.style)}</span>
        <div class="polish-text">${renderBold(v.text)}</div>
        ${v.changes.map(c => `
          <div class="change-row">
            【${escapeHtml(c.point)}】<span class="before">${escapeHtml(c.before)}</span>
            → <span class="after">${escapeHtml(c.after)}</span>
            ${c.why ? `<div style="color:var(--text-light);margin-top:2px">${escapeHtml(c.why)}</div>` : ''}
          </div>`).join('')}
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn btn-primary" data-adopt="${vi}" style="padding:5px 12px;font-size:13px">采纳为新稿件</button>
          <button class="btn" data-copy="${vi}" style="padding:5px 12px;font-size:13px">复制</button>
        </div>
      </div>`).join('')}
    ${result.learnings?.length ? `
      <div class="section-title">可复用的表达</div>
      <ul class="learnings" style="margin-left:20px">${result.learnings.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
  `;

  container.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
    const text = result.versions[+b.dataset.copy].text;
    navigator.clipboard?.writeText(text).then(() => toast('已复制', 'success'));
  }));

  container.querySelectorAll('[data-adopt]').forEach(b => b.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!d) return;
    const chosen = result.versions[+btn.dataset.adopt].text;
    const newText = d.text.replace(fragment, chosen);
    if (newText === d.text) {
      // 片段定位失败兜底：拼接到当前稿之后
      if (!confirm('片段在稿件中定位失败，是否将精修结果追加到稿件末尾？')) return;
    }
    const gen = generation;
    const essayId = state.essay.id;
    const modal = container.closest('.modal-overlay');
    busyButton(btn, '创建中');
    container.querySelectorAll('[data-adopt], [data-copy]').forEach(x => { if (x !== btn) x.disabled = true; });
    try {
      const res = await api.createDraft(essayId, { text: newText, source: 'polish' });
      if (gen !== generation) return;
      toast('已采纳为新稿件', 'success');
      closeWbModal(modal);
      activeDraftId = res.draft_id;
      await reload(essayId, gen);
    } catch (err) {
      if (gen === generation && (!modal || modal === wbModalEl)) {
        toast(err.message, 'error');
        idleButton(btn);
        container.querySelectorAll('[data-adopt], [data-copy]').forEach(x => { x.disabled = false; });
      }
    }
  }));
}

// ============================================================
// 全文润色
// ============================================================
async function runFullRewrite(e) {
  if (isGuest) {
    showLoginPrompt('全文润色需要登录', '游客可以用 3 次批改看批改报告与修改稿；整篇润色、片段精修、按模式自定义提示词需登录后使用。');
    return;
  }
  const btn = e.currentTarget;
  const d = activeDraft();
  if (!d) return;
  const key = `rewrite:${d.id}`;
  if (pendingOps.has(key)) return;
  pendingOps.add(key);
  const gen = generation;
  const essayId = state.essay.id;
  setPanelControlsLocked(btn, true);
  // 与批改共用面板上的模型选择器（同一按钮行）
  const selectEl = document.getElementById('review-model-select');
  const lane = selectEl ? selectEl.value : defaultLane();
  reviewLane = lane;
  busyButton(btn, '润色中', '约 1 分钟');
  let res;
  try {
    res = await api.polish(essayId, { mode: 'full', draft_id: d.id, model_id: lane });
  } catch (err) {
    if (gen === generation) {
      if (!handleBillingError(err)) toast(err.message, 'error');
      idleButton(btn);
      setPanelControlsLocked(btn, false);
    }
    return;
  } finally {
    pendingOps.delete(key);
    if (gen === generation && !btn.isConnected && activeDraftId === d.id) renderDraftPanel();
  }
  if (gen !== generation) return;
  idleButton(btn);
  setPanelControlsLocked(btn, false);

  const r = res.result;
  const chargeNote = res.points_charged > 0
    ? ` · 本次消耗 ${(res.points_charged / 10000).toFixed(2)} 积分` : '';
  const modal = wbModal(`
    <div class="form-group">
      <div style="font-size:13px;color:var(--text-soft);line-height:1.8">${escapeHtml(r.summary || '')}${chargeNote ? `<span class="muted" style="font-size:12px">${chargeNote}</span>` : ''}</div>
    </div>
    ${r.paragraph_changes.map(p => `
      <div class="rewrite-pair">
        <div class="col orig">${escapeHtml(p.original)}</div>
        <div class="col new">${renderBold(p.rewritten)}</div>
      </div>`).join('')}
    <div class="section-title">润色后全文 <span class="muted">${countWords(r.rewritten)} 词</span></div>
    <div class="revised-essay">${renderBold(r.rewritten)}</div>
    <div style="margin-top:16px;display:flex;gap:10px">
      <button class="btn btn-primary" id="btn-adopt-rewrite">采纳润色稿为新稿件</button>
      <button class="btn" id="btn-copy-rewrite">复制全文</button>
    </div>
  `, { wide: true, title: '全文润色' });

  modal.querySelector('#btn-copy-rewrite').addEventListener('click', () => {
    navigator.clipboard?.writeText(r.rewritten.replace(/\*\*/g, '')).then(() => toast('已复制', 'success'));
  });
  modal.querySelector('#btn-adopt-rewrite').addEventListener('click', async (ev) => {
    const btn2 = ev.currentTarget;
    const essayId = state.essay.id;
    busyButton(btn2, '创建中');
    try {
      const created = await api.createDraft(essayId, {
        text: r.rewritten.replace(/\*\*/g, ''), source: 'polish',
      });
      if (gen !== generation) return;
      toast('已保存为新稿件', 'success');
      closeWbModal(modal);
      activeDraftId = created.draft_id;
      await reload(essayId, gen);
    } catch (err) {
      if (gen === generation && modal === wbModalEl) {
        toast(err.message, 'error');
        idleButton(btn2);
      }
    }
  });
}

// ============================================================
// 批改提示词（本作文覆盖）
// ============================================================
function openPromptModal() {
  const e = state.essay;
  const gen = generation;
  const needsTemplate = !e.custom_prompt;
  const modal = wbModal(`
    <p style="font-size:13px;color:var(--text-light);margin-bottom:10px">
      当前模式：<strong>${escapeHtml(e.genre_label)}</strong>。留空 = 使用该模式在「设置」里的模板（或内置默认）；此处只影响本作文。
    </p>
    <div class="chip-row" style="margin-bottom:12px">
      <span class="chip accent"><code>{essay}</code> 必填</span>
      <span class="chip"><code>{topic}</code></span>
      <span class="chip"><code>{word_count}</code></span>
      <span class="chip"><code>{previous_feedback}</code></span>
    </div>
    <div id="prompt-load-status" class="loading-line" ${needsTemplate ? '' : 'hidden'}><span class="spinner spinner-sm"></span>载入模板</div>
    <textarea class="form-input" id="essay-prompt" rows="12" style="font-family:var(--font-mono);font-size:12px;line-height:1.6" ${needsTemplate ? 'disabled' : ''}>${escapeHtml(e.custom_prompt || '')}</textarea>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" id="btn-save-prompt" ${needsTemplate ? 'disabled' : ''}>保存（仅本作文）</button>
      <button class="btn" id="btn-save-genre-prompt" ${needsTemplate ? 'disabled' : ''} title="把框内内容保存为「${escapeHtml(e.genre_label)}」的模式模板，之后该模式的作文都用它">存为该模式模板</button>
      ${e.custom_prompt ? '<button class="btn" id="btn-clear-prompt">清除自定义</button>' : ''}
    </div>
  `, { wide: true, title: '批改提示词' });
  const textarea = modal.querySelector('#essay-prompt');
  const saveBtn = modal.querySelector('#btn-save-prompt');

  saveBtn.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const content = textarea.value;
    if (content.trim() && !content.includes('{essay}')) {
      toast('提示词必须包含 {essay} 占位符', 'error');
      return;
    }
    busyButton(btn, '保存中');
    try {
      await api.updateEssay(e.id, { custom_prompt: content.trim() });
      if (gen !== generation) return;
      toast('提示词已保存', 'success');
      closeWbModal(modal);
      await reload(e.id, gen);
    } catch (err) {
      if (gen === generation && modal === wbModalEl) {
        toast(err.message, 'error');
        idleButton(btn);
      }
    }
  });

  const clearBtn = modal.querySelector('#btn-clear-prompt');
  if (clearBtn) clearBtn.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    busyButton(btn, '清除中');
    try {
      await api.updateEssay(e.id, { custom_prompt: null });
      if (gen !== generation) return;
      toast('已清除，回落到该模式的模板', 'success');
      closeWbModal(modal);
      await reload(e.id, gen);
    } catch (err) {
      if (gen === generation && modal === wbModalEl) {
        toast(err.message, 'error');
        idleButton(btn);
      }
    }
  });

  // 把框内内容存为该**模式**的模板（按 genre 独立保存，不影响其它模式）
  const genreBtn = modal.querySelector('#btn-save-genre-prompt');
  if (genreBtn) genreBtn.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const content = textarea.value.trim();
    if (!content.includes('{essay}')) {
      toast('提示词必须包含 {essay} 占位符', 'error');
      return;
    }
    busyButton(btn, '保存中');
    try {
      await api.savePrompt(e.genre, content);
      if (gen !== generation) return;
      toast(`已保存为「${e.genre_label}」模式模板`, 'success');
      idleButton(btn);
    } catch (err) {
      if (gen === generation && modal === wbModalEl) {
        toast(err.message, 'error');
        idleButton(btn);
      }
    }
  });

  if (needsTemplate) {
    (async () => {
      const status = modal.querySelector('#prompt-load-status');
      try {
        const data = await api.getPrompts();
        if (gen !== generation || modal !== wbModalEl) return;
        textarea.value = data.prompts.find(p => p.genre === e.genre)?.content || '';
        status.hidden = true;
      } catch (err) {
        if (gen !== generation || modal !== wbModalEl) return;
        status.innerHTML = `<span class="badge badge-failed">模板载入失败</span>`;
        toast(err.message, 'error');
      } finally {
        if (gen === generation && modal === wbModalEl) {
          textarea.disabled = false;
          saveBtn.disabled = false;
          if (genreBtn) genreBtn.disabled = false;
        }
      }
    })();
  }
}

// ============================================================
// 通用模态框
// ============================================================
let wbModalEl = null;
let wbModalKeydown = null;
let wbModalReturnFocus = null;

/** 可聚焦元素选择器（Tab 循环与初始焦点用） */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function wbModal(innerHtml, opts = {}) {
  closeWbModal(null, true);
  const title = opts.title || '对话框';
  wbModalReturnFocus = document.activeElement;
  wbModalEl = document.createElement('div');
  wbModalEl.className = 'modal-overlay';
  wbModalEl.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" style="${opts.wide ? 'max-width:860px' : ''};max-height:85vh;overflow-y:auto">
    <div class="modal-header">
      <span class="modal-title">${escapeHtml(opts.title || '')}</span>
      <button type="button" class="modal-close" id="wb-modal-close" title="关闭" aria-label="关闭对话框">×</button>
    </div>
    <div class="modal-body">${innerHtml}</div>
  </div>`;
  document.body.appendChild(wbModalEl);
  requestAnimationFrame(() => wbModalEl?.classList.add('open'));
  wbModalEl.querySelector('#wb-modal-close').addEventListener('click', () => closeWbModal(wbModalEl));
  wbModalEl.addEventListener('mousedown', ev => { if (ev.target === wbModalEl) closeWbModal(wbModalEl); });

  wbModalKeydown = ev => {
    const el = wbModalEl;
    if (!el) return;
    if (ev.key === 'Escape') { ev.preventDefault(); closeWbModal(el); return; }
    if (ev.key !== 'Tab') return;
    // 焦点陷阱：Tab 在对话框内循环，不逃到背景页
    const nodes = [...el.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', wbModalKeydown);

  // 初始焦点：正文里第一个可操作控件，没有则落在关闭按钮，保证键盘可用
  const initial = wbModalEl.querySelector('.modal-body ' + FOCUSABLE.split(',').join(', .modal-body '))
    || wbModalEl.querySelector('#wb-modal-close');
  if (initial) {
    try { initial.focus({ preventScroll: true }); } catch { /* 忽略 */ }
  }
  return wbModalEl;
}

function closeWbModal(expected = null, immediate = false) {
  if (expected && expected !== wbModalEl) return; // 旧异步任务不能误关新模态框
  if (wbModalKeydown) { document.removeEventListener('keydown', wbModalKeydown); wbModalKeydown = null; }
  const el = wbModalEl;
  wbModalEl = null;
  // 焦点归还触发元素（元素已随重渲染移除时跳过）
  const back = wbModalReturnFocus;
  wbModalReturnFocus = null;
  if (back && typeof back.focus === 'function' && back.isConnected) {
    try { back.focus({ preventScroll: true }); } catch { /* 忽略 */ }
  }
  if (!el) return;
  if (immediate || reducedMotion.matches) { el.remove(); return; }
  el.classList.remove('open');
  el.classList.add('closing');
  setTimeout(() => el.remove(), 180);
}

// ── 导出报告数据（export.js 消费）──
function buildReportPayload() {
  const e = state.essay;
  return {
    kind: 'report',
    title: e.title,
    genre_label: e.genre_label,
    total: e.genre_total,
    topic: e.topic_text,
    topic_images: e.topic_images || [],
    drafts: state.drafts.map(d => ({
      version: d.version,
      text: d.text,
      word_count: d.word_count,
      handwriting_score: d.handwriting_score,
      review: latestReview(d) ? {
        score: latestReview(d).result.score,
        subscores: latestReview(d).result.subscores,
        overall_comment: latestReview(d).result.overall_comment,
        diagnosis: latestReview(d).result.diagnosis,
        issues: latestReview(d).result.issues,
        revised_essay: latestReview(d).result.revised_essay,
        suggestions: latestReview(d).result.suggestions,
        practice: latestReview(d).result.practice || null,
        improvement: latestReview(d).result.improvement || null,
      } : null,
    })),
  };
}
