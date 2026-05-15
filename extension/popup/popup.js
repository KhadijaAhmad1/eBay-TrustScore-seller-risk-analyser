/**
 * eBay TrustScore v1.1 — Popup Script
 * Supports Claude, OpenAI, Gemini, and custom OpenAI-compatible endpoints
 */

const BREAKDOWN_LABELS = {
  feedbackVolume: 'Feedback Volume',
  feedbackRate:   'Positive Rate',
  accountAge:     'Account Age',
  priceAnomaly:   'Price Analysis',
  listingQuality: 'Listing Quality',
  deliveryComplaints: 'Delivery Record'
};

const PROVIDER_META = {
  claude:  { label: 'CLAUDE AI',  dotClass: 'claude' },
  openai:  { label: 'OPENAI GPT', dotClass: 'openai' },
  gemini:  { label: 'GEMINI AI',  dotClass: 'gemini' },
  custom:  { label: 'CUSTOM LLM', dotClass: 'custom' },
};

// ── SETTINGS TAB ────────────────────────────────────────────────────────────
let selectedProvider = 'claude';

function initSettingsTab() {
  // Load saved settings
  chrome.storage.local.get(['ts_ai_config'], (res) => {
    const cfg = res.ts_ai_config || {};
    if (cfg.enabled) document.getElementById('aiEnabledToggle').checked = true;
    if (cfg.provider) {
      selectedProvider = cfg.provider;
      switchProviderUI(selectedProvider);
    }
    if (cfg.claudeKey)    document.getElementById('cfgClaudeKey').value   = cfg.claudeKey;
    if (cfg.claudeModel)  document.getElementById('cfgClaudeModel').value = cfg.claudeModel;
    if (cfg.openaiKey)    document.getElementById('cfgOpenaiKey').value   = cfg.openaiKey;
    if (cfg.openaiModel)  document.getElementById('cfgOpenaiModel').value = cfg.openaiModel;
    if (cfg.geminiKey)    document.getElementById('cfgGeminiKey').value   = cfg.geminiKey;
    if (cfg.geminiModel)  document.getElementById('cfgGeminiModel').value = cfg.geminiModel;
    if (cfg.customUrl)    document.getElementById('cfgCustomUrl').value   = cfg.customUrl;
    if (cfg.customKey)    document.getElementById('cfgCustomKey').value   = cfg.customKey;
    if (cfg.customModel)  document.getElementById('cfgCustomModel').value = cfg.customModel;
  });

  // Provider toggle buttons
  document.querySelectorAll('.p-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedProvider = btn.dataset.p;
      document.querySelectorAll('.p-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchProviderUI(selectedProvider);
    });
  });

  // Eye (show/hide) buttons
  document.querySelectorAll('.eye-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.t);
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? '👁' : '🙈';
    });
  });

  // Save button
  document.getElementById('saveSettingsBtn').addEventListener('click', () => {
    const cfg = {
      enabled:     document.getElementById('aiEnabledToggle').checked,
      provider:    selectedProvider,
      claudeKey:   document.getElementById('cfgClaudeKey').value.trim(),
      claudeModel: document.getElementById('cfgClaudeModel').value,
      openaiKey:   document.getElementById('cfgOpenaiKey').value.trim(),
      openaiModel: document.getElementById('cfgOpenaiModel').value,
      geminiKey:   document.getElementById('cfgGeminiKey').value.trim(),
      geminiModel: document.getElementById('cfgGeminiModel').value,
      customUrl:   document.getElementById('cfgCustomUrl').value.trim(),
      customKey:   document.getElementById('cfgCustomKey').value.trim(),
      customModel: document.getElementById('cfgCustomModel').value.trim(),
    };
    chrome.storage.local.set({ ts_ai_config: cfg }, () => {
      const ok = document.getElementById('saveOk');
      ok.classList.remove('hidden');
      setTimeout(() => ok.classList.add('hidden'), 2000);
    });
  });
}

function switchProviderUI(p) {
  document.querySelectorAll('.pcfg').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(`pcfg${p.charAt(0).toUpperCase()}${p.slice(1)}`);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.p-btn').forEach(b => b.classList.toggle('active', b.dataset.p === p));
}

// ── TAB SWITCHING ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.htab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.htab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(tc => {
        tc.classList.toggle('hidden', !tc.id.toLowerCase().includes(target));
      });
    });
  });
}

// ── AI CALLS ─────────────────────────────────────────────────────────────────
function buildPrompt(report, sellerData) {
  const flagList = report.flags.map(f => `- [${f.type.toUpperCase()}] ${f.message}`).join('\n');
  const bdList = Object.entries(report.breakdown).map(([k, v]) => `- ${BREAKDOWN_LABELS[k]}: ${v.score}/${v.max}`).join('\n');
  return `You are an eBay buyer safety assistant. Analyse this seller risk report and write 2-3 plain-English sentences of practical buyer guidance. No markdown, no bullet points — just clear prose.

SELLER DATA:
- Feedback count: ${sellerData?.feedbackCount?.toLocaleString?.() || 'unknown'}
- Positive feedback rate: ${sellerData?.feedbackPercent || 'unknown'}%
- Account age: ${sellerData?.accountAgeDays || 'unknown'} days
- Price vs market: ${sellerData?.priceVsMarket?.toFixed?.(2) || 'unknown'}×
- Delivery complaint rate: ${sellerData?.deliveryComplaintRate?.toFixed?.(1) || 'unknown'}%

RISK SCORE: ${report.score}/100 (${report.riskLabel})
BREAKDOWN:\n${bdList}
FLAGS:\n${flagList || 'None'}

Your 2-3 sentence buyer guidance:`;
}

