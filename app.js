import { SUPABASE_URL, SUPABASE_ANON_KEY, MAX_OUT_SECONDS } from './config.js';

// ── Supabase client ──
const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── App state ──
const state = {
  view: 'dashboard',
  running: false,
  startedAt: null,       // Date when current session started
  elapsed: 0,            // seconds accumulated in current session
  ticker: null,          // setInterval handle
  sessions: [],          // loaded from Supabase
  currentTray: 1,
  calMonth: new Date().getMonth(),
  calYear: new Date().getFullYear(),
  charts: {},
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
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function todayEST() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function nowEST() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isoDateEST(d = new Date()) {
  // Returns YYYY-MM-DD in EST
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
}

function todayTotalSeconds() {
  const today = isoDateEST();
  return state.sessions
    .filter(s => s.date_est === today)
    .reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
}

function statusColor(sec) {
  const ratio = sec / MAX_OUT_SECONDS;
  if (ratio >= 1) return 'var(--red)';
  if (ratio >= 0.8) return 'var(--amber)';
  return 'var(--mint)';
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

// ── Stopwatch logic ──
function startTimer() {
  if (state.running) return;
  state.running = true;
  state.startedAt = new Date();
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
}

function resetTimer() {
  if (state.running) return;
  state.elapsed = 0;
  updateStopwatchDisplay();
}

// ── Ring arc ──
function updateStopwatchDisplay() {
  const display = document.getElementById('sw-display');
  const sub = document.getElementById('sw-sub');
  const ring = document.getElementById('sw-ring');
  if (!display || !ring) return;

  const sec = state.elapsed;
  display.textContent = fmt(sec);

  // Today total including current session
  const todayTotal = todayTotalSeconds() + sec;
  const ratio = Math.min(todayTotal / MAX_OUT_SECONDS, 1);
  const circumference = 2 * Math.PI * 80;
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference * (1 - ratio)}`;
  ring.style.stroke = statusColor(todayTotal);

  if (sub) sub.textContent = `Today: ${fmtDur(todayTotal)} / 2h limit`;
  renderStats();
  renderAlert(todayTotal);
}

function renderAlert(todayTotal) {
  const el = document.getElementById('sw-alert');
  if (!el) return;
  const remaining = MAX_OUT_SECONDS - todayTotal;
  if (todayTotal >= MAX_OUT_SECONDS) {
    el.className = 'alert-bar danger';
    el.innerHTML = `⚠ You've exceeded your 2-hour limit today by ${fmtDur(todayTotal - MAX_OUT_SECONDS)}. Put your aligners back in!`;
    el.style.display = 'flex';
  } else if (remaining <= 900) {
    el.className = 'alert-bar warning';
    el.innerHTML = `⚡ Only ${fmtDur(remaining)} remaining today — ${fmtDur(todayTotal)} used.`;
    el.style.display = 'flex';
  } else if (state.running) {
    el.className = 'alert-bar success';
    el.innerHTML = `✓ Timer running — ${fmtDur(remaining)} remaining today.`;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}

function renderStats() {
  const todayTotal = todayTotalSeconds() + (state.running ? state.elapsed : 0);
  const remaining = Math.max(0, MAX_OUT_SECONDS - todayTotal);
  const sessions7 = state.sessions.filter(s => {
    const d = new Date(s.started_at);
    return (Date.now() - d.getTime()) < 7 * 86400000;
  });
  const avg7 = sessions7.length > 0
    ? sessions7.reduce((a, b) => a + b.duration_seconds, 0) / 7
    : 0;

  const todayEl = document.getElementById('stat-today');
  const remEl = document.getElementById('stat-remaining');
  const avgEl = document.getElementById('stat-avg');
  if (todayEl) todayEl.textContent = fmtDur(todayTotal);
  if (remEl) {
    remEl.textContent = remaining > 0 ? fmtDur(remaining) : 'OVER';
    remEl.className = 'stat-value ' + (remaining <= 0 ? 'red' : remaining <= 1800 ? 'amber' : 'mint');
  }
  if (avgEl) avgEl.textContent = fmtDur(Math.round(avg7));
}

function renderStopwatchButtons() {
  const btn = document.getElementById('sw-main-btn');
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
  if (resetBtn) resetBtn.disabled = state.running || state.elapsed === 0;
}

// ── Views ──
function renderNav() {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: '⊞' },
    { id: 'log', label: 'Session Log', icon: '☰' },
    { id: 'graphs', label: 'Graphs', icon: '⌇' },
    { id: 'calendar', label: 'Calendar', icon: '▦' },
  ];
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
      ${renderNav()}
      <div class="tray-badge">
        <label>Current Tray</label>
        <div class="tray-input-wrap">
          <input class="tray-input" type="number" id="tray-input" min="1" max="99" value="${state.currentTray}" />
          <button class="tray-save-btn" onclick="app.saveTrayNum()">Save</button>
        </div>
      </div>
    </aside>
  `;
}

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
              style="stroke:${statusColor(todayTotal)}"
            />
          </svg>
          <div class="stopwatch-display" id="sw-display">${fmt(state.elapsed)}</div>
          <div class="stopwatch-sub" id="sw-sub">Today: ${fmtDur(todayTotal)} / 2h limit</div>
        </div>

        <p class="stopwatch-status">
          Tray <span>#${state.currentTray}</span> &nbsp;·&nbsp;
          ${state.running ? `<span>Running since ${nowEST()}</span>` : 'Ready'}
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

      <div class="card stats-row" style="display:grid; grid-template-columns: repeat(3,1fr); gap:0; padding: 20px 0;">
        <div class="stat-card">
          <div class="stat-label">Today out</div>
          <div class="stat-value mint" id="stat-today">${fmtDur(todayTotal)}</div>
        </div>
        <div class="stat-card" style="border-left: 1px solid var(--border); border-right: 1px solid var(--border);">
          <div class="stat-label">Remaining</div>
          <div class="stat-value ${Math.max(0,MAX_OUT_SECONDS-todayTotal) <= 0 ? 'red' : Math.max(0,MAX_OUT_SECONDS-todayTotal) <= 1800 ? 'amber' : 'mint'}" id="stat-remaining">${fmtDur(Math.max(0,MAX_OUT_SECONDS-todayTotal))}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">7-day avg</div>
          <div class="stat-value" id="stat-avg">—</div>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Recent Sessions</div>
        ${renderRecentSessions()}
      </div>
    </div>
  `;
}

