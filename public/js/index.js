// ============================================================
// index.js — 作文列表 + 新建作文（swup 管理：导出 init/cleanup）
// ============================================================

import { api, toast, requireAuth, escapeHtml, formatBeijingTime, compressImageFile, gradeFor } from './api.js?v=20261026b';

let generation = 0;
/** 新建表单暂存的题目图片（data URL） */
let topicImages = [];
let compressionPending = false;
let createPending = false;

export function cleanup() {
  generation++;
  topicImages = [];
  compressionPending = false;
  createPending = false;
}

export async function init() {
  const gen = ++generation;
  const user = await requireAuth();
  if (!user || gen !== generation) return;

  bindCreateForm(gen);
  await loadEssays(gen);
}

// ── 新建作文 ──
function bindCreateForm(gen) {
  const form = document.getElementById('create-essay-form');
  const fileInput = document.getElementById('new-topic-images');
  const thumbs = document.getElementById('new-topic-thumbs');
  const submitBtn = form.querySelector('button[type=submit]');
  const syncSubmit = () => {
    submitBtn.disabled = compressionPending || createPending;
    submitBtn.textContent = compressionPending ? '图片处理中...' : createPending ? '创建中...' : '创建并进入工作台';
  };

  fileInput.addEventListener('change', async () => {
    const available = 3 - topicImages.length;
    const selected = [...fileInput.files];
    const files = selected.slice(0, available);
    fileInput.value = '';
    if (!files.length) { toast('题目图片最多 3 张', 'error'); return; }
    if (selected.length > files.length) toast('题目图片最多 3 张，超出部分已忽略', 'error');

    compressionPending = true;
    fileInput.disabled = true;
    syncSubmit();
    const results = await Promise.allSettled(files.map(f => compressImageFile(f)));
    if (gen !== generation) return;
    for (const result of results) {
      if (result.status === 'fulfilled') topicImages.push(result.value);
      else toast(result.reason?.message || '图片处理失败', 'error');
    }
    compressionPending = false;
    fileInput.disabled = false;
    renderThumbs(thumbs);
    syncSubmit();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (createPending) return;
    if (compressionPending) { toast('图片仍在处理，请稍候', 'error'); return; }
    const title = document.getElementById('new-title').value.trim();
    const topic = document.getElementById('new-topic').value.trim();
    if (!title || !topic) return;

    createPending = true;
    syncSubmit();
    try {
      const res = await api.createEssay({
        title,
        genre: document.getElementById('new-genre').value,
        topic_text: topic,
        topic_images: topicImages.slice(),
      });
      if (gen !== generation) return;
      window.swupNavigate(`/essay.html?id=${res.essay_id}`);
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation) { createPending = false; syncSubmit(); }
    }
  });
}

function renderThumbs(container) {
  container.innerHTML = topicImages.map((url, i) => `
    <div class="thumb">
      <img src="${escapeHtml(url)}" alt="题目图片 ${i + 1}">
      <button type="button" class="rm" data-rm="${i}" title="移除这张图片" aria-label="移除题目图片 ${i + 1}">×</button>
    </div>`).join('');
  container.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => {
    topicImages.splice(+b.dataset.rm, 1);
    renderThumbs(container);
  }));
}

// ── 作文列表 ──
async function loadEssays(gen) {
  const el = document.getElementById('essay-list');
  el.innerHTML = '<div class="card"><span class="spinner"></span> 加载中...</div>';
  el.setAttribute('aria-busy', 'true');

  let data;
  try {
    data = await api.getEssays();
  } catch (err) {
    if (gen !== generation || !el.isConnected) return;
    el.removeAttribute('aria-busy');
    el.innerHTML = `<div class="card">加载失败：${escapeHtml(err.message)}</div>`;
    return;
  }
  if (gen !== generation || !el.isConnected) return;
  el.removeAttribute('aria-busy');

  if (!data.essays.length) {
    el.innerHTML = '<div class="card" style="text-align:center;color:var(--text-soft);padding:32px">还没有作文。从上方新建一篇开始吧（注册自带一篇示例）。</div>';
    return;
  }

  // 每项是真实 <a>：可键盘 Tab 聚焦、可中键/右键新窗口打开、可被读屏识别为链接
  el.innerHTML = data.essays.map((e, i) => {
    const g = e.latest_score !== null ? gradeFor(e.latest_score) : null;
    return `
    <a class="card card-link motion-reveal" href="/essay.html?id=${encodeURIComponent(e.id)}"
       style="margin-bottom:12px;animation-delay:${Math.min(i, 8) * 35}ms" data-essay="${e.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="min-width:0">
          <div style="font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.title)}</div>
          <div style="font-size:12px;color:var(--text-light);margin-top:4px">
            <span class="badge badge-completed">${escapeHtml(e.genre_label)}</span>
            ${e.draft_count} 稿 · 更新于 ${formatBeijingTime(e.updated_at)}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          ${e.latest_score !== null
            ? `<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
                 <div style="font-size:22px;font-weight:700;color:var(--primary);font-variant-numeric:tabular-nums">${e.latest_score}<small style="font-size:12px;color:var(--text-light)">/${25}</small></div>
                 ${g ? `<span class="grade-badge grade-sm g-${g.grade}">${g.grade}</span>` : ''}
               </div>
               <div style="font-size:11px;color:var(--text-light)">最新得分${g ? ` · ${g.label}` : ''}</div>`
            : '<div style="font-size:12px;color:var(--text-light)">未批改</div>'}
        </div>
      </div>
    </a>`;
  }).join('');
}
