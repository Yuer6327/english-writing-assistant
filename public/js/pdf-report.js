// ============================================================
// pdf-report.js — A4 批改报告 PDF（重排版，2026-11）
// ============================================================
// 设计目标：专为 A4 打印浏览排版（非网页版复刻）：
//   - 黑白为主：正文/表格纯黑，次要文字纯灰，仅少量强调色（沿用站点调色板）
//   - 报告结构：报告头 → 一、题目（+多稿得分总览表）→ 各稿一章（得分依据表、
//     亮点/最该改、原文、问题清单三列表、修改稿、提升建议、较上一稿）
//   - 页眉页脚：每页页脚（页码 X/Y + AI 免责声明），第 2 页起页眉重复作文标题
//   - 表格支持跨页且表头自动重复；**粗体**改动点以蓝色呈现（打印比加粗更醒目）
// 字体排印（2026-11-16 起「非内嵌系统字体」方案，零下载）：
//   - 西文/数字 = standard-14「Times-Roman」（Type1 + WinAnsiEncoding，pdf-lib 内建
//     AFM 度量）：查看器按标准 14 字体名映射到真 Times New Roman（Windows/macOS
//     皆自带），度量与布局一致，不重叠。**勿改成 Type0/GB1 包装西文**——查看器会
//     按「中文字体」做 CJK 替换，数字/字母变全角、整段重叠乱码（实测复现）。
//   - 中文宋体（批改文字）与楷体（题目/原文/修改稿）= Type0/UniGB-UCS2-H 命名字体
//     （2 字节大端 Unicode 即 CID；全角宽恰为 1000/1000 em，估算=实际，布局精确）。
//   - CJK 字体名按平台定制（buildPdfBlob 检测 UA）：Windows 用 SimSun/KaiTi（系统
//     自带，pdfium 实测直接解析）；macOS/iOS 用 Songti SC/Kaiti SC（宋体-简/楷体-简）；
//     其余平台由查看器 CJK 兜底。
//   - 副产品：PDF 体积从数百 KB 降到数十 KB，导出不再需要 fontkit CDN 与字体 fetch。
// 无 Bold 字重：标题层级用字号+颜色，关键小标题用同文本微小偏移重画模拟加粗（伪粗）。
//
// 分层：renderReport(data, deps) 为纯函数（deps 注入 PDFLib），
// 可在 Node 侧直接驱动做视觉回归；buildPdfBlob(data) 为浏览器壳（CDN 加载）。
// 由 export.js 调用 buildPdfBlob。

import { loadScript, gradeFor } from './api.js?v=20261101g';

// ── CDN 资源（带 SRI：镜像被投毒时浏览器拒绝执行）──
const PDFLIB_CDN = 'https://cdn.jsdmirror.com/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
/** SRI 与上面的固定版本 URL 一一对应；升级版本号必须同步重算（下载文件算 sha384） */
const SRI = {
  [PDFLIB_CDN]: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
};

const _libs = { PDFLib: null };

async function ensurePdfLib() {
  if (_libs.PDFLib) return { PDFLib: _libs.PDFLib };
  if (window.PDFLib) {
    _libs.PDFLib = window.PDFLib;
    return { PDFLib: window.PDFLib };
  }
  await loadScript(PDFLIB_CDN, SRI[PDFLIB_CDN]);
  _libs.PDFLib = window.PDFLib;
  if (!_libs.PDFLib) throw new Error('PDF 生成组件加载失败，请检查网络后重试');
  return { PDFLib: _libs.PDFLib };
}

/** 浏览器入口：按需加载 pdf-lib 后渲染。export.js 消费。 */
export async function buildPdfBlob(data) {
  const { PDFLib } = await ensurePdfLib();
  // CJK 字体名按平台定制（见文件头说明）：Apple 系用 Songti SC/Kaiti SC，其余用 SimSun/KaiTi
  const isApple = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cjkFonts = isApple ? { song: 'Songti SC', kai: 'Kaiti SC' } : { song: 'SimSun', kai: 'KaiTi' };
  // 题目配图归一：PNG/JPEG 直接用；webp/gif/bmp 等经 canvas 转成 PNG；失败的置 null 渲染端跳过
  const images = Array.isArray(data.topic_images) ? data.topic_images : [];
  const topicImages = await Promise.all(images.map(ensureEmbeddableImage));
  return renderReport(data, { PDFLib, topicImages, cjkFonts });
}

/** data URL → { bytes, kind: 'png'|'jpg' }；其他格式经 canvas 解码转 PNG；失败返回 null */
async function ensureEmbeddableImage(dataUrl) {
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    const direct = parseImageDataUrl(dataUrl);
    if (direct && direct.kind) return direct;
    // 声明为 png/jpeg 之外（webp/gif/bmp…）或魔数不符：浏览器解码后转 PNG
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return { bytes: new Uint8Array(await pngBlob.arrayBuffer()), kind: 'png' };
  } catch { return null; }
}