async function fetchAISummary(cfg, report, sellerData) {
  const prompt = buildPrompt(report, sellerData);

  if (cfg.provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.claudeKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.claudeModel || 'claude-sonnet-4-20250514',
        max_tokens: 250,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  if (cfg.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.openaiKey}` },
      body: JSON.stringify({ model: cfg.openaiModel || 'gpt-4o', max_tokens: 250, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (cfg.provider === 'gemini') {
    const model = cfg.geminiModel || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 250 } })
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (cfg.provider === 'custom') {
    const base = (cfg.customUrl || 'http://localhost:11434/v1').replace(/\/$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.customKey) headers['Authorization'] = `Bearer ${cfg.customKey}`;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: cfg.customModel || 'llama3', max_tokens: 250, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  return '';
}

// ── REPORT RENDERING ─────────────────────────────────────────────────────────
async function renderReport(report) {
  const { score, riskLevel, riskLabel, summary, flags, breakdown, sellerData } = report;

  // Ring
  const circumference = 314;
  const offset = circumference - (score / 100) * circumference;
  const ringFill = document.getElementById('ringFill');
  const colors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444', critical: '#dc2626' };
  ringFill.style.stroke = colors[riskLevel] || '#6b7280';
  setTimeout(() => { ringFill.style.strokeDashoffset = offset; }, 100);

  animateNumber(document.getElementById('scoreNum'), 0, score, 800);

  const pill = document.getElementById('riskPill');
  pill.textContent = riskLabel;
  pill.className = `risk-pill ${riskLevel}`;

  document.getElementById('scoreItemTitle').textContent = sellerData?.title || 'eBay Listing';

  // AI summary
  const hdr = document.getElementById('aiSummaryHdr');
  const dot = document.getElementById('aiDot');
  const lbl = document.getElementById('aiHdrLabel');
  const body = document.getElementById('summaryBox');

  chrome.storage.local.get(['ts_ai_config'], async (res) => {
    const cfg = res.ts_ai_config || {};

    if (cfg.enabled && cfg.provider) {
      const pm = PROVIDER_META[cfg.provider];
      dot.className = `ai-dot ${pm.dotClass}`;
      lbl.textContent = pm.label + ' SUMMARY';

      body.innerHTML = '<div class="thinking"><span></span><span></span><span></span></div>';

      try {
        const text = await fetchAISummary(cfg, report, sellerData);
        // Typing effect
        body.innerHTML = '';
        const cursor = document.createElement('span');
        cursor.className = 'stream-cursor';
        body.appendChild(cursor);
        let i = 0;
        const iv = setInterval(() => {
          if (i < text.length) { body.insertBefore(document.createTextNode(text[i]), cursor); i++; }
          else { cursor.remove(); clearInterval(iv); }
        }, 14);
      } catch (err) {
        body.innerHTML = `<div class="ai-error">⚠ ${err.message}<br>Check your API key in the AI ⚙ tab.</div>`;
      }
    } else {
      dot.className = 'ai-dot';
      lbl.textContent = 'HEURISTIC SUMMARY';
      body.textContent = summary || '—';
    }
  });

  // Breakdown bars
  const breakdownEl = document.getElementById('breakdown');
  breakdownEl.innerHTML = '';
  Object.entries(breakdown).forEach(([key, val]) => {
    const pct = Math.round((val.score / val.max) * 100);
    const color = pct >= 75 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
    const row = document.createElement('div');
    row.className = 'bd-row';
    row.innerHTML = `
      <span class="bd-label">${BREAKDOWN_LABELS[key] || key}</span>
      <div class="bd-track"><div class="bd-fill" style="background:${color}" data-width="${pct}%"></div></div>
      <span class="bd-pts">${val.score}/${val.max}</span>
    `;
    breakdownEl.appendChild(row);
  });
  setTimeout(() => {
    breakdownEl.querySelectorAll('.bd-fill').forEach(el => { el.style.width = el.dataset.width; });
  }, 200);

  // Flags
  const flagsList = document.getElementById('flagsList');
  const flagsLabel = document.getElementById('flagsLabel');
  flagsList.innerHTML = '';

  if (flags && flags.length > 0) {
    flagsLabel.style.display = 'block';
    flags.forEach(flag => {
      const item = document.createElement('div');
      item.className = `flag-item ${flag.type}`;
      const icon = flag.type === 'danger' ? '⚠' : flag.type === 'warning' ? '●' : 'ℹ';
      item.innerHTML = `<span class="flag-icon">${icon}</span><span>${flag.message}</span>`;
      flagsList.appendChild(item);
    });
  } else {
    flagsLabel.style.display = 'none';
  }

  show('stateReport');
}

// ── MAIN INIT ────────────────────────────────────────────────────────────────
async function init() {
  initTabs();
  initSettingsTab();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isEbayListing = tab?.url && (tab.url.includes('ebay.co.uk/itm/') || tab.url.includes('ebay.com/itm/'));

  if (!isEbayListing) { show('stateNoListing'); return; }

  show('stateLoading');

  chrome.runtime.sendMessage({ type: 'GET_STORED_REPORT' }, (response) => {
    if (response?.report) {
      renderReport(response.report);
    } else {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'GET_STORED_REPORT' }, (r2) => {
          if (r2?.report) renderReport(r2.report);
          else show('stateNoListing');
        });
      }, 2200);
    }
  });
}

function animateNumber(el, from, to, duration) {
  const start = performance.now();
  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(from + (to - from) * ease);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

function show(stateId) {
  ['stateNoListing', 'stateLoading', 'stateReport'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== stateId);
  });
}

document.addEventListener('DOMContentLoaded', init);
