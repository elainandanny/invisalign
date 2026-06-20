import { SUPABASE_URL, SUPABASE_ANON_KEY, MAX_OUT_SECONDS } from './config.js';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WARN_SECONDS = MAX_OUT_SECONDS + 30 * 60; // 2h30m = red zone

// ── State ──
const state = {
  view: 'dashboard',
  running: false,
  startedAt: null,
  elapsed: 0,
  lastElapsed: 0,      // ← FIX: holds elapsed after stop so reset can use it
  canReset: false,     // ← FIX: explicit flag for reset availability
  ticker: null,
  sessions: [],
  currentTray: 1,
  draftTray: 1,        // for drum scroll UI
  calMonth: new Date().getMonth(),
  calYear:  new Date().getFullYear(),
  charts: {},
  pendingDelete: null,
};

// ── Helpers ──
function fmt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
function isoDateEST(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
}
function todayTotalSeconds() {
  const today = isoDateEST();
  return state.sessions.filter(s => s.date_est === today).reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
}
function statusColor(sec) {
  if (sec >= WARN_SECONDS)     return 'var(--coral)';
  if (sec >= MAX_OUT_SECONDS)  return 'var(--yellow)';
  return 'var(--lime)';
}
function durClass(sec) {
  if (sec >= WARN_SECONDS)    return 'danger';
  if (sec >= MAX_OUT_SECONDS) return 'warning';
  return 'good';
}
function statColorClass(sec) {
  if (sec >= WARN_SECONDS)    return 'coral';
  if (sec >= MAX_OUT_SECONDS) return 'yellow';
  return 'cyan';
}

// ── Timer persistence ──
function persistTimer() {
  if (state.running && state.startedAt) {
    localStorage.setItem('sw_startedAt', state.startedAt.toISOString());
  } else {
    localStorage.removeItem('sw_startedAt');
  }
}
function restoreTimer() {
  const saved = localStorage.getItem('sw_startedAt');
  if (!saved) return;
  const startedAt = new Date(saved);
  if (Date.now() - startedAt.getTime() > 4 * 3600 * 1000) { localStorage.removeItem('sw_startedAt'); return; }
  state.running   = true;
  state.startedAt = startedAt;
  state.elapsed   = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  state.canReset  = false;
  state.ticker = setInterval(() => {
    state.elapsed = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
    updateStopwatchDisplay();
  }, 1000);
}

// ── Supabase ──
async function loadSessions() {
  const { data, error } = await db.from('sessions').select('*').order('started_at', { ascending: false });
  if (!error) state.sessions = data || [];
}
async function loadTray() {
  const { data } = await db.from('settings').select('value').eq('key', 'current_tray').single();
  if (data) { state.currentTray = parseInt(data.value) || 1; state.draftTray = state.currentTray; }
}
async function saveTray(tray) {
  await db.from('settings').upsert({ key: 'current_tray', value: String(tray) });
  state.currentTray = tray; state.draftTray = tray;
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
  if (state.view === 'dashboard') { document.getElementById('recent-sessions').innerHTML = renderRecentSessions(); updateStopwatchDisplay(); }
  if (state.view === 'graphs')   renderGraphs();
  if (state.view === 'calendar') renderCalendar();
}

// ── Stopwatch ──
function startTimer() {
  if (state.running) return;
  state.running   = true;
  state.startedAt = new Date();
  state.elapsed   = 0;
  state.canReset  = false;
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
  const duration  = state.elapsed;
  const startedAt = state.startedAt;
  // ── FIX: save elapsed BEFORE zeroing, enable reset ──
  state.lastElapsed = duration;
  state.canReset    = true;
  state.elapsed     = 0;
  state.startedAt   = null;
  persistTimer();

  const session = {
    started_at:       startedAt.toISOString(),
    ended_at:         new Date().toISOString(),
    duration_seconds: duration,
    date_est:         isoDateEST(startedAt),
    time_est:         startedAt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true }),
    tray_number:      state.currentTray,
  };
  await saveSession(session);
  updateStopwatchDisplay();
  renderStopwatchButtons();
  renderStats();
  if (state.view === 'log')      renderLog();
  if (state.view === 'graphs')   renderGraphs();
  if (state.view === 'calendar') renderCalendar();
  if (state.view === 'dashboard') document.getElementById('recent-sessions').innerHTML = renderRecentSessions();
}

