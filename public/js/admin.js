// ============================================================
// admin.js — 管理后台（swup 管理：导出 init/cleanup）
// 仅统一认证 role==='admin' 可见；全部操作经 /api/billing/admin/*
// 代理到 yuer-billing（内网 Service Binding）。
// 兑换码为一次性明码展示，刷新即丢，请立即复制保存。
// ============================================================

import { api, toast, requireAuth, escapeHtml, formatBeijingTime } from './api.js?v=20261027c';

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
    <!-- 送积分 -->
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">送积分</h3>
      <form id="f-gift" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="flex:2;min-width:140px;margin-bottom:8px">
          <label class="form-label">用户名</label>
          <input type="text" class="form-input" id="gift-username" required placeholder="username">
        </div>
        <div class="form-group" style="flex:1;min-width:110px;margin-bottom:8px">
          <label class="form-label">金额（元，可负）</label>
          <input type="number" class="form-input" id="gift-yuan" step="0.01" required placeholder="1.00">
        </div>
        <div class="form-group" style="flex:2;min-width:140px;margin-bottom:8px">
          <label class="form-label">备注（可选）</label>
          <input type="text" class="form-input" id="gift-note" placeholder="活动奖励等">
        </div>
        <button type="submit" class="btn btn-primary" style="margin-bottom:8px">赠送</button>
      </form>
    </div>

    <!-- 用户查询 + 标签 -->
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">用户查询 / 标签管理</h3>
      <form id="f-user" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="flex:1;min-width:160px;margin-bottom:8px">
          <label class="form-label">用户名</label>
          <input type="text" class="form-input" id="user-username" required placeholder="username">
        </div>
        <button type="submit" class="btn btn-primary" style="margin-bottom:8px">查询</button>
      </form>
      <div id="user-result" style="margin-top:10px"></div>
    </div>

    <!-- 生成兑换码 -->
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">生成兑换码</h3>
      <form id="f-codes" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin-bottom:8px">
          <label class="form-label">面额（元）</label>
          <select class="form-input" id="code-yuan">
            <option value="0.1">0.1</option>
            <option value="0.5">0.5</option>
            <option value="1">1</option>
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:8px">
          <label class="form-label">数量</label>
          <input type="number" class="form-input" id="code-count" value="1" min="1" max="200" style="width:90px">
        </div>
        <button type="submit" class="btn btn-primary" style="margin-bottom:8px">生成</button>
      </form>
      <div class="chip-row" style="margin-top:8px"><span class="chip">仅本次可见</span><span class="chip">刷新即丢</span></div>
      <div id="code-result" style="margin-top:10px"></div>
    </div>

    <!-- 手动补单 -->
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">手动补单</h3>
      <form id="f-manual" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="flex:2;min-width:140px;margin-bottom:8px">
          <label class="form-label">用户名</label>
          <input type="text" class="form-input" id="manual-username" required placeholder="username">
        </div>
        <div class="form-group" style="flex:1;min-width:110px;margin-bottom:8px">
          <label class="form-label">金额（元）</label>
          <input type="number" class="form-input" id="manual-yuan" step="0.01" required placeholder="1.00">
        </div>
        <div class="form-group" style="flex:2;min-width:140px;margin-bottom:8px">
          <label class="form-label">备注</label>
          <input type="text" class="form-input" id="manual-note" placeholder="问题订单补退等">
        </div>
        <button type="submit" class="btn btn-primary" style="margin-bottom:8px">补单</button>
      </form>
    </div>

    <!-- 订单查询 + BYOK 迁移 -->
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">订单查询</h3>
        <button type="button" class="btn btn-danger" id="btn-migrate-byok" style="padding:6px 14px;font-size:13px">BYOK 一次性迁移</button>
      </div>
      <div id="orders-result"><div class="muted" style="font-size:13px">点击下方按钮加载最近订单</div></div>
      <button type="button" class="btn" id="btn-load-orders" style="margin-top:10px">加载最近 50 笔订单</button>
    </div>
  `;

  bindAdmin(root, gen);
}

function fmtPoints(cents) {
  return (cents / 10000).toFixed(2);
}

function bindAdmin(root, gen) {
  // ── 送积分 ──
  root.querySelector('#f-gift').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '处理中...';
    try {
      const res = await api.billing.admin.gift(
        root.querySelector('#gift-username').value.trim(),
        parseFloat(root.querySelector('#gift-yuan').value),
        root.querySelector('#gift-note').value.trim() || undefined,
      );
      if (gen !== generation) return;
      toast(`已赠送，当前余额 ${fmtPoints(res.balance)} 积分`, 'success');
      root.querySelector('#gift-yuan').value = '';
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation) { btn.disabled = false; btn.textContent = '赠送'; }
    }
  });

  // ── 用户查询 + 标签 ──
  const renderUser = (data, username) => {
    const ledgerRows = (data.recent_ledger || []).slice(0, 10).map(l => `
      <tr>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--text-light);white-space:nowrap">${formatBeijingTime(l.created_at)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border)">${escapeHtml(l.note || l.type)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;color:${l.delta >= 0 ? 'var(--primary)' : 'var(--text-soft)'}">${l.delta >= 0 ? '+' : ''}${fmtPoints(l.delta)}</td>
      </tr>`).join('');
    const tags = data.tags || [];
    return `
      <div style="font-size:14px;margin-bottom:8px">
        余额 <strong style="font-size:18px">${fmtPoints(data.balance)}</strong> 积分
        · 标签：${tags.length ? tags.map(t => `<span class="badge badge-pending">${escapeHtml(t)}</span>`).join(' ') : '<span class="muted">无</span>'}
      </div>
      <form id="f-tags" data-username="${escapeHtml(username)}" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <input type="text" class="form-input" id="tag-input" placeholder="标签组 key（如 vip）" style="width:180px">
        <button type="button" class="btn btn-sm" data-tag-add style="padding:5px 12px;font-size:13px">贴标签</button>
        <button type="button" class="btn btn-sm" data-tag-remove style="padding:5px 12px;font-size:13px">撕掉该标签</button>
        <span class="chip">新标签组自动创建</span>
      </form>
      ${ledgerRows ? `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-light);text-align:left">
          <th style="padding:4px 8px">时间</th><th style="padding:4px 8px">账目</th><th style="padding:4px 8px">变动（积分）</th>
        </tr></thead><tbody>${ledgerRows}</tbody></table>` : '<div class="muted" style="font-size:12px">暂无账目记录</div>'}`;
  };

  root.querySelector('#f-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = root.querySelector('#user-username').value.trim();
    const box = root.querySelector('#user-result');
    box.innerHTML = '<span class="spinner"></span> 查询中...';
    try {
      const data = await api.billing.admin.user(username);
      if (gen !== generation) return;
      box.innerHTML = renderUser(data, username);

      const tagInput = box.querySelector('#tag-input');
      const tagAdd = box.querySelector('[data-tag-add]');
      const tagRemove = box.querySelector('[data-tag-remove]');
      const refresh = async () => {
        const fresh = await api.billing.admin.user(username);
        if (gen === generation) box.innerHTML = renderUser(fresh, username);
      };
      const doTag = async (mode) => {
        const key = tagInput.value.trim();
        if (!key) { toast('请输入标签组 key', 'error'); return; }
        try {
          await api.billing.admin.tags(username, mode === 'add' ? [key] : [], mode === 'remove' ? [key] : []);
          if (gen !== generation) return;
          toast(mode === 'add' ? '已贴标签' : '已撕掉标签', 'success');
          await refresh();
        } catch (err) { if (gen === generation) toast(err.message, 'error'); }
      };
      tagAdd.addEventListener('click', () => doTag('add'));
      tagRemove.addEventListener('click', () => doTag('remove'));
    } catch (err) {
      if (gen === generation) box.innerHTML = `<div class="muted" style="font-size:13px;color:#d64545">${escapeHtml(err.message)}</div>`;
    }
  });

  // ── 生成兑换码 ──
  root.querySelector('#f-codes').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '生成中...';
    const box = root.querySelector('#code-result');
    try {
      const yuan = root.querySelector('#code-yuan').value;
      const count = parseInt(root.querySelector('#code-count').value, 10) || 1;
      const res = await api.billing.admin.codes(parseFloat(yuan), count);
      if (gen !== generation) return;
      const codesText = res.codes.join('\n');
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span class="muted" style="font-size:12px">面额 ${escapeHtml(yuan)} 元 · ${res.codes.length} 张 · 批次 ${escapeHtml(res.batch)}</span>
          <button type="button" class="btn btn-sm" id="btn-copy-codes" style="padding:4px 12px;font-size:12px">复制全部</button>
        </div>
        <textarea class="form-input" rows="${Math.min(10, res.codes.length)}" readonly
          style="font-family:var(--font-mono);font-size:12px">${escapeHtml(codesText)}</textarea>`;
      box.querySelector('#btn-copy-codes').addEventListener('click', () => {
        navigator.clipboard?.writeText(codesText).then(() => toast('已复制', 'success'));
      });
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation) { btn.disabled = false; btn.textContent = '生成'; }
    }
  });

  // ── 手动补单 ──
  root.querySelector('#f-manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '处理中...';
    try {
      const res = await api.billing.admin.manualOrder(
        root.querySelector('#manual-username').value.trim(),
        parseFloat(root.querySelector('#manual-yuan').value),
        root.querySelector('#manual-note').value.trim() || undefined,
      );
      if (gen !== generation) return;
      toast(`补单成功：${res.orderId}`, 'success');
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation) { btn.disabled = false; btn.textContent = '补单'; }
    }
  });

  // ── 订单查询 ──
  root.querySelector('#btn-load-orders').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '加载中...';
    const box = root.querySelector('#orders-result');
    try {
      const res = await api.billing.admin.orders(50);
      if (gen !== generation) return;
      box.innerHTML = res.orders.length ? `
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="color:var(--text-light);text-align:left">
            <th style="padding:4px 8px;border-bottom:1px solid var(--border)">订单号</th>
            <th style="padding:4px 8px;border-bottom:1px solid var(--border)">用户</th>
            <th style="padding:4px 8px;border-bottom:1px solid var(--border)">渠道</th>
            <th style="padding:4px 8px;border-bottom:1px solid var(--border)">积分</th>
            <th style="padding:4px 8px;border-bottom:1px solid var(--border)">状态</th>
            <th style="padding:4px 8px;border-bottom:1px solid var(--border)">时间</th>
          </tr></thead>
          <tbody>${res.orders.map(o => `
            <tr>
              <td style="padding:4px 8px;border-bottom:1px solid var(--border);font-family:var(--font-mono)">${escapeHtml(o.id)}</td>
              <td style="padding:4px 8px;border-bottom:1px solid var(--border);font-family:var(--font-mono)">${escapeHtml(String(o.user_id).slice(0, 8))}</td>
              <td style="padding:4px 8px;border-bottom:1px solid var(--border)">${escapeHtml(o.channel)}</td>
              <td style="padding:4px 8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums">${fmtPoints(o.points)}</td>
              <td style="padding:4px 8px;border-bottom:1px solid var(--border)"><span class="badge ${o.status === 'delivered' ? 'badge-completed' : 'badge-pending'}">${escapeHtml(o.status)}</span></td>
              <td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--text-light);white-space:nowrap">${formatBeijingTime(o.paid_at || o.created_at)}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="muted" style="font-size:13px">暂无订单</div>';
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation) { btn.disabled = false; btn.textContent = '加载最近 50 笔订单'; }
    }
  });

  // ── BYOK 一次性迁移（essay api_keys → billing 托管；复制不搬移，可回滚）──
  root.querySelector('#btn-migrate-byok').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!confirm('把 essay 本地 api_keys 表中的 BYOK 记录迁移到计费平台（用新密钥重新加密托管）？原表不动，可回滚。')) return;
    btn.disabled = true; btn.textContent = '迁移中...';
    try {
      const res = await api.billing.admin.migrateByok();
      if (gen !== generation) return;
      const ok = res.migrated + res.skipped + (res.failed || 0) === res.source_rows;
      toast(`源 ${res.source_rows} 行 · 迁移 ${res.migrated} · 跳过 ${res.skipped}${res.failed ? ` · 失败 ${res.failed}` : ''}${ok ? '' : '（数字不一致，请检查）'}`, ok ? 'success' : 'error');
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation) { btn.disabled = false; btn.textContent = 'BYOK 一次性迁移'; }
    }
  });
}
