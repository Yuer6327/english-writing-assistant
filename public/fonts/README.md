# 字体说明

## NotoSansSC-Regular.ttf（PDF 导出用）

- **来源**：Google Fonts「Noto Sans SC」v41，取自 npm 包 `@fontsource/noto-sans-sc@5.1.0` 的
  `files/noto-sans-sc-chinese-simplified-400-normal.woff2`（GF chinese-simplified 切片，
  已含完整 ASCII / 数字 / 常用标点），用 wawoff2 解压为静态 TrueType，未做其他修改。
- **覆盖**：约 8,200 字形（常用简体汉字 + ASCII + 中英文标点）。生僻字可能缺字形。
- **为什么必须是静态 TTF**（2026-11-01 换入，替代原 NotoSansSC-Regular.otf）：
  pdf-lib@1.17.1 的 `embedFont(..., { subset: true })` 对 CID-keyed CFF（.otf）与可变
  TrueType 的子集化存在缺陷——子集后字形映射损坏，部分字符渲染为空白/错字形/叠字
  （Node 侧 pdf.js 渲染实测复现）。对纯静态 TrueType 的子集化则完全正常（实测 4 场景
  全部字形正确，单份 PDF 仅 100-300KB）。
- **许可**：SIL Open Font License 1.1（允许文档内嵌）。

## Tinos-Regular.ttf（PDF 导出西文字体）

- **来源**：Google Fonts「Tinos」，取自 npm 包 `@fontsource/tinos@5.1.0` 的
  `files/tinos-latin-400-normal.woff2`，wawoff2 解压为静态 TrueType，未做其他修改。
- **定位**：Times New Roman 的度量兼容开源版（同宗设计，ChromeOS 默认衬线）。PDF 导出中
  拉丁字母/数字/西文标点用它，中文用 Noto Sans SC，混排由 `pdf-report.js` 按字符脚本自动切换。
  （PDF 规范要求字形内嵌、浏览器读不到系统字体文件，故无法直接引用用户系统的
  Times New Roman/微软雅黑/苹方；Tinos + Noto 为对应的开源等价物。）
- **覆盖**：224 字形（拉丁字母/数字/常用西文标点）。
- **许可**：SIL Open Font License 1.1（允许文档内嵌）。