function resetTimer() {
  if (state.running) return;
  // Show lastElapsed briefly, then zero
  if (state.canReset) {
    state.elapsed  = state.lastElapsed;
    updateStopwatchDisplay();
    setTimeout(() => {
      state.elapsed  = 0;
      state.lastElapsed = 0;
      state.canReset = false;
      updateStopwatchDisplay();
      renderStopwatchButtons();
    }, 800);
  }
}

// ── Ring display ──
function updateStopwatchDisplay() {
  const display = document.getElementById('sw-display');
  const sub     = document.getElementById('sw-sub');
  const ring    = document.getElementById('sw-ring');
  if (!display || !ring) return;

  const sec = state.elapsed;
  display.textContent = fmt(sec);

  const todayTotal   = todayTotalSeconds() + sec;
  const ratio        = Math.min(todayTotal / MAX_OUT_SECONDS, 1);
  const circumference = 2 * Math.PI * 80;
  ring.style.strokeDasharray  = `${circumference}`;
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
  if (todayTotal >= WARN_SECONDS) {
    el.className = 'alert-bar danger';
    el.innerHTML = `🚨 <strong>${fmtDur(todayTotal - MAX_OUT_SECONDS)} over limit</strong> — aligners back in now!`;
    el.style.display = 'flex';
  } else if (todayTotal >= MAX_OUT_SECONDS) {
    el.className = 'alert-bar warning';
    el.innerHTML = `⚠️ 2h limit reached — ${fmtDur(todayTotal - MAX_OUT_SECONDS)} over. Red zone in ${fmtDur(WARN_SECONDS - todayTotal)}.`;
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
  const remaining  = Math.max(0, MAX_OUT_SECONDS - todayTotal);
  const sessions7  = state.sessions.filter(s => (Date.now() - new Date(s.started_at).getTime()) < 7 * 86400000);
  const avg7 = sessions7.length > 0 ? sessions7.reduce((a, b) => a + b.duration_seconds, 0) / 7 : 0;

  const todayEl = document.getElementById('stat-today');
  const remEl   = document.getElementById('stat-remaining');
  const avgEl   = document.getElementById('stat-avg');
  if (todayEl) { todayEl.textContent = fmtDur(todayTotal); todayEl.className = `stat-value ${statColorClass(todayTotal)}`; }
  if (remEl) { remEl.textContent = remaining > 0 ? fmtDur(remaining) : 'OVER'; remEl.className = `stat-value ${remaining <= 0 ? 'coral' : remaining <= 1800 ? 'yellow' : 'cyan'}`; }
  if (avgEl) avgEl.textContent = fmtDur(Math.round(avg7));
}

function renderStopwatchButtons() {
  const startBtn = document.getElementById('sw-start-btn');
  const resetBtn = document.getElementById('sw-reset-btn');
  if (!startBtn) return;
  if (state.running) {
    startBtn.textContent = '⏹ Stop & Log';
    startBtn.className   = 'sw-btn sw-btn-stop';
    startBtn.onclick     = stopTimer;
  } else {
    startBtn.textContent = '▶ Start';
    startBtn.className   = 'sw-btn sw-btn-start';
    startBtn.onclick     = startTimer;
  }
  if (resetBtn) resetBtn.disabled = state.running || !state.canReset;
}

// ── Toast ──
function showDeleteToast(id, label) {
  hideToast();
  state.pendingDelete = id;
  const t = document.createElement('div');
  t.className = 'toast'; t.id = 'delete-toast';
  t.innerHTML = `<span>Delete session on ${label}?</span><button class="toast-confirm" onclick="app.confirmDelete()">Delete</button><button class="toast-cancel" onclick="app.hideToast()">Cancel</button>`;
  document.body.appendChild(t);
  setTimeout(() => { if (document.getElementById('delete-toast')) hideToast(); }, 6000);
}
function hideToast() { document.getElementById('delete-toast')?.remove(); state.pendingDelete = null; }

// ── Tray drum ──
function renderTrayDrum(id = 'tray-drum') {
  return `
    <div class="tray-drum" id="${id}">
      <button class="tray-drum-btn" onclick="app.drumDown('${id}')">−</button>
      <div class="tray-drum-val" id="${id}-val">${state.draftTray}</div>
      <button class="tray-drum-btn" onclick="app.drumUp('${id}')">+</button>
    </div>`;
}
function drumUp(id) {
  state.draftTray = Math.min(99, state.draftTray + 1);
  const el = document.getElementById(`${id}-val`);
  if (el) { el.textContent = state.draftTray; el.style.transform = 'translateY(-4px)'; setTimeout(() => el.style.transform = '', 120); }
}
function drumDown(id) {
  state.draftTray = Math.max(1, state.draftTray - 1);
  const el = document.getElementById(`${id}-val`);
  if (el) { el.textContent = state.draftTray; el.style.transform = 'translateY(4px)'; setTimeout(() => el.style.transform = '', 120); }
}

// ── Sidebar ──
function renderSidebar() {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: '⊞' },
    { id: 'log',       label: 'Log',       icon: '☰' },
    { id: 'graphs',    label: 'Graphs',    icon: '⌇' },
    { id: 'calendar',  label: 'Calendar',  icon: '▦' },
  ];
  return `
    <aside class="sidebar">
      <div class="sidebar-logo"><h1>Invisalign</h1><p>22hr wear tracker</p></div>
      ${items.map(i => `<div class="nav-item ${state.view === i.id ? 'active' : ''}" onclick="app.navigate('${i.id}')"><span class="nav-icon">${i.icon}</span>${i.label}</div>`).join('')}
      <div class="tray-badge">
        <label>Current Tray</label>
        ${renderTrayDrum('sidebar-drum')}
        <button class="tray-save-btn" onclick="app.saveTrayFromDrum('sidebar-drum')">Save tray</button>
      </div>
    </aside>`;
}