/** 解 data URL 为字节；按魔数判定可嵌入格式（png/jpg 返回 kind，其余 kind=null 交 canvas 兜底） */
function parseImageDataUrl(dataUrl) {
  const m = /^data:image\/([a-z+.-]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { bytes, kind: 'png' };  // \x89PNG
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return { bytes, kind: 'jpg' };  // \xFF\xD8\xFF
  return { bytes, kind: null };
}

// ============================================================
// 渲染核心（纯函数，浏览器/Node 共用）
// ============================================================

const cnNum = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 把含 **粗体** 标记的文本拆成分段：markBold=true 时 marked 段加粗（同色，伪粗双画），
 *  否则用 markColor 着色（修改稿的蓝色改动点）。 */
function splitMarked(text, baseColor, markColor, markBold = false) {
  const segs = [];
  for (const p of String(text || '').split(/(\*\*[^*]+\*\*)/g)) {
    if (!p) continue;
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    segs.push(m
      ? { text: m[1], color: markBold ? baseColor : markColor, bold: markBold }
      : { text: p, color: baseColor });
  }
  return segs.length ? segs : [{ text: '', color: baseColor }];
}

/** 非内嵌 Type0 命名字体（SimSun/KaiTi 或 Songti SC/Kaiti SC）：零下载，查看器用系统字体渲染。
 *  中文走 UniGB-UCS2-H（2 字节大端 Unicode 即 CID）；宋体/楷体全角恰为 1000/1000 em。
 *  继承 CustomFontEmbedder 仅为通过 PDFFont 的 instanceof 校验，行为均为本类自有。 */
function makeNonEmbeddedFont(PDFLib, { baseFont }) {
  const { CustomFontEmbedder, PDFName, PDFString } = PDFLib;
  class NonEmbeddedFont extends CustomFontEmbedder {
    constructor() {
      // 基类构造只读取 unitsPerEm/postscriptName/layout 等元数据；置空集即可
      super({
        unitsPerEm: 1000,
        postscriptName: baseFont,
        characterSet: [],
        layout: () => ({ glyphs: [] }),
        ascent: 880, descent: -120, bbox: { minY: -120, maxY: 880 },
      }, new Uint8Array(0));
      this.fontName = baseFont;
    }
    /** 2 字节大端 Unicode（无 BOM）：UniGB-UCS2-H 下 CID 与 UCS-2 码位一一对应 */
    encodeText(text) {
      let hex = '';
      for (const ch of String(text)) hex += ch.codePointAt(0).toString(16).padStart(4, '0');
      return PDFLib.PDFHexString.of(hex);
    }
    widthOfTextAtSize(text, size) {
      // 宋体/楷体的 CJK（含全角标点）字形宽恰为 1000/1000 em；此字体只接收 CJK 段
      return String(text).length * size;
    }
    heightOfFontAtSize(size) { return size; }
    sizeOfFontAtHeight(h) { return h; }
    async embedIntoContext(context, ref) {
      const desc = context.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: PDFName.of(baseFont),
        // Registry/Ordering 按 PDF 规范须为字符串；写成 Name 会被 pdf.js stringToPDFString 清空
        CIDSystemInfo: context.obj({
          Registry: PDFString.of('Adobe'), Ordering: PDFString.of('GB1'), Supplement: 5,
        }),
        FontDescriptor: context.obj({
          Type: 'FontDescriptor',
          FontName: PDFName.of(baseFont),
          Flags: 4,
          FontBBox: context.obj([-120, -120, 1000, 880]),
          ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80,
        }),
        DW: 1000,
      });
      const descRef = context.register(desc);
      const dict = context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: PDFName.of(baseFont),
        Encoding: PDFName.of('UniGB-UCS2-H'),
        DescendantFonts: context.obj([descRef]),
      });
      if (ref) { context.assign(ref, dict); return ref; }
      return context.register(dict);
    }
  }
  return new NonEmbeddedFont();
}

/** 挂一个非内嵌字体到文档（绕过 PDFFont.of 的 embedder instanceof 严检） */
function attachFont(PDFLib, doc, embedder) {
  const PDFFont = PDFLib.PDFFont;
  const pf = Object.create(PDFFont.prototype);
  pf.ref = doc.context.nextRef();
  pf.doc = doc;
  pf.embedder = embedder;
  pf.modified = true;
  pf.name = embedder.fontName;
  doc.fonts.push(pf);
  return pf;
}

