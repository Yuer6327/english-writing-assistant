// ============================================================
// export.js — 批改报告导出（Word .docx / PDF）
// 纯前端生成，第三方库按需从 jsdmirror 镜像 CDN 加载（复用兄弟项目方案）：
//   - DOCX：docx 库（UMD 全局 docx），本文件内实现
//   - PDF ：A4 打印版报告，见 ./pdf-report.js（pdf-lib + Noto Sans SC）
// 由 essay.js 调用 openExportModal({ mode:'report', getData })。
// ============================================================

import { loadScript, toast, gradeFor } from './api.js?v=20261031a';
import { buildPdfBlob } from './pdf-report.js?v=20261101c';

// ── CDN 资源 ──
// 脚本带 SRI（sha384）：镜像被投毒时浏览器拒绝执行，供应链风险收敛为「不可用」而非「任意代码」。
const DOCX_CDN = 'https://cdn.jsdmirror.com/npm/docx@8.5.0/build/index.umd.js';
/** SRI 与上面的固定版本 URL 一一对应；升级版本号必须同步重算（下载文件算 sha384） */
const SRI = {
  [DOCX_CDN]: 'sha384-4xaIisuLEy2lo2HkB2C4rEf7v8jbTb2kuogX6TkuEt9feTWKBSFSOzsqNNbV+sKh',
};

const _libs = { docx: null };

async function ensureDocx() {
  if (_libs.docx) return _libs.docx;
  if (window.docx) { _libs.docx = window.docx; return _libs.docx; }
  await loadScript(DOCX_CDN, SRI[DOCX_CDN]);
  _libs.docx = window.docx;
  if (!_libs.docx) throw new Error('Word 生成组件加载失败，请检查网络后重试');
  return _libs.docx;
}

// ============================================================
// 模态框
// ============================================================

let modalEl = null;
let modalResolve = null;
let modalReturnFocus = null;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onModalKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeModal(false); return; }
  if (e.key !== 'Tab' || !modalEl) return;
  // 焦点陷阱：Tab 在对话框内循环
  const nodes = [...modalEl.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** 打开导出配置模态框。opts: { mode:'report', getData: async () => payload } */
export function openExportModal(opts) {
  closeModal(false, null, true);
  modalResolve = null;
  modalReturnFocus = document.activeElement;

  modalEl = document.createElement('div');
  modalEl.className = 'modal-overlay';
  modalEl.id = 'export-modal';
  modalEl.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="导出批改报告">
      <div class="modal-header">
        <span class="modal-title">导出批改报告</span>
        <button type="button" class="modal-close" data-export-close title="关闭" aria-label="关闭对话框">×</button>
      </div>
      <div class="modal-body">
        <fieldset style="border:0;padding:0;margin:0 0 16px">
          <legend class="form-label">格式</legend>
          <div class="export-options">
            <label class="export-option">
              <input type="radio" name="export-format" value="docx" checked>
              <span class="opt-name">Word (.docx)</span>
              <span class="opt-desc">排版精确，可继续编辑</span>
            </label>
            <label class="export-option">
              <input type="radio" name="export-format" value="pdf">
              <span class="opt-name">PDF</span>
              <span class="opt-desc">A4 排版，适合打印/归档</span>
            </label>
          </div>
        </fieldset>
        <fieldset style="border:0;padding:0;margin:0 0 16px">
          <legend class="form-label">包含稿件</legend>
          <div class="export-options">
            <label class="export-option">
              <input type="radio" name="export-scope" value="all" checked>
              <span class="opt-name">全部稿件</span>
              <span class="opt-desc">每稿全文+批改+进步对比</span>
            </label>
            <label class="export-option">
              <input type="radio" name="export-scope" value="latest">
              <span class="opt-name">仅最新稿</span>
              <span class="opt-desc">只导最新一稿及其批改</span>
            </label>
          </div>
        </fieldset>
        <button type="button" class="btn btn-primary btn-block" data-export-confirm>导出</button>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  requestAnimationFrame(() => modalEl?.classList.add('open'));

  modalEl.querySelectorAll('[data-export-close]').forEach(b => b.addEventListener('click', () => closeModal(false)));
  modalEl.addEventListener('mousedown', e => { if (e.target === modalEl) closeModal(false); });
  document.addEventListener('keydown', onModalKeydown);

  const confirmBtn = modalEl.querySelector('[data-export-confirm]');
  if (confirmBtn) {
    try { confirmBtn.focus({ preventScroll: true }); } catch { /* 忽略 */ }
  }

  confirmBtn.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const modal = modalEl;
    const format = modal.querySelector('input[name="export-format"]:checked').value;
    const scope = modal.querySelector('input[name="export-scope"]:checked').value;
    btn.disabled = true; btn.textContent = '生成中...';

    try {
      const payload = await opts.getData();
      const drafts = scope === 'latest' ? payload.drafts.slice(-1) : payload.drafts;
      const data = { ...payload, drafts };

      const blob = format === 'docx' ? await buildDocxBlob(data) : await buildPdfBlob(data);
      const ext = format === 'docx' ? 'docx' : 'pdf';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = sanitizeFilename(`${data.title}-批改报告.${ext}`);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      closeModal(true, modal);
    } catch (err) {
      if (modal === modalEl) {
        toast(err.message || '导出失败', 'error');
        btn.disabled = false; btn.textContent = '导出';
      }
    }
  });
}

