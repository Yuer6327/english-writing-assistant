// ============================================================
// settings.js — AI 服务配置 + 账户与用量 + 批改提示词模板
// swup 管理：导出 init/cleanup。表单元素随 main 每次切页重建，均在 init 中绑定。
// ============================================================

import { api, toast, requireAuth, escapeHtml, formatBeijingTime } from './api.js?v=20261026';

let disposed = false;

export function cleanup() {
  disposed = true;
}

export async function init() {
  disposed = false;
  const user = await requireAuth();
  if (!user || disposed) return;

  await initApiSection();
  if (disposed) return;
  initBillingSection();
  await initPromptSection();
}

// ============================================================
// 账户与用量（余额 / 免费额度 / 兑换码 / 近期用量）
// ============================================================
const SERVICE_LABELS = {
  'llm:agnes-flash': '批改（免费档）',
  'llm:deepseek-flash': '批改（DeepSeek）',
  'ocr:baidu': '百度 OCR',
  'byok': '自备 Key',
};

export async function initBillingSection() {
  const balanceEl = document.getElementById('billing-balance');
  const quotaEl = document.getElementById('billing-quota');
  const tbody = document.getElementById('billing-usage-body');
  if (!balanceEl) return;

  let me;
  try {
    me = await api.billing.me();
  } catch (err) {
    if (disposed) return;
    balanceEl.textContent = '—';
    quotaEl.innerHTML = `<span style="color:var(--text-light);font-size:12px">计费信息加载失败：${escapeHtml(err.message)}</span>`;
    return;
  }
  if (disposed) return;

  balanceEl.textContent = (me.balance / 100).toFixed(2);

  const quotaRows = (me.quota?.writing || []).map(q => {
    const pct = q.limit > 0 ? Math.min(100, Math.round(q.used / q.limit * 100)) : 100;
    return `<div style="display:flex;align-items:center;gap:8px">
      <span style="min-width:104px">${SERVICE_LABELS[q.service] || q.service}</span>
      <div class="score-bar-track" style="flex:1;height:6px"><div class="score-bar-fill" style="width:${pct}%"></div></div>
      <span style="font-variant-numeric:tabular-nums;color:var(--text-light)">${q.used}/${q.limit} 今日</span>
    </div>`;
  }).join('');
  quotaEl.innerHTML = quotaRows || '<span style="color:var(--text-light);font-size:12px">暂无免费额度配置</span>';

  const statusBadge = (s) => s === 'ok' ? '<span class="badge badge-completed">已计费</span>'
    : s === 'free' ? '<span class="badge badge-pending">免费额度</span>'
    : s === 'byok' ? '<span class="badge badge-new">自备 Key</span>'
    : `<span class="badge badge-failed">${escapeHtml(s)}</span>`;
  tbody.innerHTML = (me.recent_usage || []).map(u => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text-light);white-space:nowrap">${formatBeijingTime(u.created_at)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border)">${SERVICE_LABELS[u.service] || escapeHtml(u.service)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums">${(u.points_charged / 100).toFixed(2)} 积分</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border)">${statusBadge(u.status)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="padding:12px 8px;color:var(--text-light)">暂无用量记录</td></tr>`;

  const form = document.getElementById('billing-redeem-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('billing-code-input');
      const btn = document.getElementById('billing-redeem-btn');
      const code = input.value.trim();
      if (!code) { toast('请输入兑换码', 'error'); return; }
      btn.disabled = true; btn.textContent = '兑换中...';
      try {
        const res = await api.billing.redeem(code);
        toast(`兑换成功，到账 ${(res.points / 100).toFixed(2)} 积分`, 'success');
        input.value = '';
        await initBillingSection();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false; btn.textContent = '兑换';
      }
    });
  }
  const btnReset = document.getElementById('billing-redeem-btn');
  if (btnReset) { btnReset.disabled = false; btnReset.textContent = '兑换'; }
}

// ============================================================
// AI 服务配置
// ============================================================
async function initApiSection() {
  let status;
  try {
    status = await api.getApiKeyStatus();
  } catch (err) {
    if (disposed) return;
    toast(err.message, 'error');
    return;
  }
  if (disposed) return;
  const configured = status.configured;

  document.getElementById('status-badge').innerHTML = configured
    ? '<span class="badge badge-completed">已配置</span>'
    : '<span class="badge badge-failed">未配置（默认使用免费通道）</span>';

  const currentConfig = document.getElementById('current-config');
  if (configured) {
    const isAgnes = status.provider === 'agnes';
    currentConfig.innerHTML = `
      <div style="font-size:13px;color:var(--text-soft)">
        <div>服务商：<strong>${isAgnes ? 'Agnes 公用免费 API' : '自备 API Key（BYOK）'}</strong></div>
        ${isAgnes ? '' : `<div>API 地址：<code>${escapeHtml(status.api_base_url || '')}</code></div>`}
        <div>批改模型：<code>${escapeHtml(status.model_name || '')}</code></div>
        ${status.vision_model_name
          ? `<div>视觉模型：<code>${escapeHtml(status.vision_model_name)}</code>（手写识别 / 看图批改）</div>`
          : `<div>视觉模型：未单独配置（${isAgnes ? 'Agnes 原生支持图片' : '用主模型识别，需支持图片输入'}）</div>`}
      </div>
    `;
  }

  const radioAgnes = document.querySelector('#option-agnes input');
  const radioByok = document.querySelector('#option-byok input');
  const formAgnes = document.getElementById('form-agnes');
  const formByok = document.getElementById('form-byok');

  (configured && status.provider === 'byok' ? radioByok : radioAgnes).checked = true;

  function syncForms() {
    const agnes = radioAgnes.checked;
    formAgnes.style.display = agnes ? 'block' : 'none';
    formByok.style.display = agnes ? 'none' : 'block';
    document.getElementById('option-agnes').classList.toggle('selected', agnes);
    document.getElementById('option-byok').classList.toggle('selected', !agnes);
  }

  if (configured && status.provider === 'byok') {
    document.getElementById('api-base-url').value = status.api_base_url || '';
    document.getElementById('model-name').value = status.model_name || '';
    if (status.vision_model_name) {
      document.getElementById('vision-model-name').value = status.vision_model_name;
      document.getElementById('vision-api-base-url').value = status.vision_api_base_url || '';
    }
    document.getElementById('api-key-tip').textContent = '（已配置，留空则保持不变）';
  }

  syncForms();
  radioAgnes.addEventListener('change', syncForms);
  radioByok.addEventListener('change', syncForms);

  formAgnes.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      await api.saveApiKey({ provider: 'agnes' });
      toast('已启用 Agnes 公用免费 API', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = '启用 Agnes 免费 API';
    }
  });

  formByok.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      provider: 'byok',
      api_key: document.getElementById('api-key').value.trim() || undefined,
      api_base_url: document.getElementById('api-base-url').value.trim() || undefined,
      model_name: document.getElementById('model-name').value.trim() || undefined,
      vision_model_name: document.getElementById('vision-model-name').value.trim() || undefined,
      vision_api_base_url: document.getElementById('vision-api-base-url').value.trim() || undefined,
      vision_api_key: document.getElementById('vision-api-key').value.trim() || undefined,
    };
    if (!payload.api_key && !configured) { toast('API Key 不能为空', 'error'); return; }

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      await api.saveApiKey(payload);
      toast('配置已保存', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = '保存';
    }
  });
}

// ============================================================
// 批改提示词模板
// ============================================================
async function initPromptSection() {
  const listEl = document.getElementById('prompt-list');
  listEl.innerHTML = '<span class="spinner"></span> 加载中...';

  let data;
  try {
    data = await api.getPrompts();
  } catch (err) {
    if (disposed) return;
    listEl.innerHTML = `<div style="color:var(--text-soft);font-size:13px">加载失败：${escapeHtml(err.message)}</div>`;
    return;
  }
  if (disposed) return;

  listEl.innerHTML = '';
  for (const p of data.prompts) {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '18px';
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-weight:600;font-size:14px">
          ${escapeHtml(p.label)}
          <span style="font-weight:400;font-size:12px;color:var(--text-light)">${escapeHtml(p.desc)}</span>
        </div>
        <span class="badge ${p.is_default ? 'badge-pending' : 'badge-completed'}">${p.is_default ? '内置默认' : '已自定义'}</span>
      </div>
      <textarea class="form-input" rows="10" style="font-family:var(--font-mono);font-size:12px;line-height:1.6"
        data-prompt-content>${escapeHtml(p.content)}</textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button type="button" class="btn btn-primary" data-save style="padding:6px 16px;font-size:13px">保存修改</button>
        <button type="button" class="btn" data-reset style="padding:6px 16px;font-size:13px">恢复默认</button>
      </div>
    `;

    const textarea = wrap.querySelector('[data-prompt-content]');
    const defaultContent = p.content;

    wrap.querySelector('[data-save]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const content = textarea.value.trim();
      if (!content.includes('{essay}')) {
        toast('提示词必须包含 {essay} 占位符', 'error');
        return;
      }
      btn.disabled = true; btn.textContent = '保存中...';
      try {
        await api.savePrompt(p.genre, content);
        toast('模板已保存', 'success');
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false; btn.textContent = '保存修改';
      }
    });

    wrap.querySelector('[data-reset]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.savePrompt(p.genre, '');
        toast('已恢复内置默认', 'success');
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false; btn.textContent = '恢复默认';
      }
    });

    listEl.appendChild(wrap);
  }
}