export async function renderReport(data, { PDFLib, topicImages = [], cjkFonts = { song: 'SimSun', kai: 'KaiTi' } }) {
  const pdfDoc = await PDFLib.PDFDocument.create();
  // 三字体（非内嵌零下载）：F_SERIF=standard-14 Times-Roman（真 TNR 映射 + AFM 精确度量）；
  // F_SONG 宋体=批改文字默认中文；F_KAI 楷体=作文正文（Type0 命名字体，名随平台）
  const F_SERIF = pdfDoc.embedStandardFont(PDFLib.StandardFonts.TimesRoman);
  const F_SONG = attachFont(PDFLib, pdfDoc, makeNonEmbeddedFont(PDFLib, { baseFont: cjkFonts.song }));
  const F_KAI = attachFont(PDFLib, pdfDoc, makeNonEmbeddedFont(PDFLib, { baseFont: cjkFonts.kai }));
  const { rgb } = PDFLib;
  const hasCJK = (s) => /[\u1100-\u11FF\u2E80-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(s);
  const charFont = (s, cjk) => (hasCJK(s) ? (cjk || F_SONG) : F_SERIF);

  // ── 调色板：黑白为主 + 少数强调色（与站点 --primary/--success/sev-* 对应）──
  const C = {
    ink: rgb(0, 0, 0),                  // 正文/表格：纯黑，打印最清晰
    gray: rgb(0.5, 0.5, 0.5),           // 次要文字：纯灰 #808080
    line: rgb(0.788, 0.788, 0.788),     // 分隔线 #C9C9C9
    lineSoft: rgb(0.902, 0.902, 0.902), // 弱分隔线 #E6E6E6
    headFill: rgb(0.941, 0.941, 0.941), // 表头底 #F0F0F0
    blue: rgb(0.188, 0.337, 0.827),     // #3056D3 主色：章节编号/总分/改动点
    green: rgb(0.184, 0.42, 0.247),     // #2F6B3F：亮点/A 等第/进步
    red: rgb(0.839, 0.271, 0.271),      // #D64545：最该改/硬伤/退步
    amber: rgb(0.541, 0.353, 0.071),    // #8A5A12：轻微问题/C 等第（深琥珀，小字可读）
  };
  const GRADE_COLOR = { A: C.green, B: C.blue, C: C.amber, D: C.red };
  const SEV = {
    critical: { label: '硬伤', color: C.red },
    minor: { label: '错误', color: C.amber },
    polish: { label: '润色', color: C.gray },
  };

  // ── 版面：A4 竖版 ──
  const P = { pageW: 595.28, pageH: 841.89, marginL: 56, marginR: 56, marginT: 60, marginB: 64 };
  P.contentW = P.pageW - P.marginL - P.marginR;

  // ── 页面游标 ──
  const pages = [];
  let page = null;
  let cursor = 0;

  const newPage = () => {
    page = pdfDoc.addPage([P.pageW, P.pageH]);
    pages.push(page);
    cursor = P.pageH - P.marginT;
  };
  /** 确认剩余空间，不足则换页 */
  const ensure = (h) => { if (cursor - h < P.marginB) newPage(); };

  // ── 文本测量/折行（三字体：按字符脚本选字体度量，cjk 段默认宋体、作文正文可传楷体） ──
  /** 把字符串按 CJK/西文连续段分组 → [{text, font}]；cjk 指定 CJK 段所用字体 */
  function splitRuns(text, cjk = F_SONG) {
    const runs = [];
    let cur = '', curCJK = null;
    for (const ch of String(text)) {
      const isCJK = hasCJK(ch);
      if (curCJK === null || isCJK === curCJK) { cur += ch; curCJK = isCJK; }
      else { runs.push({ text: cur, font: curCJK ? cjk : F_SERIF }); cur = ch; curCJK = isCJK; }
    }
    if (cur) runs.push({ text: cur, font: curCJK ? cjk : F_SERIF });
    return runs;
  }
  /** 混排宽度：逐段用所属字体度量后求和 */
  const width = (text, size, cjk = F_SONG) => splitRuns(text, cjk).reduce((s, r) => s + r.font.widthOfTextAtSize(r.text, size), 0);

  /** 把文本切成最小断行单元：拉丁词（含 ' . - [ ] 等粘连符，[n] 引注不拆分）整词断，其余逐字符 */
  function tokenize(text) {
    const out = [];
    let word = '';
    for (const ch of String(text)) {
      if (/[A-Za-z0-9'’.+\-_/[\]$]/.test(ch)) word += ch;
      else { if (word) { out.push(word); word = ''; } out.push(ch); }
    }
    if (word) out.push(word);
    return out;
  }

  /** 行首禁排标点（避头尾）：断行落在这些字符前时，改挂在上一行行尾 */
  const BANNED_HEAD = /^[，。、；：？！”’）》〉】〕」』…～·‰！？,.;:!?)\]}]$/;
  /** 行尾禁排标点：开括号/开引号不悬在行尾，断行时移到下一行行首 */
  const BANNED_END = /^[（“‘《〈【〔「『]$/;

  /**
   * 富文本贪心折行。segs: [{text, color}]，返回行数组，每行是 [{text, color, w}]。
   * 行首空格丢弃；行首标点禁则（标点挂行尾，允许轻微溢出）；超宽单词独立成行。
   */
  function wrapRuns(segs, size, maxW, cjk = F_SONG) {
    const lines = [];
    let line = [];
    let w = 0;
    for (const seg of segs) {
      for (const tok of tokenize(seg.text)) {
        if (tok === ' ' && line.length === 0) continue;
        const tw = width(tok, size, cjk);
        // 连续禁排字符：新空行以禁排字符开头时并入上一行行尾（否则会产出单标点孤行）
        if (line.length === 0 && lines.length && tok.length === 1 && BANNED_HEAD.test(tok)) {
          lines[lines.length - 1].push({ text: tok, color: seg.color, w: tw, font: charFont(tok, cjk), bold: seg.bold });
          continue;
        }
        if (w + tw > maxW && line.length) {
          if (tok.length === 1 && BANNED_HEAD.test(tok)) {
            line.push({ text: tok, color: seg.color, w: tw, font: charFont(tok, cjk), bold: seg.bold });
            lines.push(line);
            line = []; w = 0;
            continue;
          }
          lines.push(line);
          line = []; w = 0;
          // 行尾禁则：上一行末尾若是开括号/开引号，移到新行行首
          const prev = lines[lines.length - 1];
          if (prev.length && prev[prev.length - 1].text.length === 1 && BANNED_END.test(prev[prev.length - 1].text)) {
            const moved = prev.pop();
            line.push(moved);
            w += moved.w;
          }
          if (tok === ' ') continue;
        }
        line.push({ text: tok, color: seg.color, w: tw, font: charFont(tok, cjk), bold: seg.bold });
        w += tw;
      }
    }
    if (line.length) lines.push(line);
    return lines.length ? lines : [[]];
  }

  /** 画一行富文本（runs 由 wrapRuns 产出，含各自字体）；bold 段伪粗双画 */
  function drawRunLine(runs, x, y, size) {
    let cx = x;
    for (const r of runs) {
      if (r.text) {
        page.drawText(r.text, { x: cx, y, size, font: r.font, color: r.color });
        if (r.bold) page.drawText(r.text, { x: cx + 0.3, y, size, font: r.font, color: r.color });
      }
      cx += r.w;
    }
  }

  /** 整串绘制（混排自动按脚本选字体）；on 可指定目标页（页眉页脚补画用），cjk 选 CJK 字体 */
  function drawString(text, x, y, size, color, on = null, cjk = F_SONG) {
    const target = on || page;
    let cx = x;
    for (const r of splitRuns(text, cjk)) {
      target.drawText(r.text, { x: cx, y, size, font: r.font, color });
      cx += width(r.text, size, cjk);
    }
  }

  /** 伪粗：同文本横向微移重画一次（仅用于短标题/表头/大数字，正文不用）；cjk 选 CJK 字体 */
  function drawBoldText(text, x, y, size, color, off, cjk = F_SONG) {
    const o = off ?? (size >= 12 ? 0.4 : 0.3);
    let cx = x;
    for (const r of splitRuns(text, cjk)) {
      page.drawText(r.text, { x: cx, y, size, font: r.font, color });
      page.drawText(r.text, { x: cx + o, y, size, font: r.font, color });
      cx += width(r.text, size, cjk);
    }
  }

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  // 防豆腐块：字体（GF chinese-simplified 切片）缺字形的符号 → 等义替换。
  // 依据/评语由 AI 产出，可能含箭头、圈号等；这些码位不在切片内，直接绘制会成空框。
  const GLYPH_SUBS = {
    '→': '->', '←': '<-', '⇒': '=>', '↔': '<->',
    '①': '(1)', '②': '(2)', '③': '(3)', '④': '(4)', '⑤': '(5)', '⑥': '(6)',
    '⑦': '(7)', '⑧': '(8)', '⑨': '(9)', '⑩': '(10)', '⑪': '(11)', '⑫': '(12)',
    '⑬': '(13)', '⑭': '(14)', '⑮': '(15)', '⑯': '(16)', '⑰': '(17)', '⑱': '(18)',
    '⑲': '(19)', '⑳': '(20)',
    'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI',
    '★': '*', '☆': '*', '■': '·', '□': '·', '▲': '·', '△': '·', '●': '·', '○': '·', '◆': '·', '◇': '·',
  };
  /** 文本清洗：折叠空白 + 缺字形符号替换（所有正文/表格文本入口都过这里） */
  const cleanText = (s) => clean(s).replace(/[→←⇒↔①-⑳Ⅰ-Ⅵ★☆■□▲△●○◆◇]/g, (ch) => GLYPH_SUBS[ch] ?? ch);

  /**
   * 排一段/多段文本。opts: size, color, paraGap(段间距), lh(行高),
   * markedColor(**标记**段颜色), gap(块后额外间距)
   */
  function drawParas(text, opts = {}) {
    const { size = 10.5, color = C.ink, paraGap = 7, lh = size * 1.55, markedColor = null, gap = 0, kai = false } = opts;
    const cjk = kai ? F_KAI : F_SONG;
    const paras = String(text ?? '').split(/\n+/).map(cleanText).filter(Boolean);
    for (const para of paras) {
      const segs = markedColor ? splitMarked(para, color, markedColor) : [{ text: para, color }];
      const lines = wrapRuns(segs, size, P.contentW, cjk);
      for (const ln of lines) {
        ensure(lh);
        drawRunLine(ln, P.marginL, cursor - size, size);
        cursor -= lh;
      }
      cursor -= paraGap;
    }
    cursor -= gap;
  }

  /** 悬挂缩进列表：首行顶格（前缀在 segs 内），续行缩进 indent */
  function drawHanging(segs, { size = 10, indent = 16, itemGap = 5 } = {}) {
    const lines = wrapRuns(segs, size, P.contentW - indent);
    lines.forEach((ln, i) => {
      ensure(size * 1.55);
      drawRunLine(ln, P.marginL + (i > 0 ? indent : 0), cursor - size, size);
      cursor -= size * 1.55;
    });
    cursor -= itemGap;
  }

  /** 灰色小注（表格脚注/兜底说明） */
  function drawFootnote(text) {
    const size = 8.5, lh = size * 1.45;
    const lines = wrapRuns([{ text: String(text), color: C.gray }], size, P.contentW);
    for (const ln of lines) {
      ensure(lh);
      drawRunLine(ln, P.marginL, cursor - size, size);
      cursor -= lh;
    }
    cursor -= 4;
  }

  /** 章节标题：纯黑序号+标题（伪粗）+ 细通栏线；suffixSegs 彩色/灰小字靠右（数据强调，非标题） */
  function drawSectionHead(numCn, title, suffixSegs = null) {
    ensure(50);
    cursor -= 12;
    const size = 13;
    const numStr = `${numCn}、`;
    const numW = width(numStr, size);
    drawBoldText(numStr, P.marginL, cursor - size, size, C.ink);
    drawBoldText(title, P.marginL + numW, cursor - size, size, C.ink);
    if (suffixSegs && suffixSegs.length) {
      const sufSize = 9.5;
      const totalW = suffixSegs.reduce((s, g) => s + width(g.text, sufSize), 0);
      const fitsInline = numW + width(title, size) + totalW + 12 <= P.contentW;
      let sx = P.pageW - P.marginR - totalW;
      if (!fitsInline) cursor -= size * 1.35; // 放不下则挪到分隔线下方靠右
      for (const g of suffixSegs) {
        drawString(g.text, sx, cursor - (fitsInline ? size : sufSize), sufSize, g.color);
        sx += width(g.text, sufSize);
      }
    }
    cursor -= size * 1.4;
    page.drawLine({
      start: { x: P.marginL, y: cursor }, end: { x: P.pageW - P.marginR, y: cursor },
      thickness: 0.8, color: C.line,
    });
    cursor -= 12;
  }

  /** 小节标题：黑色伪粗 11pt，note 为紧跟其后的灰色小注；keepWith 为后续内容需同页预留的高度（防标题孤悬页底） */
  function drawSubHead(text, note = null, keepWith = 0) {
    ensure(36 + keepWith);
    cursor -= 8;
    const size = 11;
    drawBoldText(text, P.marginL, cursor - size, size, C.ink, 0.3);
    if (note) {
      const nw = width(text, size) + 8;
      drawString(note, P.marginL + nw, cursor - size + 0.5, 9, C.gray);
    }
    cursor -= size * 1.5;
  }

  /** 强调框：左侧彩色竖条 + 彩色标签 + 黑色正文（用于亮点/最该改） */
  function drawCallout(label, text, color) {
    const size = 10, lh = size * 1.5, barW = 2.5, padX = 9;
    const segs = [{ text: `${label}　`, color }, ...splitMarked(cleanText(text), C.ink, C.ink, true)];
    const lines = wrapRuns(segs, size, P.contentW - barW - padX * 2);
    const h = lines.length * lh + 10;
    ensure(h + 6);
    const top = cursor;
    page.drawRectangle({ x: P.marginL, y: top - h, width: barW, height: h, color });
    let ly = top - 5 - size;
    for (const ln of lines) { drawRunLine(ln, P.marginL + barW + padX, ly, size); ly -= lh; }
    cursor = top - h - 10;
  }

  // ── 表格 ──
  // 单元格：纯值（字符串/数字）或 { segs: [{text,color}], align } 或 { paras: [segs...], align }
  const t = (text, color = C.ink, align) => ({ segs: [{ text: String(text ?? ''), color }], align });
  const tParas = (paras, align) => ({ paras, align });

  /**
   * 测量表格：折行、列宽、keepBlock（表头+至少一行数据的最小高度，供「小节标题+表格」
   * keep-with-next 预留），返回 { keepBlock, draw() }。draw() 从当前游标开始绘制，
   * 内部带完整跨页逻辑（页断自动重画表头；整行能放进一页时不拆行，超高行才按行续排）。
   * opts: colW(列宽，等比缩放到内容宽), header(表头文本[]), rows(单元格[][])，
   *       size, grid: 'rows'(仅横线，默认) | 'full'(含列分隔竖线)
   */
  function measureTable({ colW, header, rows, size = 9.5, grid = 'rows' }) {
    const sum = colW.reduce((a, b) => a + b, 0);
    const widths = colW.map(w => (w / sum) * P.contentW);
    const colX = [P.marginL];
    widths.forEach((w, i) => colX.push(colX[i] + w));
    const padX = 5, padY = 4.5;
    const lh = size * 1.42;
    const headerH = header ? size * 1.3 + padY * 2 : 0;

    const paintHeader = () => {
      if (!header) return;
      const h = size * 1.3 + padY * 2;
      page.drawRectangle({ x: P.marginL, y: cursor - h, width: P.contentW, height: h, color: C.headFill });
      header.forEach((txt, i) => {
        const s = String(txt);
        const w = width(s, size);
        drawBoldText(s, colX[i] + (widths[i] - w) / 2, cursor - padY - size * 0.95, size, C.ink, 0.25);
      });
      page.drawLine({
        start: { x: P.marginL, y: cursor - h }, end: { x: P.pageW - P.marginR, y: cursor - h },
        thickness: 0.8, color: C.line,
      });
      cursor -= h;
    };

    /** 画一个行带（from..from+take-1 行），并画底部横线/列竖线；bandTop 须等于当前 cursor */
    const paintBand = (cells, from, take, bandTop) => {
      const bandH = take * lh + padY * 2;
      const bandBottom = bandTop - bandH;
      cells.forEach((cell, ci) => {
        for (let k = 0; k < take; k++) {
          const ln = cell.lines[from + k];
          if (!ln || !ln.length) continue;
          let cx = colX[ci] + padX;
          if (cell.align === 'center') {
            const lw = ln.reduce((s, r) => s + r.w, 0);
            cx = colX[ci] + (widths[ci] - lw) / 2;
          }
          drawRunLine(ln, cx, bandTop - padY - size - k * lh, size);
        }
      });
      page.drawLine({
        start: { x: P.marginL, y: bandBottom }, end: { x: P.pageW - P.marginR, y: bandBottom },
        thickness: 0.5, color: C.lineSoft,
      });
      if (grid === 'full') {
        for (let i = 1; i < widths.length; i++) {
          page.drawLine({
            start: { x: colX[i], y: bandTop }, end: { x: colX[i], y: bandBottom },
            thickness: 0.5, color: C.lineSoft,
          });
        }
      }
      cursor = bandBottom;
    };

    /** 画一行（cells 已折行）；整行能放进一页时不拆行，超高行才按行续排（页断重画表头） */
    const paintRow = (cells) => {
      const maxLines = Math.max(1, ...cells.map(c => c.lines.length));
      const rowH = maxLines * lh + padY * 2;
      if (rowH <= P.pageH - P.marginT - P.marginB) {
        if (cursor - rowH < P.marginB) { newPage(); paintHeader(); }
        paintBand(cells, 0, maxLines, cursor);
        return;
      }
      let li = 0;
      let bandTop = cursor;
      while (li < maxLines) {
        if (cursor - (lh + padY * 2) < P.marginB) { newPage(); paintHeader(); bandTop = cursor; }
        const avail = Math.max(1, Math.floor((cursor - P.marginB - padY * 2) / lh));
        const take = Math.min(avail, maxLines - li);
        paintBand(cells, li, take, bandTop);
        li += take;
        if (li < maxLines) { newPage(); paintHeader(); bandTop = cursor; }
      }
    };

    const wrappedRows = rows.map(row => row.map((raw, ci) => {
      const c = raw && (raw.segs || raw.paras) ? raw : t(raw);
      const paras = c.paras || [c.segs];
      const lines = [];
      for (const segs of paras) lines.push(...wrapRuns(segs, size, Math.max(widths[ci] - padX * 2, 20)));
      return { lines, align: c.align || 'left' };
    }));
    const firstRowH = wrappedRows.length
      ? Math.max(1, ...wrappedRows[0].map(c => c.lines.length)) * lh + padY * 2
      : 0;
    // keep-with-next 单元：表头 + 至少一行数据（上限为一整页可用高度）
    const keepBlock = headerH + Math.min(firstRowH, P.pageH - P.marginT - P.marginB);

    function draw() {
      if (header) {
        if (cursor - keepBlock < P.marginB) newPage();
        paintHeader();
      }
      for (const cells of wrappedRows) paintRow(cells);
    }
    return { keepBlock, draw };
  }

  /** 画表格（无前置小节标题的场景）；「小节标题 + 表格」组合请用 measureTable + drawSubHead(keepWith) */
  function drawTable(opts) {
    measureTable(opts).draw();
  }

  // ============================================================
  // 报告正文
  // ============================================================

  newPage();

  // ── 报告头：标题 + 元信息 ──
  const tSize = 17;
  const titleLines = wrapRuns([{ text: String(data.title || '批改报告'), color: C.ink }], tSize, P.contentW);
  for (const ln of titleLines) {
    const w = ln.reduce((s, r) => s + r.w, 0);
    drawBoldText(ln.map(r => r.text).join(''), (P.pageW - w) / 2, cursor - tSize, tSize, C.ink);
    cursor -= tSize * 1.5;
  }
  cursor -= 2;

  const wl = data.word_limits || {};
  const wMin = wl.softMinWords ?? wl.minWords;
  const wMax = wl.softMaxWords ?? wl.maxWords;
  const range = wMin && wMax ? `词数要求 ${wMin}-${wMax} 词` : null;
  const dateStr = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date());
  const meta = [data.genre_label, range, `${dateStr} 导出`].filter(Boolean).join(' · ');
  const metaSize = 9.5;
  drawString(meta, (P.pageW - width(meta, metaSize)) / 2, cursor - metaSize, metaSize, C.gray);
  cursor -= metaSize * 1.8;

  // ── 一、题目（文字与配图同框；配图约为内容宽一半，居中）──
  drawSectionHead(cnNum[0], '题目');
  const topicText = String(data.topic || '').trim();
  const topicSize = 10.5, topicLh = 16, topicPad = 10, topicParaGap = 4;

  // 题目配图：解码嵌入并按半宽口径算好尺寸；单张失败不阻塞整份报告。
  // 浏览器壳已把 webp 等转成 PNG 传入 topicImages；未传时（Node 直调）就地解析 data URL（仅 png/jpg 可嵌）。
  const embeddable = (topicImages && topicImages.length)
    ? topicImages
    : (Array.isArray(data.topic_images) ? data.topic_images.map(parseImageDataUrl) : []);
  const embeddedImgs = [];
  let imgFailed = 0;
  for (const img of embeddable) {
    if (!img || !img.bytes || !img.kind) { imgFailed++; continue; }
    try {
      const embedded = img.kind === 'png' ? await pdfDoc.embedPng(img.bytes) : await pdfDoc.embedJpg(img.bytes);
      const iw = embedded.width, ih = embedded.height;
      let w = Math.min(P.contentW, iw) * 0.5;   // 横竖各约为旧全宽版式的一半
      let h = w * (ih / iw);
      const maxH = 210;
      if (h > maxH) { h = maxH; w = h * (iw / ih); }
      const innerW = P.contentW - topicPad * 2;
      if (w > innerW) { w = innerW; h = w * (ih / iw); }
      embeddedImgs.push({ embedded, w, h });
    } catch { imgFailed++; }
  }

  if (topicText || embeddedImgs.length) {
    const paras = topicText ? topicText.split(/\n+/).map(cleanText).filter(Boolean) : [];
    const allLines = paras.map(p => wrapRuns([{ text: p, color: C.ink }], topicSize, P.contentW - topicPad * 2, F_KAI));
    const totalLines = allLines.reduce((s, l) => s + l.length, 0);
    const textBlockH = totalLines * topicLh + Math.max(paras.length - 1, 0) * topicParaGap;
    const imgGap = 8, imgBetween = 10;
    const imgBlockH = embeddedImgs.length
      ? imgGap + embeddedImgs.reduce((s, im) => s + im.h, 0) + (embeddedImgs.length - 1) * imgBetween
      : 0;
    const boxH = topicPad * 2 + textBlockH + imgBlockH;
    const usable = P.pageH - P.marginT - P.marginB;
    if (boxH <= usable) {
      // 同框：细边框盒内先排题目文字，再居中排配图
      ensure(boxH);
      const top = cursor;
      page.drawRectangle({
        x: P.marginL, y: top - boxH, width: P.contentW, height: boxH,
        borderColor: C.lineSoft, borderWidth: 0.8,
      });
      let ty = top - topicPad - topicSize;
      allLines.forEach((lines, pi) => {
        for (const ln of lines) { drawRunLine(ln, P.marginL + topicPad, ty, topicSize); ty -= topicLh; }
        if (pi < paras.length - 1) ty -= topicParaGap;
      });
      let iy = top - topicPad - textBlockH - imgGap;
      for (const im of embeddedImgs) {
        const ix = P.marginL + (P.contentW - im.w) / 2;
        page.drawImage(im.embedded, { x: ix, y: iy - im.h, width: im.w, height: im.h });
        page.drawRectangle({
          x: ix - 0.5, y: iy - im.h - 0.5, width: im.w + 1, height: im.h + 1,
          borderColor: C.lineSoft, borderWidth: 0.8,
        });
        iy -= im.h + imgBetween;
      }
      cursor = top - boxH - 14;
    } else {
      // 极端多图放不下同一个框：退化为文字盒 + 配图各自带框排在框外（仍缩半居中）
      if (topicText) drawParas(topicText, { size: topicSize, gap: 6, kai: true });
      for (const im of embeddedImgs) {
        ensure(im.h + 14);
        const ix = P.marginL + (P.contentW - im.w) / 2;
        const iy = cursor - im.h;
        page.drawImage(im.embedded, { x: ix, y: iy, width: im.w, height: im.h });
        page.drawRectangle({
          x: ix - 0.5, y: iy - 0.5, width: im.w + 1, height: im.h + 1,
          borderColor: C.lineSoft, borderWidth: 0.8,
        });
        cursor = iy - 14;
      }
    }
  }
  if (imgFailed) drawFootnote(`（${imgFailed} 张题目图片未能嵌入报告）`);

  // ── 多稿时：各稿得分总览表 ──
  const drafts = Array.isArray(data.drafts) ? data.drafts : [];
  if (drafts.length > 1) {
    const rows = drafts.map((d, i) => {
      const r = d.review;
      const name = `第${cnNum[i] || i + 1}稿`;
      if (!r) {
        return [
          t(name, C.ink, 'center'), t('—', C.gray, 'center'), t('—', C.gray, 'center'),
          t('—', C.gray, 'center'), t('—', C.gray, 'center'), t('—', C.gray, 'center'),
          t('未批改', C.gray, 'center'),
        ];
      }
      const g = gradeFor(r.score);
      const sub = r.subscores || {};
      const pen = typeof r.word_count_penalty === 'number' ? r.word_count_penalty : 0;
      return [
        t(name, C.ink, 'center'),
        t(sub.content ?? 0, C.ink, 'center'),
        t(sub.language ?? 0, C.ink, 'center'),
        t(sub.organization ?? 0, C.ink, 'center'),
        t(pen > 0 ? `-${pen}` : '0', pen > 0 ? C.red : C.gray, 'center'),
        t(r.score ?? 0, C.blue, 'center'),
        g ? t(`${g.grade}（${g.label}）`, GRADE_COLOR[g.grade], 'center') : t('—', C.gray, 'center'),
      ];
    });
    const tb = measureTable({
      colW: [52, 62, 62, 62, 66, 62, 84],
      header: ['稿次', '内容 /10', '语言 /10', '结构 /5', '词数扣分', '总分 /25', '等第'],
      rows, size: 9.5,
    });
    drawSubHead('各稿得分总览', null, tb.keepBlock);
    tb.draw();
    cursor -= 6;
  }

  if (!drafts.length) {
    drawFootnote('本作文暂无稿件内容。');
  }

  // ── 各稿章节 ──
  drafts.forEach((d, i) => {
    const r = d.review || null;
    const g = r ? gradeFor(r.score) : null;
    const chName = `第${cnNum[i] || i + 1}稿批改`;
    let suffix;
    if (r) {
      suffix = [
        { text: '总分 ', color: C.gray },
        { text: String(r.score ?? 0), color: C.blue },
        { text: ' · ', color: C.gray },
        ...(g ? [{ text: `${g.grade}（${g.label}）`, color: GRADE_COLOR[g.grade] }] : []),
      ];
    } else {
      suffix = [{ text: '未批改', color: C.gray }];
    }
    drawSectionHead(cnNum[i + 1] || String(i + 2), chName, suffix);

    // 原文（问题清单引用原句，需要就近可对照）
    const metaBits = [`${d.word_count ?? 0} 词`];
    if (d.handwriting_score != null) metaBits.push(`书写质量 ${Math.round(d.handwriting_score * 100)}%`);
    drawSubHead('原文', metaBits.join(' · '), 22);
    drawParas(d.text, { size: 10.5, paraGap: 8, lh: 16.5, kai: true });

    if (!r) {
      drawFootnote('本稿尚未批改，本节仅收录原文。');
      return;
    }

    // 得分与依据表
    const basis = r.basis || {};
    const dimRows = [
      ['内容', 10, (r.subscores || {}).content, basis.content],
      ['语言', 10, (r.subscores || {}).language, basis.language],
      ['结构', 5, (r.subscores || {}).organization, basis.organization],
    ].map(([dim, full, val, txt]) => [
      t(dim, C.ink, 'center'),
      t(full, C.ink, 'center'),
      t(val ?? 0, C.ink, 'center'),
      { segs: txt ? splitMarked(cleanText(txt), C.ink, C.ink, true) : [{ text: '—', color: C.gray }] },
    ]);
    const pen = typeof r.word_count_penalty === 'number' ? r.word_count_penalty : 0;
    const totalBasis = [
      ...(g ? [{ text: `${g.grade}（${g.label}）`, color: GRADE_COLOR[g.grade] }] : []),
      ...(pen > 0 ? [{ text: ` · 词数扣 ${pen} 分`, color: C.red }] : []),
      ...(!g && pen <= 0 ? [{ text: '—', color: C.gray }] : []),
    ];
    dimRows.push([
      t('总分', C.ink, 'center'),
      t(25, C.ink, 'center'),
      t(r.score ?? 0, C.blue, 'center'),
      { segs: totalBasis },
    ]);
    const tb = measureTable({
      colW: [56, 48, 48, 331],
      header: ['维度', '满分', '得分', '给分依据'],
      rows: dimRows, size: 9.5,
    });
    drawSubHead('得分与依据', null, tb.keepBlock);
    tb.draw();
    cursor -= 4;

    // 突出优点 / 主要问题（评语惯用书面语，替代口语化的「亮点/最该改」）
    if (r.highlight) drawCallout('突出优点', r.highlight, C.green);
    if (r.priority) drawCallout('主要问题', r.priority, C.red);

    // 问题清单（三列对照表）
    if (r.issues && r.issues.length) {
      const rows = r.issues.map(iss => {
        const sev = SEV[iss.severity] || SEV.minor;
        const quoteTxt = cleanText(iss.quote) || '—';
        const quoteParas = [splitMarked(iss.quote ? `“${quoteTxt}”` : quoteTxt, C.ink, C.ink, true)];
        const probParas = [
          [{ text: sev.label, color: sev.color }, { text: ` · ${cleanText(iss.type) || '问题'}`, color: C.ink }],
        ];
        if (iss.explanation) probParas.push(splitMarked(cleanText(iss.explanation), C.ink, C.ink, true));
        if (iss.located === false) probParas.push([{ text: '（原文中未找到该句）', color: C.gray }]);
        const fixTxt = cleanText(iss.correction);
        const fixParas = [fixTxt ? splitMarked(fixTxt, C.ink, C.ink, true) : [{ text: '—', color: C.gray }]];
        return [tParas(quoteParas), tParas(probParas), tParas(fixParas)];
      });
      const tb = measureTable({
        colW: [150, 185, 148],
        header: ['原句', '问题点', '建议修改'],
        rows, size: 9, grid: 'full',
      });
      drawSubHead('问题清单', `共 ${r.issues.length} 处`, tb.keepBlock);
      tb.draw();
      cursor -= 4;
    }

    // 修改稿（**标记** → 蓝色）
    if (r.revised_essay) {
      drawSubHead('修改稿', '蓝色字为修改内容', 22);
      drawParas(r.revised_essay, { size: 10.5, paraGap: 8, lh: 16.5, markedColor: C.blue, kai: true });
    }

    // 提升建议
    if (r.suggestions && r.suggestions.length) {
      drawSubHead('提升建议', null, 22);
      r.suggestions.forEach((s, k) => {
        drawHanging(
          [{ text: `${k + 1}. `, color: C.ink }, ...splitMarked(cleanText(s), C.ink, C.ink, true)],
          { size: 10, indent: 16 },
        );
      });
    }

    // 较上一稿
    if (r.improvement) {
      const imp = r.improvement;
      const delta = typeof imp.score_delta === 'number' ? imp.score_delta : 0;
      drawSubHead('较上一稿', null, 26);
      ensure(26);
      const dSize = 13;
      const dText = `${delta >= 0 ? '+' : ''}${delta} 分`;
      drawBoldText(dText, P.marginL, cursor - dSize, dSize, delta < 0 ? C.red : C.green);
      drawString('与上一稿相比的总分变化', P.marginL + width(dText, dSize) + 8, cursor - 10.5, 9.5, C.gray);
      cursor -= dSize * 1.6;
      const groups = [
        ['已解决', imp.fixed, C.green],
        ['仍存在', imp.remaining, C.gray],
        ['新出现', imp.regression, C.red],
      ];
      for (const [label, arr, color] of groups) {
        if (!Array.isArray(arr) || !arr.length) continue;
        ensure(20);
        drawString(`${label}（${arr.length}）`, P.marginL, cursor - 9.5, 9.5, color);
        cursor -= 15;
        for (const item of arr) {
          drawHanging(
            [{ text: '· ', color: C.ink }, ...splitMarked(cleanText(item), C.ink, C.ink, true)],
            { size: 9.5, indent: 12, itemGap: 3 },
          );
        }
        cursor -= 3;
      }
    }
  });

  // ============================================================
  // 页脚（每页）与页眉（第 2 页起）：内容画完后统一补画（此时总页数已知）
  // ============================================================
  const total = pages.length;
  pages.forEach((pg, i) => {
    pg.drawLine({
      start: { x: P.marginL, y: 46 }, end: { x: P.pageW - P.marginR, y: 46 },
      thickness: 0.6, color: C.lineSoft,
    });
    drawString('英语作文批改助手 · 本报告由 AI 生成，仅供参考', P.marginL, 34, 8, C.gray, pg);
    const pn = `第 ${i + 1} 页 / 共 ${total} 页`;
    drawString(pn, P.pageW - P.marginR - width(pn, 8), 34, 8, C.gray, pg);
    if (i > 0) {
      let h = String(data.title || '').trim() || '批改报告';
      const maxW = P.contentW * 0.6;
      if (width(h, 8.5) > maxW) {
        while (width(h + '…', 8.5) > maxW && h.length > 1) h = h.slice(0, -1);
        h += '…';
      }
      drawString(h, P.pageW - P.marginR - width(h, 8.5), P.pageH - 36, 8.5, C.gray, pg);
      pg.drawLine({
        start: { x: P.marginL, y: P.pageH - 44 }, end: { x: P.pageW - P.marginR, y: P.pageH - 44 },
        thickness: 0.6, color: C.lineSoft,
      });
    }
  });

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