function renderMobileHeader() {
  return `
    <header class="mobile-header">
      <span class="mobile-header-title">Invisalign</span>
      <button class="mobile-tray-btn" onclick="app.openTrayModal()">Tray <span>#${state.currentTray}</span></button>
    </header>`;
}
function renderMobileNav() {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: '⊞' },
    { id: 'log',       label: 'Log',       icon: '☰' },
    { id: 'graphs',    label: 'Graphs',    icon: '⌇' },
    { id: 'calendar',  label: 'Calendar',  icon: '▦' },
  ];
  return `<nav class="mobile-nav"><div class="mobile-nav-inner">${items.map(i => `<div class="mobile-nav-item ${state.view === i.id ? 'active' : ''}" onclick="app.navigate('${i.id}')"><span class="mob-icon">${i.icon}</span><span>${i.label}</span></div>`).join('')}</div></nav>`;
}

// ── Tray modal (mobile) ──
function openTrayModal() {
  state.draftTray = state.currentTray;
  const overlay = document.createElement('div');
  overlay.className = 'tray-modal-overlay'; overlay.id = 'tray-modal';
  overlay.innerHTML = `
    <div class="tray-modal">
      <h3>Current Tray</h3>
      ${renderTrayDrum('modal-drum')}
      <div class="tray-modal-row">
        <button class="tray-modal-save" onclick="app.saveTrayFromDrum('modal-drum')">Save</button>
        <button class="tray-modal-cancel" onclick="app.closeTrayModal()">Cancel</button>
      </div>
    </div>`;
  overlay.onclick = e => { if (e.target === overlay) app.closeTrayModal(); };
  document.body.appendChild(overlay);
}
function closeTrayModal() { document.getElementById('tray-modal')?.remove(); }
async function saveTrayFromDrum(drumId) {
  const v = state.draftTray;
  if (v > 0) {
    await saveTray(v);
    closeTrayModal();
    // Update all tray displays
    document.querySelectorAll('.mobile-tray-btn span').forEach(el => el.textContent = `#${v}`);
    document.querySelectorAll('.sw-tray-label').forEach(el => el.textContent = `#${v}`);
  }
}

