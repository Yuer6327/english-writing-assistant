// ============================================================
// index.js — 作文列表 + 新建作文（swup 管理：导出 init/cleanup）
// ============================================================

import { api, toast, requireAuth, escapeHtml, formatBeijingTime, compressImageFile } from './api.js';

let disposed = false;
/** 新建表单暂存的题目图片（data URL） */
let topicImages = [];

export function cleanup() {
  disposed = true;
  topicImages = [];
}

export async function init() {
  disposed = false;
  const user = await requireAuth();
  if (!user || disposed) return;

  bindCreateForm();
  await loadEssays();
}

// ── 新建作文 ──
function bindCreateForm() {
  const form = document.getElementById('create-essay-form');
  const fileInput = document.getElementById('new-topic-images');
  const thumbs = document.getElementById('new-topic-thumbs');

  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files].slice(0, 3 - topicImages.length);
    fileInput.value = '';
    for (const f of files) {
      if (topicImages.length >= 3) { toast('题目图片最多 3 张', 'error'); break; }
      try {
        topicImages.push(await compressImageFile(f));
      } catch (err) { toast(err.message, 'error'); }
    }
    renderThumbs(thumbs);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-title').value.trim();
    const topic = document.getElementById('new-topic').value.trim();
    if (!title || !topic) return;

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '创建中...';

    try {
      const res = await api.createEssay({
        title,
        genre: document.getElementById('new-genre').value,
        topic_text: topic,
        topic_images: topicImages,
      });
      window.swupNavigate(`/essay.html?id=${res.essay_id}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = '创建并进入工作台';
    }
  });
}

function renderThumbs(container) {
  container.innerHTML = topicImages.map((url, i) => `
    <div class="thumb">
      <img src="${url}" alt="题目图片 ${i + 1}">
      <button type="button" class="rm" data-rm="${i}" title="移除">×</button>
    </div>`).join('');
  container.querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => {
    topicImages.splice(+b.dataset.rm, 1);
    renderThumbs(container);
  }));
}

// ── 作文列表 ──
async function loadEssays() {
  const el = document.getElementById('essay-list');
  el.innerHTML = '<div class="card"><span class="spinner"></span> 加载中...</div>';

  let data;
  try {
    data = await api.getEssays();
  } catch (err) {
    if (disposed) return;
    el.innerHTML = `<div class="card">加载失败：${escapeHtml(err.message)}</div>`;
    return;
  }
  if (disposed) return;

  if (!data.essays.length) {
    el.innerHTML = '<div class="card" style="text-align:center;color:var(--text-soft);padding:32px">还没有作文。从上方新建一篇开始吧（注册自带一篇示例）。</div>';
    return;
  }

  el.innerHTML = data.essays.map(e => `
    <div class="card" style="margin-bottom:12px;cursor:pointer" data-essay="${e.id}">
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
            ? `<div style="font-size:22px;font-weight:700;color:var(--primary)">${e.latest_score}<small style="font-size:12px;color:var(--text-light)">/${25}</small></div>
               <div style="font-size:11px;color:var(--text-light)">最新得分</div>`
            : '<div style="font-size:12px;color:var(--text-light)">未批改</div>'}
        </div>
      </div>
    </div>`).join('');

  el.querySelectorAll('[data-essay]').forEach(card =>
    card.addEventListener('click', () => {
      window.swupNavigate(`/essay.html?id=${card.dataset.essay}`);
    }));
}
