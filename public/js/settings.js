// ============================================================
// settings.js — AI 服务配置 + 账户与用量 + 批改提示词模板
// swup 管理：导出 init/cleanup。表单元素随 main 每次切页重建，均在 init 中绑定。
// ============================================================

import { api, toast, requireAuth, escapeHtml, formatBeijingTime } from './api.js?v=20261026d';

let generation = 0;
let reloadTimer = null;

export function cleanup() {
  generation++;
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
}

function scheduleReload(gen) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (gen === generation) location.reload();
  }, 600);
}

export async function init() {
  const gen = ++generation;
  const user = await requireAuth();
  if (!user || gen !== generation) return;

  // 三个区域的数据与 DOM 相互独立，并行加载、各自处理失败
  await Promise.all([
    initApiSection(gen),
    initBillingSection(gen),
    initPromptSection(gen),
  ]);
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

function quotaBar(label, used, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 100;
  return `<div style="display:flex;align-items:center;gap:8px">
      <span style="min-width:104px">${label}</span>
      <div class="score-bar-track" style="flex:1;height:6px"><div class="score-bar-fill" style="width:${pct}%"></div></div>
      <span style="font-variant-numeric:tabular-nums;color:var(--text-light)">${used}/${limit} 今日</span>
    </div>`;
}

/** 额度行：批改次数来自业务侧（成功计数），其余来自 billing（如百度 OCR） */
function renderQuotaRows(el, quota, billingRows) {
  const rows = [];
  if (quota) {
    rows.push(quotaBar(quota.scope === 'guest' ? '批改（游客）' : '批改（免费通道）', quota.used, quota.limit));
  }
  for (const q of billingRows || []) {
    rows.push(quotaBar(SERVICE_LABELS[q.service] || escapeHtml(q.service), q.used, q.limit));
  }
  const note = quota && quota.scope === 'guest'
    ? `<div class="muted" style="font-size:12px;margin-top:6px">游客：每天 ${quota.essay_limit} 篇 · 一稿/二稿/三稿各一次；登录后每天 10 次、不限篇数</div>`
    : (quota ? '<div class="muted" style="font-size:12px;margin-top:6px">免费通道按「成功批改」计次，失败不扣；DeepSeek 与自备 Key 不计次</div>' : '');
  el.innerHTML = (rows.join('') || '<span class="muted" style="font-size:12px">暂无额度配置</span>') + note;
}

export async function initBillingSection(gen = generation) {
  const balanceEl = document.getElementById('billing-balance');
  const quotaEl = document.getElementById('billing-quota');
  const tbody = document.getElementById('billing-usage-body');
  if (!balanceEl) return;

  // 批改次数先渲染：它不依赖 billing，计费服务抖动时也要能看到剩余次数
  let session = null;
  try { session = await api.me(); } catch { /* 忽略，下面按 billing 结果兜底 */ }
  if (gen !== generation) return;
  if (session?.quota) renderQuotaRows(quotaEl, session.quota, null);

  let me;
  try {
    me = await api.billing.me();
  } catch (err) {
    if (gen !== generation) return;
    balanceEl.textContent = '—';
    if (!session?.quota) {
      // 具体原因由 toast 展示，这里只留一眼可读的状态，避免重复长文案
      quotaEl.innerHTML = '<span class="muted" style="font-size:12px">计费信息暂不可用</span>';
    }
    return;
  }
  if (gen !== generation) return;

  balanceEl.textContent = (me.balance / 100).toFixed(2);

  renderQuotaRows(quotaEl, session?.quota, me.quota?.writing || []);

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
        if (gen !== generation) return;
        toast(`兑换成功，到账 ${(res.points / 100).toFixed(2)} 积分`, 'success');
        input.value = '';
        await initBillingSection(gen);
      } catch (err) {
        if (gen === generation) toast(err.message, 'error');
      } finally {
        if (gen === generation && btn.isConnected) { btn.disabled = false; btn.textContent = '兑换'; }
      }
    });
  }
  const btnReset = document.getElementById('billing-redeem-btn');
  if (btnReset) { btnReset.disabled = false; btnReset.textContent = '兑换'; }
}