// ── Dashboard ──
function renderDashboard() {
  const circumference = 2 * Math.PI * 80;
  const todayTotal    = todayTotalSeconds() + (state.running ? state.elapsed : 0);
  const ratio         = Math.min(todayTotal / MAX_OUT_SECONDS, 1);
  const remaining     = Math.max(0, MAX_OUT_SECONDS - todayTotal);
  const sessions7     = state.sessions.filter(s => (Date.now() - new Date(s.started_at).getTime()) < 7 * 86400000);
  const avg7          = sessions7.length > 0 ? Math.round(sessions7.reduce((a, b) => a + b.duration_seconds, 0) / 7) : 0;

  return `
    <div class="page-title">Dashboard</div>
    <div id="sw-alert" class="alert-bar" style="display:none"></div>
    <div class="dashboard-grid">
      <div class="card stopwatch-card">
        <div class="ring-container">
          <svg class="ring-svg" width="200" height="200" viewBox="0 0 200 200">
            <circle class="ring-bg" cx="100" cy="100" r="80"/>
            <circle class="ring-track" id="sw-ring" cx="100" cy="100" r="80"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${circumference * (1 - ratio)}"
              style="stroke:${statusColor(todayTotal)}"/>
          </svg>
          <div class="stopwatch-display" id="sw-display">${fmt(state.elapsed)}</div>
          <div class="stopwatch-sub" id="sw-sub">Today: ${fmtDur(todayTotal)} out</div>
        </div>
        <p class="stopwatch-status">
          Tray <span class="sw-tray-label">#${state.currentTray}</span>
          &nbsp;·&nbsp;
          ${state.running
            ? `<span class="sw-running-label">Running since ${state.startedAt?.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true, hour: '2-digit', minute: '2-digit' })}</span>`
            : '<span style="color:var(--text-3)">Stopped</span>'}
        </p>
        <div class="sw-btn-row">
          <button class="${state.running ? 'sw-btn sw-btn-stop' : 'sw-btn sw-btn-start'}" id="sw-start-btn"
            onclick="${state.running ? 'app.stop()' : 'app.start()'}">
            ${state.running ? '⏹ Stop & Log' : '▶ Start'}
          </button>
          <button class="sw-btn sw-btn-reset" id="sw-reset-btn"
            onclick="app.reset()" ${(state.running || !state.canReset) ? 'disabled' : ''}>
            Reset
          </button>
        </div>
      </div>

      <div class="card" style="padding:20px 0; grid-column: 1 / -1;">
        <div style="display:grid; grid-template-columns: repeat(3,1fr);">
          <div class="stat-card">
            <div class="stat-label">Today out</div>
            <div class="stat-value ${statColorClass(todayTotal)}" id="stat-today">${fmtDur(todayTotal)}</div>
          </div>
          <div class="stat-card" style="border-left:1px solid var(--border);border-right:1px solid var(--border);">
            <div class="stat-label">Remaining</div>
            <div class="stat-value ${remaining <= 0 ? 'coral' : remaining <= 1800 ? 'yellow' : 'cyan'}" id="stat-remaining">${remaining > 0 ? fmtDur(remaining) : 'OVER'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">7-day avg</div>
            <div class="stat-value violet" id="stat-avg">${avg7 > 0 ? fmtDur(avg7) : '—'}</div>
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
  if (!recent.length) return `<p class="empty-state">No sessions yet. Hit Start!</p>`;
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
    </div>`).join('');
}

