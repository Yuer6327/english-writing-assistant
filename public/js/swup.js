// ============================================================
// swup.js — 轻量 SPA 切页引擎（自研，零外部依赖）
// 基于 Swup 4 的设计模式，但不用 Swup 库本身（中国大陆网络 / 体积 / 可控性考虑）
//
// 实现：
//   - 拦截同源 SPA 导航链接（<a data-spa> 或当前页在 SPA 页面集合内）
//   - fetch 目标页 → 交换 <main id="main"> 内容 → 执行目标页 init()
//   - 导航栏 #site-nav 持久化（不闪烁、theme 按钮状态保持），切页后按 URL 高亮
//   - 离开页面的 module 若导出了 cleanup()，切换前调用，清理轮询/全局副作用
//   - 支持浏览器前进/后退（popstate）
//   - 非 SPA 页面（index/login/register，无 <main>）→ 直接完整跳转，保持现状
//
// 页面约定（被 swup 管理的页面）：
//   - <body> 内直接放 <nav id="site-nav">…</nav> 和 <main id="main" data-page-module="/js/xx.js">
//   - 其余内容都在 <main> 内
//   - module 默认导出 { init, cleanup }，init 中通过 navigate() 做站内跳转
//   - api.js 的 401/硬跳转不受 swup 影响（完整页面刷新，可接受）
// ============================================================

// ── 被 swup 管理的页面集合（其余页面走完整刷新）──
// '/' 与 '/index.html' 同为作文列表页（Workers Assets 根路径即 index.html）
const SPA_PAGES = ['/', '/index.html', '/essay.html', '/settings.html', '/admin.html'];

// ── module 加载 Promise 缓存：退场动画期间即可并行预载 ──
const moduleCache = new Map();
function preloadModule(src) {
  if (!src) return Promise.resolve(null);
  if (!moduleCache.has(src)) {
    moduleCache.set(src, import(src).catch(err => {
      moduleCache.delete(src);
      throw err;
    }));
  }
  return moduleCache.get(src);
}

// ── 当前页面状态 ──
let currentPath = location.pathname + location.search;
let currentCleanup = null;   // 当前页 module 导出的 cleanup()
let navigating = false;
let pendingPath = null;      // 切页期间只保留最后一次导航意图
let ready = false;           // bootstrap 完成前，点击导航走完整刷新避免竞态

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function waitForLeave(el, duration = 180) {
  if (reducedMotion.matches) return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('transitionend', onEnd);
      resolve();
    };
    const onEnd = e => { if (e.target === el && e.propertyName === 'opacity') done(); };
    el.addEventListener('transitionend', onEnd);
    timer = setTimeout(done, duration + 60); // CSS 未运行/后台标签页时兜底
  });
}

// ── 载入 <main> 对应的页面 module，执行 init() ──
async function loadCurrentPage(preloaded = null) {
  const main = document.getElementById('main');
  const src = main && main.dataset.pageModule;
  if (!src) return; // 非 SPA 页，无需处理
  const mod = await (preloaded || preloadModule(src));

  // 模块 fetch 期间用户可能已切走：旧页 init 跑在新页 DOM 上会造成跳页/错渲染
  const pathNow = location.pathname + location.search;
  if (pathNow !== currentPath) return;

  // cleanup 用具名导出：即使 init 仍在异步进行中（用户已切走），也能立即调用使其中止
  currentCleanup = mod.cleanup || null;
  if (mod.init) await mod.init();
}

