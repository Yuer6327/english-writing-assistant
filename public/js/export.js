// ============================================================
// export.js — 批改报告导出（Word .docx / PDF）
// 纯前端生成，第三方库按需从 jsdmirror 镜像 CDN 加载（复用兄弟项目方案）：
//   - DOCX：docx 库（UMD 全局 docx）
//   - PDF ：pdf-lib + @pdf-lib/fontkit + Noto Sans SC（中文字体运行时抓取一次并缓存）
// 由 essay.js 调用 openExportModal({ mode:'report', getData })。
// ============================================================

import { loadScript, toast } from './api.js';

// ── CDN 资源（jsdmirror 镜像）──
const DOCX_CDN = 'https://cdn.jsdmirror.com/npm/docx@8.5.0/build/index.umd.js';
const PDFLIB_CDN = 'https://cdn.jsdmirror.com/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const FONTKIT_CDN = 'https://cdn.jsdmirror.com/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js';
const NOTO_FONT_URL = 'https://cdn.jsdmirror.com/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf';

const _libs = { docx: null, PDFLib: null, fontkit: null, notoFont: null };

async function ensureDocx() {
  if (_libs.docx) return _libs.docx;
  if (window.docx) { _libs.docx = window.docx; return _libs.docx; }
  await loadScript(DOCX_CDN);
  _libs.docx = window.docx;
  if (!_libs.docx) throw new Error('Word 生成组件加载失败，请检查网络后重试');
  return _libs.docx;
}

async function ensurePdfLib() {
  if (_libs.PDFLib && _libs.fontkit) return { PDFLib: _libs.PDFLib, fontkit: _libs.fontkit };
  if (window.PDFLib && window.fontkit) {
    _libs.PDFLib = window.PDFLib; _libs.fontkit = window.fontkit;
    return { PDFLib: _libs.PDFLib, fontkit: _libs.fontkit };
  }
  await Promise.all([loadScript(PDFLIB_CDN), loadScript(FONTKIT_CDN)]);
  _libs.PDFLib = window.PDFLib; _libs.fontkit = window.fontkit;
  if (!_libs.PDFLib || !_libs.fontkit) throw new Error('PDF 生成组件加载失败，请检查网络后重试');
  return { PDFLib: _libs.PDFLib, fontkit: _libs.fontkit };
}

function ensureNotoFont() {
  if (_libs.notoFont) return _libs.notoFont;
  _libs.notoFont = fetch(NOTO_FONT_URL).then(r => {
    if (!r.ok) throw new Error('中文字体下载失败（HTTP ' + r.status + '），请检查网络后重试');
    return r.arrayBuffer();
  }).catch(err => { _libs.notoFont = null; throw err; });
  return _libs.notoFont;
}

// ============================================================
// 模态框
// ============================================================

let modalEl = null;
let modalResolve = null;

function onModalKeydown(e) { if (e.key === 'Escape') closeModal(false); }

/** 打开导出配置模态框。opts: { mode:'report', getData: async () => payload } */
export function openExportModal(opts) {
  closeModal(false);
  modalResolve = null;

  modalEl = document.createElement('div');
  modalEl.className = 'modal-overlay';
  modalEl.id = 'export-modal';
  modalEl.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">导出批改报告</span>
        <button class="modal-close" data-export-close title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">格式</label>
          <div class="export-options">
            <label class="export-option">
              <input type="radio" name="export-format" value="docx" checked>
              <span class="opt-name">Word (.docx)</span>
              <span class="opt-desc">排版精确，可继续编辑</span>
            </label>
            <label class="export-option">
              <input type="radio" name="export-format" value="pdf">
              <span class="opt-name">PDF</span>
              <span class="opt-desc">适合打印/发送</span>
            </label>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">包含稿件</label>
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
        </div>
        <button type="button" class="btn btn-primary btn-block" data-export-confirm>导出</button>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  requestAnimationFrame(() => modalEl.classList.add('open'));

  modalEl.querySelectorAll('[data-export-close]').forEach(b => b.addEventListener('click', () => closeModal(false)));
  modalEl.addEventListener('mousedown', e => { if (e.target === modalEl) closeModal(false); });
  document.addEventListener('keydown', onModalKeydown);

  modalEl.querySelector('[data-export-confirm]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const format = modalEl.querySelector('input[name="export-format"]:checked').value;
    const scope = modalEl.querySelector('input[name="export-scope"]:checked').value;
    btn.disabled = true; btn.textContent = '生成中...（首次导出需下载字体/组件）';

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
      closeModal(true);
    } catch (err) {
      toast(err.message || '导出失败', 'error');
      btn.disabled = false; btn.textContent = '导出';
    }
  });
}

