import { SUPABASE_URL, SUPABASE_ANON_KEY, MAX_OUT_SECONDS } from './config.js';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Color thresholds ──
// Green:  under 2h (MAX_OUT_SECONDS)
// Yellow: 2h – 2.5h (MAX_OUT_SECONDS to MAX_OUT_SECONDS + 1800)
// Red:    over 2.5h
const WARN_SECONDS = MAX_OUT_SECONDS + 30 * 60;  // 2h 30m

// ── App state ──
const state = {
  view: 'dashboard',
  running: false,
  startedAt: null,
  elapsed: 0,
  ticker: null,
  sessions: [],
  currentTray: 1,
  calMonth: new Date().getMonth(),
  calYear: new Date().getFullYear(),
  charts: {},
  pendingDelete: null,
};

// ── Helpers ──
function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function isoDateEST(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
}

function todayTotalSeconds() {
  const today = isoDateEST();
  return state.sessions
    .filter(s => s.date_est === today)
    .reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
}

function statusColor(sec) {
  if (sec >= WARN_SECONDS) return 'var(--red)';
  if (sec >= MAX_OUT_SECONDS) return 'var(--amber)';
  return 'var(--mint)';
}

function durClass(sec) {
  if (sec >= WARN_SECONDS) return 'danger';
  if (sec >= MAX_OUT_SECONDS) return 'warning';
  return 'good';
}

// ── Timer persistence (survives refresh) ──
function persistTimer() {
  if (state.running && state.startedAt) {
    localStorage.setItem('sw_startedAt', state.startedAt.toISOString());
  } else {
    localStorage.removeItem('sw_startedAt');
  }
}

function restoreTimer() {
  const saved = localStorage.getItem('sw_startedAt');
  if (saved) {
    const startedAt = new Date(saved);
    // Only restore if started within the last 4 hours (sanity check)
    if (Date.now() - startedAt.getTime() < 4 * 3600 * 1000) {
      state.running = true;
      state.startedAt = startedAt;
      state.elapsed = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      state.ticker = setInterval(() => {
        state.elapsed = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
        updateStopwatchDisplay();
      }, 1000);
    } else {
      localStorage.removeItem('sw_startedAt');
    }
  }
}

// ── Supabase ops ──
async function loadSessions() {
  const { data, error } = await db
    .from('sessions')
    .select('*')
    .order('started_at', { ascending: false });
  if (!error) state.sessions = data || [];
}

async function loadTray() {
  const { data } = await db.from('settings').select('value').eq('key', 'current_tray').single();
  if (data) state.currentTray = parseInt(data.value) || 1;
}

async function saveTray(tray) {
  await db.from('settings').upsert({ key: 'current_tray', value: String(tray) });
  state.currentTray = tray;
}

async function saveSession(session) {
  const { error } = await db.from('sessions').insert(session);
  if (error) console.error('Save error:', error);
  await loadSessions();
}

async function deleteSession(id) {
  const { error } = await db.from('sessions').delete().eq('id', id);
  if (error) { console.error('Delete error:', error); return; }
  await loadSessions();
  hideToast();
  if (state.view === 'log') renderLog();
  if (state.view === 'dashboard') {
    document.getElementById('recent-sessions').innerHTML = renderRecentSessions();
    updateStopwatchDisplay();
  }
  if (state.view === 'graphs') renderGraphs();
  if (state.view === 'calendar') renderCalendar();
}

// ── Stopwatch ──
function startTimer() {
  if (state.running) return;
  state.running = true;
  state.startedAt = new Date();
  state.elapsed = 0;
  persistTimer();
  state.ticker = setInterval(() => {
    state.elapsed = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
    updateStopwatchDisplay();
  }, 1000);
  updateStopwatchDisplay();
  renderStopwatchButtons();
}

async function stopTimer() {
  if (!state.running) return;
  clearInterval(state.ticker);
  state.running = false;
  const duration = state.elapsed;
  const startedAt = state.startedAt;
  state.elapsed = 0;
  state.startedAt = null;
  persistTimer();

  const session = {
    started_at: startedAt.toISOString(),
    ended_at: new Date().toISOString(),
    duration_seconds: duration,
    date_est: isoDateEST(startedAt),
    time_est: startedAt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true }),
    tray_number: state.currentTray,
  };

  await saveSession(session);
  updateStopwatchDisplay();
  renderStopwatchButtons();
  renderStats();
  if (state.view === 'log') renderLog();
  if (state.view === 'graphs') renderGraphs();
  if (state.view === 'calendar') renderCalendar();
  if (state.view === 'dashboard') {
    document.getElementById('recent-sessions').innerHTML = renderRecentSessions();
  }
}

