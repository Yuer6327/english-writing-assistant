// ============================================================
// auth.js — 统一认证跳转（登录/注册页桩 + 导航退出）
// 账户体系已上移 https://auth.yuer6327.top，本站不再有登录/注册表单。
// 导航栏余额 pill / 管理链接的注入在 swup.js（全站常驻模块）。
// ============================================================

import { gotoAuth } from './api.js?v=20261025';

// ── 登录/注册页桩：进入即跳认证平台（带 next 回跳）──
if (document.getElementById('login-page')) gotoAuth('login');
if (document.getElementById('register-page')) gotoAuth('register');

// ── 导航「退出」：全站会话登出后回到本站首页 ──
document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      location.href = 'https://auth.yuer6327.top/logout?next=' + encodeURIComponent(location.origin + '/');
    });
  }
});
