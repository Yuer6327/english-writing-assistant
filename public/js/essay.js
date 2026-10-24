// ============================================================
// essay.js — 作文工作台（swup 管理：导出 init/cleanup）
// 题目展示 / 稿件 Tabs / 新稿件（拍照OCR·输入·预填二稿）/
// 批改渲染（分数卡+原文高亮+问题卡）/ 片段精修 / 全文润色 / 导出
// ============================================================

import { api, toast, requireAuth, escapeHtml, renderBold, formatBeijingTime, countWords, compressImageFile } from './api.js';
import { openExportModal } from './export.js';

let disposed = false;
let state = null;            // { essay, drafts, polishes }
let activeDraftId = null;
let editingDraft = false;    // 稿件编辑模式
let selBtn = null;           // 选中片段的浮动精修按钮
let delegatedBound = false;  // document 级委托只绑一次（swup 重复进页不叠加）

const cnNum = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function cleanup() {
  disposed = true;
  removeSelBtn();
  closeWbModal();
}

export async function init() {
  disposed = false;
  const user = await requireAuth();
  if (!user || disposed) return;

  const id = new URLSearchParams(location.search).get('id');
  if (!id) { window.swupNavigate('/'); return; }

  await reload(id);
  bindDelegated();
}

// ============================================================
// 数据加载与整体渲染
// ============================================================
async function reload(essayId) {
  const headerEl = document.getElementById('wb-header');
  headerEl.innerHTML = '<div class="card"><span class="spinner"></span> 加载中...</div>';

  try {
    state = await api.getEssay(essayId);
  } catch (err) {
    if (disposed) return;
    headerEl.innerHTML = `<div class="card">加载失败：${escapeHtml(err.message)} <a href="/">返回列表</a></div>`;
    return;
  }
  if (disposed) return;

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
        <button class="btn" id="btn-prompt" style="padding:6px 14px;font-size:13px">批改提示词</button>
        <button class="btn" id="btn-export" style="padding:6px 14px;font-size:13px">导出报告</button>
        <button class="btn" id="btn-delete-essay" style="padding:6px 14px;font-size:13px">删除作文</button>
      </div>
    </div>`;

  document.getElementById('btn-prompt').addEventListener('click', openPromptModal);
  document.getElementById('btn-export').addEventListener('click', () => {
    openExportModal({ mode: 'report', getData: () => buildReportPayload() });
  });
  document.getElementById('btn-delete-essay').addEventListener('click', async () => {
    if (!confirm(`确定删除作文「${state.essay.title}」及其全部稿件、批改记录？`)) return;
    try {
      await api.deleteEssay(state.essay.id);
      toast('已删除', 'success');
      window.swupNavigate('/');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ── 题目区（可折叠）──
function renderTopic() {
  const e = state.essay;
  const imgs = (e.topic_images || []).map(u => `
    <img src="${u}" alt="题目图片" style="max-width:100%;max-height:280px;border:1px solid var(--border);border-radius:var(--radius);margin-top:8px">`).join('');
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
  if (!state.drafts.length) { el.innerHTML = ''; return; }
  el.innerHTML = state.drafts.map(d => {
    const rv = latestReview(d);
    return `<button class="draft-tab ${d.id === activeDraftId ? 'active' : ''}" data-tab="${d.id}">
      ${cnNum[d.version - 1] || d.version}稿${rv ? `<span class="tab-score">${rv.result.score}</span>` : ''}
    </button>`;
  }).join('') + '<button class="draft-tab draft-tab-add" id="tab-add">＋ 新稿件</button>';

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
  const sourceLabel = { photo: '拍照识别', text: '直接输入', polish: '精修/润色采纳' }[d.source] || d.source;
  const hwScore = d.handwriting_score !== null && d.handwriting_score !== undefined
    ? ` · 书写质量 ${(d.handwriting_score * 100).toFixed(0)}%` : '';

  el.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-light)">
          ${cnNum[d.version - 1] || d.version}稿 · ${sourceLabel} · ${d.word_count} 词${hwScore}
          ${rv ? ` · 批改于 ${formatBeijingTime(rv.created_at)}${d.reviews.length > 1 ? `（第 ${d.reviews.length} 次）` : ''}` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${editingDraft
            ? `<button class="btn btn-primary" id="btn-save-draft" style="padding:5px 12px;font-size:13px">保存稿件</button>
               <button class="btn" id="btn-cancel-edit" style="padding:5px 12px;font-size:13px">取消</button>`
            : `<button class="btn btn-primary" id="btn-review" style="padding:5px 12px;font-size:13px">${rv ? '重新批改' : '开始批改'}</button>
               <button class="btn" id="btn-edit-draft" style="padding:5px 12px;font-size:13px">编辑稿件</button>
               <button class="btn" id="btn-new-draft" style="padding:5px 12px;font-size:13px">✍️ 写${cnNum[d.version] || d.version + 1}稿</button>
               <button class="btn" id="btn-rewrite" style="padding:5px 12px;font-size:13px">全文润色</button>
               <button class="btn" id="btn-del-draft" style="padding:5px 12px;font-size:13px">删除</button>`}
        </div>
      </div>
      ${stale ? '<div style="font-size:12px;color:#d64545;margin-bottom:8px">⚠ 稿件在上次批改后已修改，建议重新批改</div>' : ''}
      ${editingDraft
        ? `<textarea class="form-input" id="draft-editor" rows="14" style="font-size:15px;line-height:1.9">${escapeHtml(d.text)}</textarea>
           <div class="wordcount-hint" id="draft-wc" style="margin-top:6px"></div>`
        : `<div class="essay-annotated" id="draft-text-view">${renderAnnotated(d)}</div>
           <div style="font-size:12px;color:var(--text-light);margin-top:10px">提示：在正文中选中任意句子，可进行片段精修</div>`}
    </div>`;

  if (editingDraft) {
    const ta = el.querySelector('#draft-editor');
    const wc = el.querySelector('#draft-wc');
    const updateWc = () => {
      const n = countWords(ta.value);
      wc.textContent = `${n} 词（要求 200-500 词）`;
      wc.className = 'wordcount-hint ' + (n >= 200 && n <= 500 ? 'ok' : n >= 160 ? 'bad' : '');
    };
    ta.addEventListener('input', updateWc);
    updateWc();
    el.querySelector('#btn-save-draft').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const text = ta.value.trim();
      if (text.length < 10) { toast('稿件内容过短', 'error'); return; }
      btn.disabled = true; btn.textContent = '保存中...';
      try {
        await api.updateDraft(d.id, text);
        toast('稿件已保存', 'success');
        await reload(state.essay.id);
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = '保存稿件'; }
    });
    el.querySelector('#btn-cancel-edit').addEventListener('click', () => {
      editingDraft = false; renderDraftPanel();
    });
  } else {
    el.querySelector('#btn-review').addEventListener('click', runReview);
    el.querySelector('#btn-edit-draft').addEventListener('click', () => { editingDraft = true; renderDraftPanel(); });
    el.querySelector('#btn-new-draft').addEventListener('click', () => openDraftModal('text', d.text));
    el.querySelector('#btn-rewrite').addEventListener('click', runFullRewrite);
    el.querySelector('#btn-del-draft').addEventListener('click', async () => {
      if (!confirm(`确定删除${cnNum[d.version - 1] || d.version}稿及其批改记录？`)) return;
      try {
        await api.deleteDraft(d.id);
        toast('已删除', 'success');
        activeDraftId = null;
        await reload(state.essay.id);
      } catch (err) { toast(err.message, 'error'); }
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
    html += escapeHtml(text.slice(pos, s.start));
    html += `<span class="issue-mark" data-issue="${s.issueIndex}">${escapeHtml(text.slice(s.start, s.end))}</span>`;
    pos = s.end;
  }
  html += escapeHtml(text.slice(pos));
  return html;
}

function bindIssueMarks(el) {
  el.querySelectorAll('.issue-mark').forEach(mark => {
    mark.addEventListener('click', () => {
      const idx = +mark.dataset.issue;
      document.querySelectorAll('.issue-mark').forEach(m => m.classList.remove('active'));
      mark.classList.add('active');
      const card = document.querySelector(`[data-issue-card="${idx}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.outline = '2px solid var(--primary)';
        setTimeout(() => { card.style.outline = ''; }, 1600);
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
  btn.disabled = true; btn.textContent = '批改中（约 10-30 秒）...';
  try {
    await api.reviewDraft(d.id);
    toast('批改完成', 'success');
    await reload(state.essay.id);
    const reviewEl = document.getElementById('wb-review');
    if (reviewEl) reviewEl.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false; btn.textContent = '开始批改';
  }
}

function renderReview() {
  const el = document.getElementById('wb-review');
  const d = activeDraft();
  const rv = latestReview(d);
  if (!rv) { el.innerHTML = ''; return; }
  const r = rv.result;

  const bars = [
    { name: '内容', val: r.subscores.content, max: 10 },
    { name: '语言', val: r.subscores.language, max: 10 },
    { name: '结构', val: r.subscores.organization, max: 5 },
  ];

  let html = `
    <div class="section-title">批改结果 <span class="muted">${escapeHtml(rv.model || '')}</span></div>
    <div class="score-card">
      <div class="score-main">
        <div class="score-num">${r.score}<small>/${state.essay.genre_total}</small></div>
        <div class="label">总分</div>
      </div>
      <div class="score-bars">
        ${bars.map(b => `
          <div class="score-bar-row">
            <span class="name">${b.name}</span>
            <div class="score-bar-track"><div class="score-bar-fill" style="width:${(b.val / b.max) * 100}%"></div></div>
            <span class="val">${b.val}/${b.max}</span>
          </div>`).join('')}
        ${r.word_count_assessment ? `<div style="font-size:12px;color:var(--text-light)">${escapeHtml(r.word_count_assessment)}</div>` : ''}
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
    html += `<div class="section-title">问题清单 <span class="muted">点击正文中下划线标注可跳转（共 ${r.issues.length} 处）</span></div>`;
    html += r.issues.map((iss, i) => `
      <div class="issue-card" data-issue-card="${i}">
        <div class="issue-head">
          <span class="issue-type-tag">${escapeHtml(iss.type)}</span>
          <span class="issue-quote">"${escapeHtml(iss.quote)}"</span>
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
        <label class="form-label">手写稿照片（可多张，按顺序，最多 3 张）</label>
        <input type="file" id="draft-img-input" accept="image/*" multiple capture="environment">
        <div class="img-thumbs" id="draft-img-thumbs"></div>
      </div>
      <div class="form-group">
        <label class="form-label">识别引擎</label>
        <label style="font-size:13px;display:block;margin-bottom:4px">
          <input type="radio" name="ocr-engine" value="vlm" checked> 大模型视觉（推荐：逐字转写 + 书写质量评分）
        </label>
        <label style="font-size:13px;display:block">
          <input type="radio" name="ocr-engine" value="baidu"> 百度 OCR（手写体→高精度→标准版自动降级，省模型额度）
        </label>
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
  `);

  let handwritingScore = null;
  let ocrImages = [];
  let lastSource = prefill ? 'text' : 'text';

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
      <div class="thumb"><img src="${url}" alt="手写稿 ${i + 1}"><button type="button" class="rm" data-rm="${i}">×</button></div>`).join('');
    thumbs.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => {
      images.splice(+b.dataset.rm, 1);
      renderImgs();
    }));
  };
  modal.querySelector('#draft-img-input').addEventListener('change', async (e) => {
    const files = [...e.target.files].slice(0, 3 - images.length);
    e.target.value = '';
    for (const f of files) {
      if (images.length >= 3) { toast('最多 3 张', 'error'); break; }
      try { images.push(await compressImageFile(f)); } catch (err) { toast(err.message, 'error'); }
    }
    renderImgs();
  });

  // OCR
  modal.querySelector('#btn-ocr').addEventListener('click', async (e) => {
    if (!images.length) { toast('请先上传照片', 'error'); return; }
    const btn = e.currentTarget;
    const status = modal.querySelector('#ocr-status');
    const engine = modal.querySelector('input[name="ocr-engine"]:checked').value;
    btn.disabled = true;
    status.innerHTML = '<span class="spinner"></span> 识别中（约 10-30 秒），请稍候...';
    try {
      const res = await api.ocr(images, engine);
      const ta = modal.querySelector('#draft-text');
      ta.value = res.text;
      handwritingScore = res.handwriting_score;
      ocrImages = images.slice();
      lastSource = 'photo';
      modal.querySelector('#ocr-meta').innerHTML =
        (res.handwriting_score !== null && res.handwriting_score !== undefined
          ? `书写质量：${(res.handwriting_score * 100).toFixed(0)}%（仅供参考，不计入批改）` : `已识别（${res.endpoint || '百度 OCR'}）`)
        + (res.notes ? ` · ${escapeHtml(res.notes)}` : '');
      status.textContent = '识别完成，请校对下方文本后保存（识别结果已尽量保留原文拼写）';
      modal.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('active'));
      modal.querySelector('[data-mode="text"]').classList.add('active');
      photoPanel.style.display = 'none';
      textPanel.style.display = 'block';
      updateWc();
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // 词数
  const ta = modal.querySelector('#draft-text');
  const wcEl = modal.querySelector('#modal-wc');
  const updateWc = () => {
    const n = countWords(ta.value);
    wcEl.textContent = `${n} 词（要求 200-500 词）`;
    wcEl.className = 'wordcount-hint ' + (n >= 200 && n <= 500 ? 'ok' : n >= 160 ? 'bad' : '');
  };
  ta.addEventListener('input', updateWc);
  updateWc();

  // 保存
  modal.querySelector('#btn-save-new-draft').addEventListener('click', async (e) => {
    const text = ta.value.trim();
    if (text.length < 10) { toast('稿件内容过短', 'error'); return; }
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      const res = await api.createDraft(state.essay.id, {
        text,
        source: lastSource,
        handwriting_score: lastSource === 'photo' ? handwritingScore : undefined,
        ocr_images: lastSource === 'photo' ? ocrImages : [],
      });
      toast(`已保存为${nextName}`, 'success');
      closeWbModal();
      activeDraftId = res.draft_id;
      await reload(state.essay.id);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = `保存${nextName}`;
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
  setTimeout(() => {
    if (disposed) return;
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
    <button class="btn btn-primary" id="btn-run-polish">开始精修</button>
    <div id="polish-result" style="margin-top:16px"></div>
  `);

  modal.querySelector('#btn-run-polish').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const d = activeDraft();
    if (!d) return;
    btn.disabled = true; btn.textContent = '精修中（约 10-30 秒）...';
    try {
      const res = await api.polish(state.essay.id, {
        mode: 'fragment',
        fragment,
        instruction: modal.querySelector('#polish-instruction').value.trim(),
        draft_id: d.id,
      });
      renderPolishResult(modal.querySelector('#polish-result'), res.result, fragment);
      btn.textContent = '重新精修';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function renderPolishResult(container, result, fragment) {
  const d = activeDraft();
  container.innerHTML = `
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
    btn.disabled = true; btn.textContent = '创建中...';
    try {
      const res = await api.createDraft(state.essay.id, { text: newText, source: 'polish' });
      toast('已采纳为新稿件', 'success');
      closeWbModal();
      activeDraftId = res.draft_id;
      await reload(state.essay.id);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = '采纳为新稿件';
    }
  }));
}

// ============================================================
// 全文润色
// ============================================================
async function runFullRewrite(e) {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '润色中（约 10-30 秒）...';
  let res;
  try {
    res = await api.polish(state.essay.id, { mode: 'full', draft_id: activeDraft().id });
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false; btn.textContent = '全文润色';
    return;
  }
  btn.disabled = false; btn.textContent = '全文润色';

  const r = res.result;
  const modal = wbModal(`
    <div class="form-group">
      <div style="font-size:13px;color:var(--text-soft);line-height:1.8">${escapeHtml(r.summary || '')}</div>
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
  `, { wide: true });

  modal.querySelector('#btn-copy-rewrite').addEventListener('click', () => {
    navigator.clipboard?.writeText(r.rewritten.replace(/\*\*/g, '')).then(() => toast('已复制', 'success'));
  });
  modal.querySelector('#btn-adopt-rewrite').addEventListener('click', async (ev) => {
    const btn2 = ev.currentTarget;
    btn2.disabled = true; btn2.textContent = '创建中...';
    try {
      const created = await api.createDraft(state.essay.id, {
        text: r.rewritten.replace(/\*\*/g, ''), source: 'polish',
      });
      toast('已保存为新稿件', 'success');
      closeWbModal();
      activeDraftId = created.draft_id;
      await reload(state.essay.id);
    } catch (err) {
      toast(err.message, 'error');
      btn2.disabled = false; btn2.textContent = '采纳润色稿为新稿件';
    }
  });
}

// ============================================================
// 批改提示词（本作文覆盖）
// ============================================================
async function openPromptModal() {
  const e = state.essay;
  let defaultPrompt = '';
  try {
    const data = await api.getPrompts();
    defaultPrompt = data.prompts.find(p => p.genre === e.genre)?.content || '';
  } catch { /* ignore */ }

  const modal = wbModal(`
    <p style="font-size:13px;color:var(--text-soft);margin-bottom:12px">
      本作文批改使用的系统提示词。留空 = 使用「设置」里的全局模板（或内置默认）。
      必须保留 <code>{essay}</code>；可用占位符：<code>{topic}</code> <code>{essay}</code> <code>{word_count}</code> <code>{previous_feedback}</code>
    </p>
    <textarea class="form-input" id="essay-prompt" rows="12" style="font-family:var(--font-mono);font-size:12px;line-height:1.6">${escapeHtml(e.custom_prompt || defaultPrompt)}</textarea>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" id="btn-save-prompt">保存（仅本作文）</button>
      ${e.custom_prompt ? '<button class="btn" id="btn-clear-prompt">清除自定义</button>' : ''}
    </div>
  `, { wide: true });

  modal.querySelector('#btn-save-prompt').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const content = modal.querySelector('#essay-prompt').value;
    if (content.trim() && !content.includes('{essay}')) {
      toast('提示词必须包含 {essay} 占位符', 'error');
      return;
    }
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      await api.updateEssay(e.id, { custom_prompt: content.trim() });
      toast('提示词已保存', 'success');
      closeWbModal();
      await reload(e.id);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = '保存（仅本作文）';
    }
  });

  const clearBtn = modal.querySelector('#btn-clear-prompt');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    try {
      await api.updateEssay(e.id, { custom_prompt: null });
      toast('已清除，回落全局模板', 'success');
      closeWbModal();
      await reload(e.id);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================
// 通用模态框
// ============================================================
let wbModalEl = null;
let wbModalKeydown = null;

function wbModal(innerHtml, opts = {}) {
  closeWbModal();
  wbModalEl = document.createElement('div');
  wbModalEl.className = 'modal-overlay open';
  wbModalEl.innerHTML = `<div class="modal" style="${opts.wide ? 'max-width:860px' : ''};max-height:85vh;overflow-y:auto">
    <div class="modal-header">
      <span class="modal-title">${opts.title || ''}</span>
      <button class="modal-close" id="wb-modal-close" title="关闭">×</button>
    </div>
    <div class="modal-body">${innerHtml}</div>
  </div>`;
  document.body.appendChild(wbModalEl);
  wbModalEl.querySelector('#wb-modal-close').addEventListener('click', closeWbModal);
  wbModalEl.addEventListener('mousedown', ev => { if (ev.target === wbModalEl) closeWbModal(); });
  wbModalKeydown = ev => { if (ev.key === 'Escape') closeWbModal(); };
  document.addEventListener('keydown', wbModalKeydown);
  return wbModalEl;
}

function closeWbModal() {
  if (wbModalKeydown) { document.removeEventListener('keydown', wbModalKeydown); wbModalKeydown = null; }
  if (wbModalEl) { wbModalEl.remove(); wbModalEl = null; }
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
        improvement: latestReview(d).result.improvement || null,
      } : null,
    })),
  };
}