function resetTimer() {
  if (state.running) return;
  state.elapsed = 0;
  persistTimer();
  updateStopwatchDisplay();
  renderStopwatchButtons();
}

// ── Ring + display ──
function updateStopwatchDisplay() {
  const display = document.getElementById('sw-display');
  const sub = document.getElementById('sw-sub');
  const ring = document.getElementById('sw-ring');
  if (!display || !ring) return;

  const sec = state.elapsed;
  display.textContent = fmt(sec);

  const todayTotal = todayTotalSeconds() + sec;
  // Ring fills to MAX_OUT_SECONDS then stops at full; color changes past that
  const ratio = Math.min(todayTotal / MAX_OUT_SECONDS, 1);
  const circumference = 2 * Math.PI * 80;
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference * (1 - ratio)}`;
  ring.style.stroke = statusColor(todayTotal);

  if (sub) sub.textContent = `Today: ${fmtDur(todayTotal)} out`;
  renderStats();
  renderAlert(todayTotal);
}

function renderAlert(todayTotal) {
  const el = document.getElementById('sw-alert');
  if (!el) return;
  const remaining = MAX_OUT_SECONDS - todayTotal;
  const over = todayTotal - MAX_OUT_SECONDS;

  if (todayTotal >= WARN_SECONDS) {
    el.className = 'alert-bar danger';
    el.innerHTML = `🚨 <strong>${fmtDur(todayTotal - MAX_OUT_SECONDS)} over limit</strong> — put your aligners back in now!`;
    el.style.display = 'flex';
  } else if (todayTotal >= MAX_OUT_SECONDS) {
    el.className = 'alert-bar warning';
    el.innerHTML = `⚠️ Limit reached — ${fmtDur(over)} over. You have 30 min before the red zone.`;
    el.style.display = 'flex';
  } else if (remaining <= 900) {
    el.className = 'alert-bar warning';
    el.innerHTML = `⚡ Only <strong>${fmtDur(remaining)}</strong> left today — wrap up soon.`;
    el.style.display = 'flex';
  } else if (state.running) {
    el.className = 'alert-bar success';
    el.innerHTML = `▶ Running — <strong>${fmtDur(remaining)}</strong> remaining today.`;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}

function renderStats() {
  const todayTotal = todayTotalSeconds() + (state.running ? state.elapsed : 0);
  const remaining = Math.max(0, MAX_OUT_SECONDS - todayTotal);
  const sessions7 = state.sessions.filter(s =>
    (Date.now() - new Date(s.started_at).getTime()) < 7 * 86400000
  );
  const avg7 = sessions7.length > 0
    ? sessions7.reduce((a, b) => a + b.duration_seconds, 0) / 7
    : 0;

  const todayEl = document.getElementById('stat-today');
  const remEl   = document.getElementById('stat-remaining');
  const avgEl   = document.getElementById('stat-avg');
  if (todayEl) todayEl.textContent = fmtDur(todayTotal);
  if (remEl) {
    remEl.textContent = remaining > 0 ? fmtDur(remaining) : 'OVER';
    remEl.className = 'stat-value ' + (remaining <= 0 ? 'red' : remaining <= 1800 ? 'amber' : 'mint');
  }
  if (avgEl) avgEl.textContent = fmtDur(Math.round(avg7));
}

function renderStopwatchButtons() {
  const btn      = document.getElementById('sw-main-btn');
  const resetBtn = document.getElementById('sw-reset-btn');
  if (!btn) return;
  if (state.running) {
    btn.textContent = '⏹ Stop & Log';
    btn.className = 'sw-btn sw-btn-primary running';
    btn.onclick = stopTimer;
  } else {
    btn.textContent = '▶ Start';
    btn.className = 'sw-btn sw-btn-primary';
    btn.onclick = startTimer;
  }
  if (resetBtn) {
    resetBtn.disabled = state.running || state.elapsed === 0;
  }
}

// ── Delete toast ──
function showDeleteToast(id, label) {
  hideToast();
  state.pendingDelete = id;
  const t = document.createElement('div');
  t.className = 'toast';
  t.id = 'delete-toast';
  t.innerHTML = `
    <span>Delete session ${label}?</span>
    <button class="toast-confirm" onclick="app.confirmDelete()">Delete</button>
    <button class="toast-cancel" onclick="app.hideToast()">Cancel</button>
  `;
  document.body.appendChild(t);
  setTimeout(() => { if (document.getElementById('delete-toast')) hideToast(); }, 6000);
}

function hideToast() {
  const t = document.getElementById('delete-toast');
  if (t) t.remove();
  state.pendingDelete = null;
}

// ── Sidebar / nav ──
function renderNav(mobile = false) {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: '⊞' },
    { id: 'log',       label: 'Log',       icon: '☰' },
    { id: 'graphs',    label: 'Graphs',    icon: '⌇' },
    { id: 'calendar',  label: 'Calendar',  icon: '▦' },
  ];
  if (mobile) {
    return items.map(i => `
      <div class="mobile-nav-item ${state.view === i.id ? 'active' : ''}" onclick="app.navigate('${i.id}')">
        <span class="mob-icon">${i.icon}</span>
        <span>${i.label}</span>
      </div>
    `).join('');
  }
  return items.map(i => `
    <div class="nav-item ${state.view === i.id ? 'active' : ''}" onclick="app.navigate('${i.id}')">
      <span class="nav-icon">${i.icon}</span> ${i.label}
    </div>
  `).join('');
}

function renderSidebar() {
  return `
    <aside class="sidebar">
      <div class="sidebar-logo">
        <h1>Invisalign</h1>
        <p>22hr wear tracker</p>
      </div>
      ${renderNav(false)}
      <div class="tray-badge">
        <label>Current Tray</label>
        <div class="tray-input-wrap">
          <input class="tray-input" type="number" id="tray-input" min="1" max="99" value="${state.currentTray}" />
          <button class="tray-save-btn" onclick="app.saveTrayNum()">Save</button>
        </div>
      </div>
    </aside>`;
}

function renderMobileHeader() {
  return `
    <header class="mobile-header">
      <span class="mobile-header-title">Invisalign</span>
      <button class="mobile-tray-btn" onclick="app.openTrayModal()">
        Tray <span>#${state.currentTray}</span>
      </button>
    </header>`;
}

function renderMobileNav() {
  return `
    <nav class="mobile-nav">
      <div class="mobile-nav-inner">${renderNav(true)}</div>
    </nav>`;
}

// ── Tray modal (mobile) ──
function openTrayModal() {
  const overlay = document.createElement('div');
  overlay.className = 'tray-modal-overlay';
  overlay.id = 'tray-modal';
  overlay.innerHTML = `
    <div class="tray-modal">
      <h3>Update tray number</h3>
      <div class="tray-modal-row">
        <input class="tray-input" type="number" id="tray-modal-input" min="1" max="99" value="${state.currentTray}" style="width:80px;font-size:24px;" />
        <button class="tray-modal-save" onclick="app.saveTrayModal()">Save</button>
        <button class="tray-modal-cancel" onclick="app.closeTrayModal()">Cancel</button>
      </div>
    </div>`;
  overlay.onclick = e => { if (e.target === overlay) app.closeTrayModal(); };
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('tray-modal-input')?.focus(), 50);
}

function closeTrayModal() {
  document.getElementById('tray-modal')?.remove();
}

async function saveTrayModal() {
  const v = parseInt(document.getElementById('tray-modal-input')?.value);
  if (v > 0) {
    await saveTray(v);
    closeTrayModal();
    // Update mobile header tray display
    const btn = document.querySelector('.mobile-tray-btn span');
    if (btn) btn.textContent = `#${v}`;
    // Update sidebar tray display
    const sideInput = document.getElementById('tray-input');
    if (sideInput) sideInput.value = v;
    // Update stopwatch status
    const status = document.querySelector('.stopwatch-status span:first-child');
    if (status) status.textContent = `#${v}`;
  }
}