// ── Log ──
function renderLog() {
  const filterEl  = document.getElementById('log-filter');
  const filterVal = filterEl ? filterEl.value.toLowerCase() : '';
  let sessions = [...state.sessions];
  if (filterVal) sessions = sessions.filter(s => s.date_est?.includes(filterVal) || String(s.tray_number)?.includes(filterVal));

  const tableRows = sessions.map(s => `
    <tr>
      <td class="mono">${s.date_est || '—'}</td>
      <td>${s.time_est || '—'}</td>
      <td class="mono" style="color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</td>
      <td><span class="tray-pill">T${s.tray_number}</span></td>
      <td><button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')">✕</button></td>
    </tr>`).join('');

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
          <button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')">✕</button>
        </div>
      </div>
    </div>`).join('');

  document.querySelector('.main').innerHTML = `
    <div class="page-title">Session Log</div>
    <div class="log-filters">
      <input class="filter-input" placeholder="Filter by date or tray…" id="log-filter" value="${filterVal}" oninput="app.filterLog()" />
      <span style="font-size:12px;color:var(--text-3);white-space:nowrap;">${sessions.length} sessions</span>
    </div>
    ${sessions.length === 0
      ? `<div class="card"><p class="empty-state">No sessions found.</p></div>`
      : `<div class="log-table-wrap card" style="padding:0;overflow:hidden;">
           <table class="log-table"><thead><tr><th>Date</th><th>Start Time</th><th>Duration</th><th>Tray</th><th></th></tr></thead>
           <tbody>${tableRows}</tbody></table></div>
         <div class="log-cards">${mobileCards}</div>`}`;
}

// ── Graphs ──
function renderGraphs() {
  document.querySelector('.main').innerHTML = `
    <div class="page-title">Graphs</div>
    <div class="charts-grid">
      <div class="card chart-full"><div class="section-title">Daily out-time — last 30 days</div><div class="chart-canvas-wrap"><canvas id="chart-daily"></canvas></div></div>
      <div class="card"><div class="section-title">By day of week</div><div class="chart-canvas-wrap"><canvas id="chart-dow"></canvas></div></div>
      <div class="card"><div class="section-title">Session duration mix</div><div class="chart-canvas-wrap"><canvas id="chart-dist"></canvas></div></div>
    </div>`;
  drawCharts();
}

function drawCharts() {
  const last30 = {};
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); last30[isoDateEST(d)] = 0; }
  state.sessions.forEach(s => { if (last30.hasOwnProperty(s.date_est)) last30[s.date_est] += s.duration_seconds / 60; });
  const labels30 = Object.keys(last30).map(d => { const [,m,day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}`; });
  const data30   = Object.values(last30);
  const barColor = v => v > WARN_SECONDS/60 ? 'rgba(255,107,107,0.8)' : v > MAX_OUT_SECONDS/60 ? 'rgba(255,217,61,0.8)' : 'rgba(184,255,87,0.75)';

  if (state.charts.daily) state.charts.daily.destroy();
  state.charts.daily = new Chart(document.getElementById('chart-daily'), {
    type: 'bar',
    data: { labels: labels30, datasets: [{ data: data30, backgroundColor: data30.map(barColor), borderRadius: 4 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${Math.round(ctx.raw)}m` } } },
      scales: { x: { ticks: { color: '#8890B0', font: { size: 10 }, maxRotation: 0 }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: { ticks: { color: '#8890B0', callback: v => `${v}m` }, grid: { color: 'rgba(255,255,255,0.06)' } } },
      responsive: true, maintainAspectRatio: false }
  });

  const dow = Array(7).fill(0);
  state.sessions.forEach(s => { dow[new Date(s.started_at).getDay()] += s.duration_seconds / 60; });
  if (state.charts.dow) state.charts.dow.destroy();
  state.charts.dow = new Chart(document.getElementById('chart-dow'), {
    type: 'bar',
    data: { labels: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], datasets: [{ data: dow, backgroundColor: 'rgba(0,229,255,0.65)', borderRadius: 4 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${Math.round(ctx.raw)}m` } } },
      scales: { x: { ticks: { color: '#8890B0', font: { size: 11 } }, grid: { display: false } },
                y: { ticks: { color: '#8890B0', callback: v => `${Math.round(v)}m` }, grid: { color: 'rgba(255,255,255,0.06)' } } },
      responsive: true, maintainAspectRatio: false }
  });

  const buckets = { '<15m': 0, '15–30m': 0, '30–60m': 0, '60–90m': 0, '>90m': 0 };
  state.sessions.forEach(s => {
    const m = s.duration_seconds / 60;
    if (m < 15) buckets['<15m']++; else if (m < 30) buckets['15–30m']++; else if (m < 60) buckets['30–60m']++; else if (m < 90) buckets['60–90m']++; else buckets['>90m']++;
  });
  if (state.charts.dist) state.charts.dist.destroy();
  state.charts.dist = new Chart(document.getElementById('chart-dist'), {
    type: 'doughnut',
    data: { labels: Object.keys(buckets), datasets: [{ data: Object.values(buckets), backgroundColor: ['rgba(184,255,87,0.85)','rgba(0,229,255,0.75)','rgba(191,95,255,0.75)','rgba(255,217,61,0.8)','rgba(255,107,107,0.85)'], borderWidth: 0 }] },
    options: { plugins: { legend: { labels: { color: '#8890B0', font: { size: 11 } } } }, responsive: true, maintainAspectRatio: false, cutout: '60%' }
  });
}