// ============================================================
// AI 服务配置
// ============================================================
async function initApiSection(gen = generation) {
  let status = null;
  let degraded = false;
  try {
    status = await api.getApiKeyStatus();
  } catch (err) {
    if (gen !== generation) return;
    // 配置状态查不到（计费服务抖动）时也要把表单渲染出来，
    // 否则整张卡变成空白，用户既看不到选项也不知道发生了什么
    degraded = true;
    status = { configured: false, provider: 'agnes' };
    toast(err.message, 'error');
  }
  if (gen !== generation) return;
  const configured = !!status.configured;

  document.getElementById('status-badge').innerHTML = degraded
    ? '<span class="badge badge-pending">状态未知</span>'
    : configured
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
      if (gen !== generation) return;
      toast('已启用 Agnes 公用免费 API', 'success');
      scheduleReload(gen);
    } catch (err) {
      if (gen !== generation) return;
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
      if (gen !== generation) return;
      toast('配置已保存', 'success');
      scheduleReload(gen);
    } catch (err) {
      if (gen !== generation) return;
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = '保存';
    }
  });
}

// ============================================================
// 批改提示词模板（按模式独立：每个模式一套系统提示词，单独保存）
// ============================================================
/** { list: Map<genre, item>, current, saved } */
let promptState = null;

async function initPromptSection(gen = generation) {
  const select = document.getElementById('prompt-genre');
  const editor = document.getElementById('prompt-editor');
  const saveBtn = document.getElementById('btn-save-prompt');
  const resetBtn = document.getElementById('btn-reset-prompt');
  const dirtyBadge = document.getElementById('prompt-dirty');
  const updatedEl = document.getElementById('prompt-updated');
  const statusBadge = document.getElementById('prompt-status-badge');
  const descEl = document.getElementById('prompt-genre-desc');
  if (!select || !editor) return;

  let data;
  try {
    data = await api.getPrompts();
  } catch (err) {
    if (gen !== generation) return;
    descEl.textContent = `模板加载失败：${err.message}`;
    return;
  }
  if (gen !== generation) return;

  if (!data.prompts?.length) {
    descEl.textContent = '暂无可配置的模式';
    return;
  }

  promptState = {
    list: new Map(data.prompts.map(p => [p.genre, p])),
    current: data.prompts[0].genre,
    saved: '',
  };
  select.innerHTML = data.prompts
    .map(p => `<option value="${escapeHtml(p.genre)}">${escapeHtml(p.label)}</option>`)
    .join('');
  select.value = promptState.current;
  select.disabled = false;

  const isDirty = () => editor.value !== promptState.saved;

  const render = () => {
    const item = promptState.list.get(promptState.current);
    if (!item) return;
    promptState.saved = item.content;
    editor.value = item.content;
    editor.disabled = false;
    saveBtn.disabled = false;
    resetBtn.disabled = !item.is_custom;
    descEl.textContent = item.desc || '';
    statusBadge.innerHTML = item.is_custom
      ? '<span class="badge badge-completed">已自定义</span>'
      : '<span class="badge badge-pending">内置默认</span>';
    updatedEl.textContent = item.updated_at ? `上次保存 ${formatBeijingTime(item.updated_at)}` : '';
    dirtyBadge.hidden = true;
  };
  render();

  editor.addEventListener('input', () => { dirtyBadge.hidden = editor.value === promptState.saved; });

  // 切模式：有未保存改动先确认（各模式内容互不覆盖）
  select.addEventListener('change', () => {
    if (isDirty() && !confirm('当前模式有未保存的修改，切换模式会丢弃。继续？')) {
      select.value = promptState.current;
      return;
    }
    promptState.current = select.value;
    render();
  });

  saveBtn.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const genre = promptState.current;
    const item = promptState.list.get(genre);
    const content = editor.value.trim();
    if (!content.includes('{essay}')) {
      toast('提示词必须包含 {essay} 占位符', 'error');
      return;
    }
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      const res = await api.savePrompt(genre, content);
      if (gen !== generation) return;
      if (item) {
        item.content = content;
        item.is_custom = true;
        item.updated_at = res.updated_at;
      }
      render();
      toast(`已保存「${item ? item.label : genre}」的提示词`, 'success');
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation && btn.isConnected) { btn.disabled = false; btn.textContent = '保存该模式'; }
    }
  });

  resetBtn.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const genre = promptState.current;
    const item = promptState.list.get(genre);
    if (!confirm(`恢复「${item ? item.label : genre}」为内置默认？其他模式的模板不受影响。`)) return;
    btn.disabled = true; btn.textContent = '恢复中...';
    try {
      await api.savePrompt(genre, '');
      if (gen !== generation) return;
      if (item) {
        item.content = item.default_content;
        item.is_custom = false;
        item.updated_at = null;
      }
      render();
      toast('已恢复内置默认', 'success');
    } catch (err) {
      if (gen === generation) toast(err.message, 'error');
    } finally {
      if (gen === generation && btn.isConnected) { btn.disabled = false; btn.textContent = '恢复默认'; }
    }
  });
}