// ── 切页：立即反馈；HTML/模块预载与视觉过渡并行，数据成功后才交换 DOM ──
async function performTransition(toPath) {
  if (navigating) { pendingPath = toPath; return; }
  navigating = true;
  const main = document.getElementById('main');
  main.setAttribute('aria-busy', 'true');
  main.classList.add('page-pending');
  try {
    // 网络期间旧页保持可见，仅降低不透明度，避免慢请求造成空白页
    const fetchPath = toPath === '/' ? '/index.html' : toPath;
    const resp = await fetch(fetchPath, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const newMain = doc.getElementById('main');
    if (!newMain) throw new Error('目标页没有 <main>');
    const modulePromise = preloadModule(newMain.dataset.pageModule);

    if (currentCleanup) {
      try { await currentCleanup(); } catch (e) { console.error('[swup] cleanup error:', e); }
    }
    currentCleanup = null;

    main.classList.remove('page-pending');
    main.classList.add('page-leaving');
    await waitForLeave(main);

    main.innerHTML = newMain.innerHTML;
    // innerHTML 不复制 <main> 自身属性
    main.dataset.pageModule = newMain.dataset.pageModule;
    main.classList.remove('page-leaving');
    main.classList.add('page-entering');
    void main.offsetWidth;
    requestAnimationFrame(() => main.classList.remove('page-entering'));

    if (toPath !== location.pathname + location.search) {
      history.pushState({ path: toPath }, '', toPath);
    }
    currentPath = toPath;
    document.title = doc.title;
    window.scrollTo(0, 0);
    highlightNav(toPath);
    // 键盘/读屏：切页后把焦点交回主区域，避免焦点残留在旧页已移除的元素上
    try { main.focus({ preventScroll: true }); } catch { /* 老浏览器忽略 */ }

    // 入场、模块预载、页面数据初始化并行；不用数据等待拖住导航锁
    loadCurrentPage(modulePromise).catch(err => console.error('[swup] page init failed:', err));
  } catch (err) {
    console.error('[swup] transition failed, full reload:', err);
    location.href = toPath;
  } finally {
    main.classList.remove('page-pending', 'page-leaving');
    main.removeAttribute('aria-busy');
    navigating = false;
    if (pendingPath) {
      const next = pendingPath;
      pendingPath = null;
      if (next !== currentPath) performTransition(next);
    }
  }
}

// ── 高亮导航栏当前项 ──
function highlightNav(path) {
  // Workers Assets 会把 /xxx.html 重定向为 /xxx，因此比较时两种形式都归一
  const norm = (p) => { const n = p.replace(/\.html$/, '') || '/'; return n === '/index' ? '/' : n; };
  const cur = norm(path.split('?')[0]);
  document.querySelectorAll('#site-nav a[data-nav]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const target = norm(href);
    // 作文工作台 (/essay) 与列表页 (/) 同属"我的作文"导航
    const active = target === '/'
      ? (cur === '/' || cur === '/essay')
      : cur === target;
    a.classList.toggle('active', active);
    // 读屏软件靠 aria-current 识别"当前所在页"，单靠颜色不够
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

// ── 退出登录：跳统一认证平台登出（全站会话失效），回到本站首页 ──
function setupLogout() {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    location.href = 'https://auth.yuer6327.top/logout?next=' + encodeURIComponent(location.origin + '/');
  });
}

// ── 拦截站内导航链接 ──
function shouldIntercept(href) {
  // 页内锚点 / 外链 / 协议链接不拦截
  if (!href || href.startsWith('#') || href.startsWith('http:') || href.startsWith('https:') || href.startsWith('//')) return false;
  let full;
  try {
    full = new URL(href, location.href); // 相对 href 以当前完整 URL（含 query）为基准解析
  } catch {
    return false;
  }
  const path = full.pathname;
  const withSearch = path + full.search;
  if (withSearch === currentPath) return false;          // 同页（含 query）不切换
  if (path === currentPath) return false;                // 仅 query 不同也跳过
  return SPA_PAGES.includes(path);
}

document.addEventListener('click', async (e) => {
  if (!ready || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!shouldIntercept(href)) return;
  e.preventDefault(); // 即使正在切页，也不能退化成不可控的整页跳转
  await performTransition(href);
});

// 供各页面 module 调用的导航（页面内生成的跳转，如"创建成功 → 阅读页"）
function navigate(path) {
  if (!ready) { location.href = path; return; }
  if (shouldIntercept(path)) performTransition(path);
  else location.href = path;
}
window.swupNavigate = navigate;

// ── 浏览器前进/后退 ──
window.addEventListener('popstate', async () => {
  if (!ready) { location.href = location.pathname + location.search; return; }
  const toPath = location.pathname + location.search;
  if (toPath === currentPath && !navigating) return;
  // 目标页不在 SPA 集合 → 交由浏览器完整加载
  if (!SPA_PAGES.includes(location.pathname)) { location.href = toPath; return; }
  await performTransition(toPath); // 切页期间保留最新前进/后退意图，避免 URL 与内容脱节
});

// ── 初始化 ──
import { getSession, loginHref } from './api.js?v=20261027c';

// ── 导航栏会话态（navbar 持久化，查重防重复追加；本模块全站常驻）──
//   登录：余额 pill + 管理链接（admin）
//   游客：隐藏「设置/退出」，露出「登录」
const PILL_ID = 'nav-balance-pill';
const ADMIN_LINK_ID = 'nav-admin-link';
const LOGIN_LINK_ID = 'nav-login-link';

async function injectNavbarSession() {
  const right = document.querySelector('.navbar-right');
  if (!right) return;
  const session = await getSession();
  if (!session) return;

  const settingsLink = right.querySelector('a[href="/settings.html"]');
  const logoutLink = document.getElementById('logout-btn');

  if (!session.logged_in) {
    if (settingsLink) settingsLink.style.display = 'none';
    if (logoutLink) logoutLink.style.display = 'none';
    if (!document.getElementById(LOGIN_LINK_ID)) {
      const a = document.createElement('a');
      a.id = LOGIN_LINK_ID;
      a.href = loginHref();
      a.textContent = '登录';
      a.style.fontWeight = '600';
      a.setAttribute('rel', 'nofollow');
      right.appendChild(a);
    }
    return;
  }

  if (settingsLink) settingsLink.style.display = '';
  if (logoutLink) logoutLink.style.display = '';

  if (typeof session.wallet?.balance === 'number' && !document.getElementById(PILL_ID)) {
    const pill = document.createElement('a');
    pill.id = PILL_ID;
    pill.className = 'badge badge-completed';
    pill.href = '/settings.html#billing';
    pill.style.cssText = 'font-variant-numeric:tabular-nums;text-decoration:none';
    pill.textContent = `${(session.wallet.balance / 10000).toFixed(2)} 积分`;
    right.insertBefore(pill, settingsLink || right.lastElementChild);
  }
  if (session.role === 'admin' && !document.getElementById(ADMIN_LINK_ID)) {
    const a = document.createElement('a');
    a.id = ADMIN_LINK_ID;
    a.href = '/admin.html';
    a.setAttribute('data-nav', '');
    a.textContent = '管理';
    right.insertBefore(a, settingsLink);
  }
}

(async function bootstrap() {
  // 会话与页面数据并行：导航栏的登录态/余额不必等作文列表加载完
  // （getSession 有缓存，和页面 init 复用同一个请求）
  injectNavbarSession();
  try {
    await loadCurrentPage();
  } catch (err) {
    console.error('[swup] init failed:', err);
  }
  highlightNav(currentPath);
  setupLogout();
  ready = true;
})();