// ── Calendar ──
function renderCalendar() {
  const year = state.calYear, month = state.calMonth;
  const monthName = new Date(year, month, 1).toLocaleString('default', { month: 'long' });
  const dailyTotals = {}, dailyTrays = {};
  state.sessions.forEach(s => {
    if (!s.date_est) return;
    const [y, m] = s.date_est.split('-').map(Number);
    if (y === year && m - 1 === month) { dailyTotals[s.date_est] = (dailyTotals[s.date_est] || 0) + s.duration_seconds; dailyTrays[s.date_est] = s.tray_number; }
  });

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr    = isoDateEST();

  let cells = Array(firstDay).fill('<div class="cal-cell empty"></div>').join('');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const sec  = dailyTotals[dateStr] || 0;
    const dc   = sec === 0 ? '' : durClass(sec);
    const tray = dailyTrays[dateStr];
    cells += `<div class="cal-cell ${dateStr === todayStr ? 'today' : ''}">
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
        <span><span style="color:var(--lime)">■</span> Under 2h</span>
        <span><span style="color:var(--yellow)">■</span> 2h – 2h30m</span>
        <span><span style="color:var(--coral)">■</span> Over 2h30m</span>
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
        <main class="main">${state.view === 'dashboard' ? renderDashboard() : ''}</main>
      </div>
    </div>
    ${renderMobileNav()}`;

  if      (state.view === 'dashboard') { updateStopwatchDisplay(); renderStats(); renderStopwatchButtons(); }
  else if (state.view === 'log')       renderLog();
  else if (state.view === 'graphs')    renderGraphs();
  else if (state.view === 'calendar')  renderCalendar();
}

// ── Public API ──
window.app = {
  start: startTimer, stop: stopTimer, reset: resetTimer,
  navigate(view) { state.view = view; render(); },
  filterLog() { renderLog(); },
  calPrev() { state.calMonth--; if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; } renderCalendar(); },
  calNext() { state.calMonth++; if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; } renderCalendar(); },
  drumUp, drumDown,
  saveTrayFromDrum,
  openTrayModal, closeTrayModal,
  askDelete: showDeleteToast,
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
    document.getElementById('app').innerHTML = `<div style="text-align:center;padding:60px;color:var(--coral);"><p>⚠ Could not connect to Supabase.</p><p style="font-size:13px;color:var(--text-3);margin-top:8px;">Check config.js credentials.</p></div>`;
    console.error(e);
  }
}
init();
