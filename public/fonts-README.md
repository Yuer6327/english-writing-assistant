# PDF 导出字体说明（2026-11-16 起「非内嵌系统字体」方案）

本目录已删除。PDF 导出不再携带任何字体文件——PDF 只引用字体名，由查看器用
系统字体渲染，零下载、体积从数百 KB 降到数十 KB。

## 字体分工（public/js/pdf-report.js）

| 内容 | 字体 | 机制 |
|---|---|---|
| 拉丁字母/数字/西文标点 | Times-Roman（standard-14） | Type1 + WinAnsiEncoding，pdf-lib 内建 AFM 度量；查看器映射到真 Times New Roman（Windows/macOS 自带） |
| 中文批改文字（宋体） | Windows: SimSun · macOS: Songti SC | Type0 / UniGB-UCS2-H 命名字体（2 字节大端 Unicode 即 CID） |
| 作文正文（题目/原文/修改稿，楷体） | Windows: KaiTi · macOS: Kaiti SC | 同上；CJK 字体名由 buildPdfBlob 按 UA 平台选择 |

## 为什么西文绝不能包进 Type0/GB1

曾试过把「Times New Roman」也用 Type0/UniGB-UCS2-H 外壳引用——查看器把它当
中文字体做 CJK 替换：数字变全角间距（"2 0 0 - 5"）、字母段重叠错位（实测
Windows pdfium 复现）。西文必须走 standard-14 的 Times-Roman + WinAnsi，
度量由 AFM 精确给出，布局零漂移。

## 中文命名字体的坑（Node 侧 pdf.js 回归已验证）

- `CIDSystemInfo.Registry/Ordering` 必须是 **PDF 字符串**（`PDFString.of`），
  写成 Name 会被 pdf.js 的 `stringToPDFString` 清空成 ""，触发
  `Unknown CMap name: --UCS2` 整页字形丢失。
- `encodeText` 用 **UTF-16BE 无 BOM** 的 hex 串（BOM 会映射到 .notdef）。
- 宋体/楷体的 CJK 字形宽恰为 1000/1000 em，`widthOfTextAtSize` 按
  `字数 × size` 计算 = 精确度量（不是估算）。

## 平台兼容

- **Windows**：SimSun/KaiTi 系统自带，Edge/Chrome（pdfium）实测直接解析。
- **macOS/iOS**：Songti SC（宋体-简）/Kaiti SC（楷体-简）系统自带，名字经
  UA 检测在导出时写入。
- **其他平台（Linux 等）**：查看器按 CJK 兜底规则挑可用中文字体，字形可能
  不完全一致但可读。

## 回归

`node scripts/pdf-render-regression.mjs`：Node 侧驱动 renderReport 生成 PDF
→ pdf.js（cMaps）逐页文本提取断言关键内容。Node 无系统字体，PNG 渲染的
字形为空属预期；字形级验证在真实查看器（Windows pdfium / macOS Preview）做。
