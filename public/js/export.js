// ============================================================
// export.js — 批改报告导出（仅 PDF）
// 纯前端生成：A4 打印版报告，见 ./pdf-report.js（pdf-lib，非内嵌系统字体）。
// 由 essay.js 调用 exportReportPdf(getData, btn)：点击按钮即直接生成并下载。
// ============================================================

import { toast } from './api.js?v=20261101g';
import { buildPdfBlob } from './pdf-report.js?v=20261116a';

/** 直接导出 PDF 报告并触发下载。btn 传入触发按钮时自动做生成中禁用态。 */
export async function exportReportPdf(getData, btn = null) {
  const busy = !!btn && !btn.disabled;
  if (busy) {
    btn.disabled = true;
    btn.dataset.originalLabel = btn.textContent;
    btn.textContent = '生成中...';
  }
  try {
    const data = await getData();
    const blob = await buildPdfBlob(data);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = sanitizeFilename(`${data.title}-批改报告.pdf`);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    console.error('[export] PDF 导出失败', err);
    toast(err?.message || '导出失败', 'error');
  } finally {
    if (busy) {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalLabel || '导出报告';
      delete btn.dataset.originalLabel;
    }
  }
}

function sanitizeFilename(name) {
  return String(name || 'report').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}