// ── Views ──
function renderDashboard() {
  const circumference = 2 * Math.PI * 80;
  const todayTotal = todayTotalSeconds() + (state.running ? state.elapsed : 0);
  const ratio = Math.min(todayTotal / MAX_OUT_SECONDS, 1);

  return `
    <div class="page-title">Dashboard</div>
    <div id="sw-alert" class="alert-bar" style="display:none"></div>
    <div class="dashboard-grid">
      <div class="card stopwatch-card">
        <div class="ring-container">
          <svg class="ring-svg" width="200" height="200" viewBox="0 0 200 200">
            <circle class="ring-bg" cx="100" cy="100" r="80"/>
            <circle class="ring-fill" id="sw-ring" cx="100" cy="100" r="80"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${circumference * (1 - ratio)}"
              style="stroke:${statusColor(todayTotal)}"/>
          </svg>
          <div class="stopwatch-display" id="sw-display">${fmt(state.elapsed)}</div>
          <div class="stopwatch-sub" id="sw-sub">Today: ${fmtDur(todayTotal)} out</div>
        </div>

        <p class="stopwatch-status">
          Tray <span>#${state.currentTray}</span>
          &nbsp;·&nbsp;
          ${state.running
            ? `<span>Running since ${state.startedAt?.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true, hour: '2-digit', minute: '2-digit' })}</span>`
            : 'Ready'}
        </p>

        <div class="sw-btn-row">
          <button class="sw-btn sw-btn-primary${state.running ? ' running' : ''}" id="sw-main-btn"
            onclick="${state.running ? 'app.stop()' : 'app.start()'}">
            ${state.running ? '⏹ Stop & Log' : '▶ Start'}
          </button>
          <button class="sw-btn sw-btn-secondary" id="sw-reset-btn"
            onclick="app.reset()" ${state.running || state.elapsed === 0 ? 'disabled' : ''}>
            Reset
          </button>
        </div>
      </div>

      <div class="card" style="padding:20px 0; grid-column: 1 / -1;">
        <div style="display:grid; grid-template-columns: repeat(3,1fr);">
          <div class="stat-card">
            <div class="stat-label">Today out</div>
            <div class="stat-value mint" id="stat-today">${fmtDur(todayTotal)}</div>
          </div>
          <div class="stat-card" style="border-left:1px solid var(--border);border-right:1px solid var(--border);">
            <div class="stat-label">Remaining</div>
            <div class="stat-value ${durClass(todayTotal) === 'good' ? 'mint' : durClass(todayTotal) === 'warning' ? 'amber' : 'red'}" id="stat-remaining">${Math.max(0, MAX_OUT_SECONDS - todayTotal) > 0 ? fmtDur(Math.max(0, MAX_OUT_SECONDS - todayTotal)) : 'OVER'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">7-day avg</div>
            <div class="stat-value" id="stat-avg">—</div>
          </div>
        </div>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <div class="section-title">Recent Sessions</div>
        <div id="recent-sessions">${renderRecentSessions()}</div>
      </div>
    </div>`;
}