function closeModal(ok, expected = null, immediate = false) {
  if (expected && expected !== modalEl) return; // 旧导出任务不能误关新模态框
  document.removeEventListener('keydown', onModalKeydown);
  const el = modalEl;
  modalEl = null;
  if (modalResolve) { modalResolve(ok); modalResolve = null; }
  // 焦点归还触发按钮
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if (back && typeof back.focus === 'function' && back.isConnected) {
    try { back.focus({ preventScroll: true }); } catch { /* 忽略 */ }
  }
  if (!el) return;
  if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.remove(); return; }
  el.classList.remove('open');
  el.classList.add('closing');
  setTimeout(() => el.remove(), 180);
}

export function closeExportModal() {
  closeModal(false, null, true);
}

function sanitizeFilename(name) {
  return String(name || 'report').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

const cnNum = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

// ============================================================
// 内容文本化（docx 共用）
// ============================================================

function draftHeadline(d, total) {
  const name = `${cnNum[d.version - 1] || d.version}稿`;
  if (!d.review) return `${name}（未批改）`;
  const g = gradeFor(d.review.score);
  return `${name}（得分 ${d.review.score}/${total}${g ? ` · ${g.grade} 等第` : ''}）`;
}

// ============================================================
// DOCX 生成
// ============================================================

/** 把含 **粗体** 标记的文本拆成 docx TextRun 数组 */
function boldRuns(docx, text, opts = {}) {
  const runs = [];
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    runs.push(new docx.TextRun({ text: m ? m[1] : p, bold: !!m, ...opts }));
  }
  return runs;
}