function closeModal(ok) {
  document.removeEventListener('keydown', onModalKeydown);
  if (modalEl) { modalEl.remove(); modalEl = null; }
  if (modalResolve) { modalResolve(ok); modalResolve = null; }
}

function sanitizeFilename(name) {
  return String(name || 'report').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

const cnNum = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

// ============================================================
// 内容文本化（PDF 与文件名共用）
// ============================================================

/** **粗体** → 纯文本 */
function stripBold(s) {
  return String(s || '').replace(/\*\*/g, '');
}

function draftHeadline(d, total) {
  const name = `${cnNum[d.version - 1] || d.version}稿`;
  return d.review ? `${name}（得分 ${d.review.score}/${total}）` : `${name}（未批改）`;
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

    p(new Paragraph({
      children: [
        new TextRun({ text: '批改结果  ', bold: true }),
        new TextRun({ text: `总分 ${r.score}/${data.total}`, bold: true, color: '3056D3' }),
        new TextRun({ text: `（内容 ${r.subscores.content}/10 · 语言 ${r.subscores.language}/10 · 结构 ${r.subscores.organization}/5）`, color: '555555' }),
      ],
    }));

    if (r.overall_comment) {
      p(new Paragraph({ text: '总评', heading: HeadingLevel.HEADING_3 }));
      p(new Paragraph({ children: [new TextRun({ text: r.overall_comment })], spacing: { after: 120 } }));
    }
    if (r.diagnosis && (r.diagnosis.content || r.diagnosis.language || r.diagnosis.organization)) {
      p(new Paragraph({ text: '逐项诊断', heading: HeadingLevel.HEADING_3 }));
      const diag = [
        ['内容', r.diagnosis.content], ['语言', r.diagnosis.language], ['结构', r.diagnosis.organization],
      ];
      for (const [name, txt] of diag) {
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

// ============================================================
// PDF 生成（pdf-lib + fontkit + Noto Sans SC）
// ============================================================

const P = { pageW: 595.28, pageH: 841.89, marginL: 72, marginR: 72, marginT: 64, marginB: 64 };
P.contentW = P.pageW - P.marginL - P.marginR;

/** 中英文混合贪心折行：英文按空格断，中文任意位置断 */
function wrapText(font, text, size, maxW) {
  const lines = [];
  let line = '';
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  for (const ch of src) {
    if (ch === ' ' && !line) continue;
    if (font.widthOfTextAtSize(line + ch, size) <= maxW) { line += ch; continue; }
    const sp = line.lastIndexOf(' ');
    if (sp > 0) { lines.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
    else { lines.push(line); line = ch; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

async function buildPdfBlob(data) {
  const { PDFLib, fontkit } = await ensurePdfLib();
  const fontBytes = await ensureNotoFont();

  const pdfDoc = await PDFLib.PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBytes, { subset: true });
  const { rgb } = PDFLib;

  const textColor = rgb(0.15, 0.15, 0.15);
  const softColor = rgb(0.45, 0.45, 0.45);
  const primaryColor = rgb(0.19, 0.34, 0.83);

  let page = null;
  let cursor = 0;

  const newPage = () => {
    page = pdfDoc.addPage([P.pageW, P.pageH]);
    cursor = P.pageH - P.marginT;
  };
  const ensureSpace = (h) => { if (cursor - h < P.marginB) newPage(); };

  const drawLines = (text, size, color, gap = 4, indent = 0) => {
    const lh = size * 1.6;
    for (const line of wrapText(font, stripBold(text), size, P.contentW - indent)) {
      ensureSpace(lh);
      page.drawText(line, { x: P.marginL + indent, y: cursor - size, size, font, color });
      cursor -= lh;
    }
    cursor -= gap;
  };

  const drawTitle = (text, size) => {
    const lh = size * 1.7;
    for (const line of wrapText(font, stripBold(text), size, P.contentW)) {
      ensureSpace(lh);
      const w = font.widthOfTextAtSize(line, size);
      page.drawText(line, { x: (P.pageW - w) / 2, y: cursor - size, size, font, color: textColor });
      cursor -= lh;
    }
    cursor -= 6;
  };

  const drawHeading = (text, size = 13) => {
    ensureSpace(size * 2.4);
    cursor -= size * 0.6;
    page.drawText(stripBold(text), { x: P.marginL, y: cursor - size, size, font, color: primaryColor });
    cursor -= size * 1.6;
    page.drawLine({
      start: { x: P.marginL, y: cursor + 2 }, end: { x: P.pageW - P.marginR, y: cursor + 2 },
      thickness: 0.6, color: rgb(0.85, 0.85, 0.85),
    });
    cursor -= 4;
  };

  newPage();
  drawTitle(data.title, 20);
  drawTitle(`${data.genre_label} · 满分 ${data.total} 分 · ${new Date().toLocaleDateString('zh-CN')}`, 10);

  drawHeading('题目');
  drawLines(data.topic, 11, textColor, 8);

  for (const d of data.drafts) {
    ensureSpace(60);
    drawHeading(draftHeadline(d, data.total), 14);
    drawLines(`${d.word_count} 词${d.handwriting_score != null ? ` · 书写质量 ${(d.handwriting_score * 100).toFixed(0)}%` : ''}`, 9, softColor, 6);

    drawHeading('作文全文', 12);
    for (const para of d.text.split(/\n+/)) {
      if (para.trim()) drawLines(para.trim(), 11, textColor, 6);
    }

    const r = d.review;
    if (!r) continue;

    drawHeading(`批改结果：总分 ${r.score}/${data.total}（内容 ${r.subscores.content}/10 · 语言 ${r.subscores.language}/10 · 结构 ${r.subscores.organization}/5）`, 12);
    if (r.overall_comment) drawLines(`总评：${r.overall_comment}`, 11, textColor, 6);

    if (r.diagnosis && (r.diagnosis.content || r.diagnosis.language || r.diagnosis.organization)) {
      drawHeading('逐项诊断', 12);
      const diag = [['内容', r.diagnosis.content], ['语言', r.diagnosis.language], ['结构', r.diagnosis.organization]];
      for (const [name, txt] of diag) if (txt) drawLines(`${name}：${txt}`, 10, textColor, 4);
    }

    if (r.issues && r.issues.length) {
      drawHeading('问题清单', 12);
      for (const iss of r.issues) {
        drawLines(`[${iss.type}] "${iss.quote}" → ${iss.correction}`, 10, textColor, 2);
        if (iss.explanation) drawLines(iss.explanation, 9, softColor, 6, 16);
      }
    }

    if (r.revised_essay) {
      drawHeading('修改后的全文（粗体升级点以普通文本呈现）', 12);
      for (const para of r.revised_essay.split(/\n+/)) {
        if (para.trim()) drawLines(para.trim(), 11, textColor, 6);
      }
    }

    if (r.suggestions && r.suggestions.length) {
      drawHeading('提升建议', 12);
      for (const s of r.suggestions) drawLines(`• ${s}`, 10, textColor, 3);
    }

    if (r.improvement) {
      const imp = r.improvement;
      drawHeading(`较上一稿：${imp.score_delta >= 0 ? '+' : ''}${imp.score_delta} 分`, 12);
      const lines = [
        ...(imp.fixed || []).map(x => `已解决 ✓ ${x}`),
        ...(imp.remaining || []).map(x => `仍存在 ⏳ ${x}`),
        ...(imp.regression || []).map(x => `新引入 ⚠ ${x}`),
      ];
      for (const l of lines) drawLines(l, 10, textColor, 3);
    }
  }

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