function renderRecentSessions() {
  const recent = state.sessions.slice(0, 5);
  if (!recent.length) return `<p class="empty-state">No sessions yet. Start the timer!</p>`;
  return recent.map(s => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
      <div>
        <span style="font-size:13px;color:var(--text);">${s.date_est}</span>
        <span style="font-size:12px;color:var(--text-3);margin-left:8px;">${s.time_est || ''}</span>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <span class="tray-pill">T${s.tray_number}</span>
        <span style="font-family:'DM Mono',monospace;font-size:14px;color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</span>
        <button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')" title="Delete">✕</button>
      </div>
    </div>
  `).join('') + `<div style="border-bottom:none;height:1px"></div>`;
}

function renderLog() {
  const filterEl = document.getElementById('log-filter');
  const filterVal = filterEl ? filterEl.value.toLowerCase() : '';
  let sessions = [...state.sessions];
  if (filterVal) {
    sessions = sessions.filter(s =>
      s.date_est?.includes(filterVal) || String(s.tray_number)?.includes(filterVal)
    );
  }

  const tableRows = sessions.map(s => `
    <tr>
      <td class="mono">${s.date_est || '—'}</td>
      <td>${s.time_est || '—'}</td>
      <td class="mono" style="color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</td>
      <td><span class="tray-pill">T${s.tray_number}</span></td>
      <td><button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')" title="Delete session">✕</button></td>
    </tr>
  `).join('');

  const mobileCards = sessions.map(s => `
    <div class="log-card">
      <div class="log-card-left">
        <div class="log-card-date">${s.date_est || '—'}</div>
        <div class="log-card-time">${s.time_est || '—'}</div>
      </div>
      <div class="log-card-right">
        <div class="log-card-dur" style="color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="tray-pill">T${s.tray_number}</span>
          <button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')" title="Delete">✕</button>
        </div>
      </div>
    </div>
  `).join('');

  document.querySelector('.main').innerHTML = `
    <div class="page-title">Session Log</div>
    <div class="log-filters">
      <input class="filter-input" placeholder="Filter by date or tray..." id="log-filter"
        value="${filterVal}" oninput="app.filterLog()" />
      <span style="font-size:12px;color:var(--text-3);white-space:nowrap;">${sessions.length} sessions</span>
    </div>
    ${sessions.length === 0
      ? `<div class="card"><p class="empty-state">No sessions found.</p></div>`
      : `
        <div class="log-table-wrap card" style="padding:0;overflow:hidden;">
          <table class="log-table">
            <thead><tr>
              <th>Date</th><th>Start Time</th><th>Duration</th><th>Tray</th><th></th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <div class="log-cards">${mobileCards}</div>
      `}
  `;
}

function renderGraphs() {
  document.querySelector('.main').innerHTML = `
    <div class="page-title">Graphs</div>
    <div class="charts-grid">
      <div class="card chart-full">
        <div class="section-title">Daily out-time — last 30 days</div>
        <div class="chart-canvas-wrap"><canvas id="chart-daily"></canvas></div>
      </div>
      <div class="card">
        <div class="section-title">By day of week</div>
        <div class="chart-canvas-wrap"><canvas id="chart-dow"></canvas></div>
      </div>
      <div class="card">
        <div class="section-title">Session duration mix</div>
        <div class="chart-canvas-wrap"><canvas id="chart-dist"></canvas></div>
      </div>
    </div>`;
  drawCharts();
}

function drawCharts() {
  // Daily out-time last 30 days
  const last30 = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last30[isoDateEST(d)] = 0;
  }
  state.sessions.forEach(s => {
    if (last30.hasOwnProperty(s.date_est)) last30[s.date_est] += s.duration_seconds / 60;
  });
  const labels30 = Object.keys(last30).map(d => { const [,m,day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}`; });
  const data30 = Object.values(last30);

  const barColor = v => v > WARN_SECONDS/60 ? 'rgba(224,92,92,0.75)' : v > MAX_OUT_SECONDS/60 ? 'rgba(245,166,35,0.75)' : 'rgba(0,201,167,0.7)';

  if (state.charts.daily) state.charts.daily.destroy();
  state.charts.daily = new Chart(document.getElementById('chart-daily'), {
    type: 'bar',
    data: { labels: labels30, datasets: [{ data: data30, backgroundColor: data30.map(barColor), borderRadius: 4 }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${Math.round(ctx.raw)}m` } } },
      scales: {
        x: { ticks: { color: '#8896A5', font: { size: 10 }, maxRotation: 0 }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#8896A5', callback: v => `${v}m` }, grid: { color: 'rgba(255,255,255,0.06)' } }
      },
      responsive: true, maintainAspectRatio: false,
    }
  });

  // Day of week
  const dow = Array(7).fill(0);
  state.sessions.forEach(s => { dow[new Date(s.started_at).getDay()] += s.duration_seconds / 60; });

  if (state.charts.dow) state.charts.dow.destroy();
  state.charts.dow = new Chart(document.getElementById('chart-dow'), {
    type: 'bar',
    data: { labels: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], datasets: [{ data: dow, backgroundColor: 'rgba(0,201,167,0.6)', borderRadius: 4 }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${Math.round(ctx.raw)}m` } } },
      scales: {
        x: { ticks: { color: '#8896A5', font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#8896A5', callback: v => `${Math.round(v)}m` }, grid: { color: 'rgba(255,255,255,0.06)' } }
      },
      responsive: true, maintainAspectRatio: false,
    }
  });

  // Duration distribution
  const buckets = { '<15m': 0, '15–30m': 0, '30–60m': 0, '60–90m': 0, '>90m': 0 };
  state.sessions.forEach(s => {
    const m = s.duration_seconds / 60;
    if (m < 15) buckets['<15m']++;
    else if (m < 30) buckets['15–30m']++;
    else if (m < 60) buckets['30–60m']++;
    else if (m < 90) buckets['60–90m']++;
    else buckets['>90m']++;
  });

  if (state.charts.dist) state.charts.dist.destroy();
  state.charts.dist = new Chart(document.getElementById('chart-dist'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(buckets),
      datasets: [{ data: Object.values(buckets), backgroundColor: ['rgba(0,201,167,0.8)','rgba(0,201,167,0.5)','rgba(245,166,35,0.65)','rgba(245,166,35,0.9)','rgba(224,92,92,0.8)'], borderWidth: 0 }]
    },
    options: {
      plugins: { legend: { labels: { color: '#8896A5', font: { size: 11 } } } },
      responsive: true, maintainAspectRatio: false, cutout: '60%',
    }
  });
}