function renderRecentSessions() {
  const recent = state.sessions.slice(0, 5);
  if (!recent.length) return `<p class="empty-state">No sessions yet. Start the timer!</p>`;
  return recent.map(s => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px 0; border-bottom: 1px solid var(--border);">
      <div>
        <span style="font-size:13px; color:var(--text);">${s.date_est}</span>
        <span style="font-size:12px; color:var(--text-3); margin-left:8px;">${s.time_est || ''}</span>
      </div>
      <div style="display:flex; gap:12px; align-items:center;">
        <span class="log-table tray-pill">Tray ${s.tray_number}</span>
        <span style="font-family:'DM Mono',monospace; font-size:14px; color:var(--mint);">${fmtDur(s.duration_seconds)}</span>
      </div>
    </div>
  `).join('');
}

function renderLog() {
  const filterEl = document.getElementById('log-filter');
  const filterVal = filterEl ? filterEl.value.toLowerCase() : '';
  let sessions = [...state.sessions];
  if (filterVal) {
    sessions = sessions.filter(s =>
      s.date_est?.includes(filterVal) ||
      String(s.tray_number)?.includes(filterVal)
    );
  }

  document.querySelector('.main').innerHTML = `
    <div class="page-title">Session Log</div>
    <div class="log-filters">
      <input class="filter-input" placeholder="Filter by date or tray..." id="log-filter"
        value="${filterVal}" oninput="app.filterLog()" style="width:220px" />
      <span style="font-size:12px; color:var(--text-3);">${sessions.length} sessions</span>
    </div>
    <div class="card" style="padding:0; overflow:hidden;">
      ${sessions.length === 0 ? `<p class="empty-state">No sessions found.</p>` : `
      <table class="log-table">
        <thead>
          <tr>
            <th>Date (EST)</th>
            <th>Start Time</th>
            <th>Duration</th>
            <th>Tray</th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map(s => `
            <tr>
              <td class="mono">${s.date_est || '—'}</td>
              <td>${s.time_est || '—'}</td>
              <td class="mono" style="color:${s.duration_seconds > MAX_OUT_SECONDS ? 'var(--red)' : 'var(--mint)'}">${fmtDur(s.duration_seconds)}</td>
              <td><span class="tray-pill">Tray ${s.tray_number}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`}
    </div>
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
        <div class="section-title">Sessions per day of week</div>
        <div class="chart-canvas-wrap"><canvas id="chart-dow"></canvas></div>
      </div>
      <div class="card">
        <div class="section-title">Out-time distribution</div>
        <div class="chart-canvas-wrap"><canvas id="chart-dist"></canvas></div>
      </div>
    </div>
  `;
  drawCharts();
}

function drawCharts() {
  // ── Daily out-time (last 30 days) ──
  const last30 = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last30[isoDateEST(d)] = 0;
  }
  state.sessions.forEach(s => {
    if (last30.hasOwnProperty(s.date_est)) {
      last30[s.date_est] += s.duration_seconds / 60; // minutes
    }
  });
  const labels30 = Object.keys(last30).map(d => {
    const [y, m, day] = d.split('-');
    return `${parseInt(m)}/${parseInt(day)}`;
  });
  const data30 = Object.values(last30);

  if (state.charts.daily) state.charts.daily.destroy();
  state.charts.daily = new Chart(document.getElementById('chart-daily'), {
    type: 'bar',
    data: {
      labels: labels30,
      datasets: [{
        data: data30,
        backgroundColor: data30.map(v => v > 120 ? 'rgba(224,92,92,0.7)' : v > 96 ? 'rgba(245,166,35,0.7)' : 'rgba(0,201,167,0.7)'),
        borderRadius: 4,
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8896A5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#8896A5', callback: v => `${v}m` }, grid: { color: 'rgba(255,255,255,0.06)' } }
      },
      responsive: true, maintainAspectRatio: false,
    }
  });

  // ── Sessions per day of week ──
  const dow = Array(7).fill(0);
  state.sessions.forEach(s => {
    const d = new Date(s.started_at);
    dow[d.getDay()] += s.duration_seconds / 60;
  });
  const dowLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  if (state.charts.dow) state.charts.dow.destroy();
  state.charts.dow = new Chart(document.getElementById('chart-dow'), {
    type: 'bar',
    data: {
      labels: dowLabels,
      datasets: [{ data: dow, backgroundColor: 'rgba(0,201,167,0.6)', borderRadius: 4 }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8896A5', font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#8896A5', callback: v => `${Math.round(v)}m` }, grid: { color: 'rgba(255,255,255,0.06)' } }
      },
      responsive: true, maintainAspectRatio: false,
    }
  });

  // ── Duration distribution ──
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
      datasets: [{
        data: Object.values(buckets),
        backgroundColor: ['rgba(0,201,167,0.8)','rgba(0,201,167,0.55)','rgba(245,166,35,0.7)','rgba(245,166,35,0.9)','rgba(224,92,92,0.8)'],
        borderWidth: 0,
      }]
    },
    options: {
      plugins: { legend: { labels: { color: '#8896A5', font: { size: 11 } } } },
      responsive: true, maintainAspectRatio: false,
      cutout: '60%',
    }
  });
}

