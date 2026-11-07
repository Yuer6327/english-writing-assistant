// ============================================================
// admin.js — 管理入口（swup 管理：导出 init/cleanup）
// 2026-11-07 信任模型收敛（审查 §2 S2）：per-caller 令牌拆分后本仓只持
// WRITING_INTERNAL_TOKEN，billing /admin/*（送分/标签/兑换码/订单/BYOK 迁移）
// 对本仓关闭，原管理表单全部下线，入口迁统一认证后台：
//   https://auth.yuer6327.top/admin
// （链接待 auth 子代理产物核对；auth 后台正在补齐送分/标签两个缺口。）
// 本页仅保留「本账号用量」只读视图：走 /api/billing/usage（内部转发
// billing /internal/usage，WRITING 令牌可调、只读、仅本人数据）。
// ============================================================

import { api, requireAuth } from './api.js?v=20261101g';

let generation = 0;

export function cleanup() {
  generation++;
}

export async function init() {
  const gen = ++generation;
  const user = await requireAuth();
  if (!user || gen !== generation) return;

  const root = document.getElementById('admin-root');
  if (!root) return;

  if (user.role !== 'admin') {
    root.innerHTML = `
      <div class="card" style="text-align:center;padding:40px">
        <div style="font-size:36px;margin-bottom:12px">🔒</div>
        <div style="font-weight:600;margin-bottom:6px">无权限</div>
        <div style="font-size:13px;color:var(--text-soft)">本页面仅管理员可见。<a href="/">返回首页</a></div>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">计费管理已迁移至统一认证后台</h3>
      <div style="font-size:14px;line-height:1.8;color:var(--text-soft)">
        送 credit、用户标签、兑换码、订单、BYOK 等计费管理操作已收敛到统一认证平台，
        请前往 <a href="https://auth.yuer6327.top/admin" target="_blank" rel="noopener">auth.yuer6327.top/admin</a> 操作。
      </div>
      <a class="btn btn-primary" style="display:inline-block;margin-top:12px"
         href="https://auth.yuer6327.top/admin" target="_blank" rel="noopener">打开统一认证后台 ↗</a>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <h3 style="margin:0">本账号用量（只读）</h3>
        <button type="button" class="btn" id="btn-load-usage" style="padding:6px 14px;font-size:13px">加载最近 50 条</button>
      </div>
      <div id="usage-result"><div class="muted" style="font-size:13px">点击按钮加载本账号的计费用量与账单</div></div>
    </div>
  `;

  root.querySelector('#btn-load-usage').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '加载中...';
    const box = root.querySelector('#usage-result');
    try {
      const res = await api.billing.usage(50);
      if (gen !== generation) return;
      const rows = (res.usage || []).map((u) => `
        <tr>
          <td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--text-light);white-space:nowrap">${u.created_at ?? ''}</td>
          <td style="padding:4px 8px;border-bottom:1px solid var(--border)">${u.service ?? ''}</td>
          <td style="padding:4px 8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums">${((u.points_charged ?? 0) / 10000).toFixed(4)}</td>
          <td style="padding:4px 8px;border-bottom:1px solid var(--border)">${u.status ?? ''}</td>
        </tr>`).join('');
      box.innerHTML = rows
        ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="color:var(--text-light);text-align:left">
              <th style="padding:4px 8px">时间</th><th style="padding:4px 8px">服务</th>
              <th style="padding:4px 8px">credit</th><th style="padding:4px 8px">状态</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="muted" style="font-size:13px">暂无用量记录</div>';
    } catch (err) {
      if (gen === generation) box.innerHTML = `<div class="muted" style="font-size:13px;color:#d64545">${String(err.message ?? err)}</div>`;
    } finally {
      if (gen === generation) { btn.disabled = false; btn.textContent = '加载最近 50 条'; }
    }
  });
}
