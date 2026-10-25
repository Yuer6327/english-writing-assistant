// ============================================================
// theme.js — 明暗主题切换（所有页面通用，非 module 脚本）
// ============================================================
// 防止闪屏：<head> 内联脚本已提前设置 data-theme（CSP 用哈希放行）。
// 本文件只负责按钮交互与可访问性状态同步。

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  const media = matchMedia('(prefers-color-scheme: dark)');

  /** 当前是否暗色：显式属性 > 用户选择 > 系统偏好（不能只看 media，否则强制浅色时状态错乱） */
  const isDark = () => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    const stored = localStorage.getItem('theme');
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return media.matches;
  };

  const sync = () => {
    const dark = isDark();
    toggle.textContent = dark ? '☀️' : '🌙';
    // 图标只是视觉信号，读屏依赖 aria
    toggle.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
    toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
    toggle.title = dark ? '切换到浅色主题' : '切换到深色主题';
  };

  sync();

  toggle.addEventListener('click', () => {
    const dark = isDark();
    if (dark) {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    }
    sync();
  });

  // 用户从未手动选择时，跟随系统切换实时更新图标状态
  media.addEventListener('change', () => {
    if (!localStorage.getItem('theme') || localStorage.getItem('theme') === 'auto') sync();
  });
});