async function buildDocxBlob(data) {
  const docx = await ensureDocx();
  const { Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = docx;

  const children = [];
  const p = (opts) => children.push(new Paragraph(opts));

  // 标题与元信息
  p(new Paragraph({ text: data.title, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }));
  p(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `${data.genre_label} · 满分 ${data.total} 分 · ${new Date().toLocaleDateString('zh-CN')}`, color: '888888', size: 20 })],
  }));

  // 题目
  p(new Paragraph({ text: '【题目】', heading: HeadingLevel.HEADING_2 }));
  for (const line of data.topic.split('\n')) {
    if (line.trim()) p(new Paragraph({ children: [new TextRun({ text: line })], spacing: { after: 80 } }));
  }

  // 各稿
  for (const d of data.drafts) {
    p(new Paragraph({ text: draftHeadline(d, data.total), heading: HeadingLevel.HEADING_2 }));
    p(new Paragraph({
      children: [new TextRun({ text: `${d.word_count} 词${d.handwriting_score != null ? ` · 书写质量 ${(d.handwriting_score * 100).toFixed(0)}%` : ''}`, color: '888888', size: 20 })],
    }));

    p(new Paragraph({ text: '作文全文', heading: HeadingLevel.HEADING_3 }));
    for (const para of d.text.split(/\n+/)) {
      if (para.trim()) p(new Paragraph({ children: [new TextRun({ text: para.trim() })], spacing: { after: 120 } }));
    }

    const r = d.review;
    if (!r) continue;

    const g = gradeFor(r.score);
    p(new Paragraph({
      children: [
        new TextRun({ text: '批改结果  ', bold: true }),
        new TextRun({ text: `总分 ${r.score}/${data.total}`, bold: true, color: '3056D3' }),
        ...(g ? [new TextRun({ text: `（${g.grade} 等第 · ${g.label}）`, bold: true, color: '2F6B3F' })] : []),
        new TextRun({ text: `（内容 ${r.subscores.content}/10 · 语言 ${r.subscores.language}/10 · 结构 ${r.subscores.organization}/5）`, color: '555555' }),
      ],
    }));

    if (r.priority) {
      p(new Paragraph({ children: [new TextRun({ text: `最该改：`, bold: true, color: 'C0392B' }), new TextRun({ text: r.priority })], spacing: { after: 60 } }));
    }
    if (r.highlight) {
      p(new Paragraph({ children: [new TextRun({ text: `亮点：`, bold: true, color: '2F6B3F' }), new TextRun({ text: r.highlight })], spacing: { after: 120 } }));
    }
    if (r.basis && (r.basis.content || r.basis.language || r.basis.organization)) {
      p(new Paragraph({ text: '分项依据', heading: HeadingLevel.HEADING_3 }));
      const basis = [
        ['内容', r.basis.content], ['语言', r.basis.language], ['结构', r.basis.organization],
      ];
      for (const [name, txt] of basis) {
        if (txt) p(new Paragraph({
          children: [new TextRun({ text: `${name}：`, bold: true }), new TextRun({ text: txt })],
          spacing: { after: 80 },
        }));
      }
    }
    if (r.issues && r.issues.length) {
      p(new Paragraph({ text: '问题清单', heading: HeadingLevel.HEADING_3 }));
      for (const iss of r.issues) {
        p(new Paragraph({
          children: [
            new TextRun({ text: `[${iss.type}] `, bold: true, color: 'C0392B' }),
            new TextRun({ text: `"${iss.quote}" `, italics: true, color: '777777' }),
            new TextRun({ text: `→ ${iss.correction}`, bold: true, color: '2F6B3F' }),
          ],
          spacing: { after: 40 },
        }));
        if (iss.explanation) {
          p(new Paragraph({ children: [new TextRun({ text: iss.explanation, size: 20, color: '666666' })], spacing: { after: 100 }, indent: { left: 360 } }));
        }
      }
    }
    if (r.revised_essay) {
      p(new Paragraph({ text: '修改后的全文', heading: HeadingLevel.HEADING_3 }));
      for (const para of r.revised_essay.split(/\n+/)) {
        if (para.trim()) p(new Paragraph({ children: boldRuns(docx, para.trim()), spacing: { after: 120 } }));
      }
    }
    if (r.suggestions && r.suggestions.length) {
      p(new Paragraph({ text: '提升建议', heading: HeadingLevel.HEADING_3 }));
      for (const s of r.suggestions) {
        p(new Paragraph({ text: `• ${s}`, spacing: { after: 60 } }));
      }
    }
    if (r.improvement) {
      const imp = r.improvement;
      p(new Paragraph({ text: `较上一稿：${imp.score_delta >= 0 ? '+' : ''}${imp.score_delta} 分`, heading: HeadingLevel.HEADING_3 }));
      const lines = [
        ...(imp.fixed || []).map(x => `已解决 ✓ ${x}`),
        ...(imp.remaining || []).map(x => `仍存在 ⏳ ${x}`),
        ...(imp.regression || []).map(x => `新引入 ⚠ ${x}`),
      ];
      for (const l of lines) p(new Paragraph({ text: l, spacing: { after: 60 } }));
    }
  }

  const doc = new docx.Document({
    sections: [{
      properties: {},
      children,
    }],
  });
  return docx.Packer.toBlob(doc);
}