function renderCalendar() {
  const year = state.calYear;
  const month = state.calMonth;
  const monthName = new Date(year, month, 1).toLocaleString('default', { month: 'long' });

  // Build daily totals
  const dailyTotals = {};
  const dailyTrays = {};
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

  let cells = '';
  for (let i = 0; i < firstDay; i++) {
    cells += `<div class="cal-cell empty"></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = dateStr === todayStr;
    const sec = dailyTotals[dateStr] || 0;
    const durClass = sec === 0 ? '' : sec > MAX_OUT_SECONDS ? 'danger' : sec > MAX_OUT_SECONDS * 0.8 ? 'warning' : 'good';
    const tray = dailyTrays[dateStr];

    cells += `
      <div class="cal-cell ${isToday ? 'today' : ''}">
        <div class="cal-date">${d}</div>
        ${sec > 0 ? `<div class="cal-dur ${durClass}">${fmtDur(sec)}</div>` : ''}
        ${tray ? `<div class="cal-tray">T${tray}</div>` : ''}
      </div>
    `;
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
      <div style="display:flex; gap:16px; margin-top:16px; font-size:12px; color:var(--text-3);">
        <span><span style="color:var(--mint)">■</span> Under limit</span>
        <span><span style="color:var(--amber)">■</span> Near limit</span>
        <span><span style="color:var(--red)">■</span> Over limit</span>
      </div>
    </div>
  `;
}

// ── Render ──
function render() {
  const app = document.getElementById('app');
  const mainContent = state.view === 'dashboard' ? renderDashboard()
    : state.view === 'log' ? getLogHTML()
    : state.view === 'graphs' ? getGraphsHTML()
    : getCalendarHTML();

  app.innerHTML = `
    <div class="layout">
      ${renderSidebar()}
      <main class="main">${mainContent}</main>
    </div>
  `;

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

function getLogHTML() { return `<div class="page-title">Session Log</div><div id="log-content"></div>`; }
function getGraphsHTML() { return `<div class="page-title">Graphs</div>`; }
function getCalendarHTML() { return `<div class="page-title">Calendar</div>`; }

// ── Public API (used in onclick) ──
window.app = {
  start: startTimer,
  stop: stopTimer,
  reset: resetTimer,
  navigate(view) {
    state.view = view;
    render();
  },
  filterLog() { renderLog(); },
  calPrev() {
    state.calMonth--;
    if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
    renderCalendar();
  },
  calNext() {
    state.calMonth++;
    if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
    renderCalendar();
  },
  async saveTrayNum() {
    const v = parseInt(document.getElementById('tray-input')?.value);
    if (v > 0) {
      await saveTray(v);
      const badge = document.querySelector('.sidebar-logo p');
      if (badge) badge.textContent = `Tray ${v} · 22hr tracker`;
      const btn = document.querySelector('.tray-save-btn');
      if (btn) { btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Save', 1200); }
    }
  },
};

// ── Boot ──
async function init() {
  try {
    await Promise.all([loadSessions(), loadTray()]);
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