function renderCalendar() {
  const year = state.calYear, month = state.calMonth;
  const monthName = new Date(year, month, 1).toLocaleString('default', { month: 'long' });

  const dailyTotals = {}, dailyTrays = {};
  state.sessions.forEach(s => {
    if (!s.date_est) return;
    const [y, m] = s.date_est.split('-').map(Number);
    if (y === year && m - 1 === month) {
      dailyTotals[s.date_est] = (dailyTotals[s.date_est] || 0) + s.duration_seconds;
      dailyTrays[s.date_est] = s.tray_number;
    }
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = isoDateEST();

  let cells = Array(firstDay).fill('<div class="cal-cell empty"></div>').join('');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const sec = dailyTotals[dateStr] || 0;
    const dc = sec === 0 ? '' : durClass(sec);
    const tray = dailyTrays[dateStr];
    cells += `
      <div class="cal-cell ${isToday ? 'today' : ''}">
        <div class="cal-date">${d}</div>
        ${sec > 0 ? `<div class="cal-dur ${dc}">${fmtDur(sec)}</div>` : ''}
        ${tray ? `<div class="cal-tray">T${tray}</div>` : ''}
      </div>`;
  }

  document.querySelector('.main').innerHTML = `
    <div class="page-title">Calendar</div>
    <div class="card">
      <div class="cal-header">
        <button class="cal-nav-btn" onclick="app.calPrev()">← Prev</button>
        <span class="cal-month-label">${monthName} ${year}</span>
        <button class="cal-nav-btn" onclick="app.calNext()">Next →</button>
      </div>
      <div class="cal-grid">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-day-name">${d}</div>`).join('')}
        ${cells}
      </div>
      <div class="cal-legend">
        <span><span style="color:var(--mint)">■</span> Under 2h</span>
        <span><span style="color:var(--amber)">■</span> 2h – 2h30m</span>
        <span><span style="color:var(--red)">■</span> Over 2h30m</span>
      </div>
    </div>`;
}

// ── Full render ──
function render() {
  document.getElementById('app').innerHTML = `
    <div class="layout">
      ${renderSidebar()}
      <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        ${renderMobileHeader()}
        <main class="main">
          ${state.view === 'dashboard' ? renderDashboard() : ''}
        </main>
      </div>
    </div>
    ${renderMobileNav()}`;

  if (state.view === 'dashboard') {
    updateStopwatchDisplay();
    renderStats();
    renderStopwatchButtons();
  } else if (state.view === 'log') {
    renderLog();
  } else if (state.view === 'graphs') {
    renderGraphs();
  } else if (state.view === 'calendar') {
    renderCalendar();
  }
}

// ── Public API ──
window.app = {
  start: startTimer,
  stop: stopTimer,
  reset: resetTimer,
  navigate(view) { state.view = view; render(); },
  filterLog() { renderLog(); },
  calPrev() { state.calMonth--; if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; } renderCalendar(); },
  calNext() { state.calMonth++; if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; } renderCalendar(); },
  async saveTrayNum() {
    const v = parseInt(document.getElementById('tray-input')?.value);
    if (v > 0) {
      await saveTray(v);
      const btn = document.querySelector('.tray-save-btn');
      if (btn) { btn.textContent = '✓ Saved'; setTimeout(() => btn.textContent = 'Save', 1500); }
    }
  },
  openTrayModal,
  closeTrayModal,
  saveTrayModal,
  askDelete(id, label) { showDeleteToast(id, label); },
  confirmDelete() { if (state.pendingDelete) deleteSession(state.pendingDelete); },
  hideToast,
};

// ── Boot ──
async function init() {
  try {
    await Promise.all([loadSessions(), loadTray()]);
    restoreTimer();
    render();
  } catch (e) {
    document.getElementById('app').innerHTML = `
      <div style="text-align:center;padding:60px;color:#E05C5C;">
        <p style="font-size:16px;">⚠ Could not connect to Supabase.</p>
        <p style="font-size:13px;color:#8896A5;margin-top:8px;">Check your config.js credentials.</p>
      </div>`;
    console.error(e);
  }
}

init();
