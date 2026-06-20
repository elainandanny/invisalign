import { SUPABASE_URL, SUPABASE_ANON_KEY, MAX_OUT_SECONDS } from './config.js';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WARN_SECONDS = MAX_OUT_SECONDS + 30 * 60; // 2h30m

// ── State ──
const state = {
  view: 'dashboard',
  running: false,
  startedAt: null,
  elapsed: 0,
  lastElapsed: 0,
  canReset: false,
  activeMealTag: null,
  ticker: null,
  sessions: [],
  notes: {},        // date_est → note text
  traySchedule: {}, // tray_number → {start_date, days_to_wear}
  currentTray: 1,
  draftTray: 1,
  calMonth: new Date().getMonth(),
  calYear: new Date().getFullYear(),
  charts: {},
  pendingDelete: null,
};

// ── Helpers ──
const fmt = sec => [Math.floor(sec/3600), Math.floor((sec%3600)/60), sec%60].map(n=>String(n).padStart(2,'0')).join(':');
function fmtDur(sec) {
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  if (h>0&&m>0) return `${h}h ${m}m`; if (h>0) return `${h}h`; return `${m}m`;
}
const isoDateEST = (d=new Date()) => d.toLocaleDateString('sv-SE',{timeZone:'America/New_York'});
const todayTotalSec = () => state.sessions.filter(s=>s.date_est===isoDateEST()).reduce((sum,s)=>sum+(s.duration_seconds||0),0);

function statusColor(sec) {
  if (sec>=WARN_SECONDS) return 'var(--peach)';
  if (sec>=MAX_OUT_SECONDS) return 'var(--butter)';
  return 'var(--sage)';
}
function durClass(sec) {
  if (sec>=WARN_SECONDS) return 'danger';
  if (sec>=MAX_OUT_SECONDS) return 'warning';
  return 'good';
}
function statColor(sec) {
  if (sec>=WARN_SECONDS) return 'c-peach';
  if (sec>=MAX_OUT_SECONDS) return 'c-butter';
  return 'c-sage';
}
function remColor(rem) {
  if (rem<=0) return 'c-peach';
  if (rem<=1800) return 'c-butter';
  return 'c-sky';
}

// Compliance: % of days where total out < MAX_OUT_SECONDS
function calcCompliance(days=30) {
  const counts = {}; // date → total seconds
  state.sessions.forEach(s=>{
    if (!s.date_est) return;
    counts[s.date_est] = (counts[s.date_est]||0) + s.duration_seconds;
  });
  // only consider days that have at least one session in window
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-days);
  const relevant = Object.entries(counts).filter(([d])=>new Date(d)>=cutoff);
  if (!relevant.length) return null;
  const compliant = relevant.filter(([,sec])=>sec<MAX_OUT_SECONDS).length;
  return Math.round((compliant/relevant.length)*100);
}

function calcStreak() {
  const counts = {};
  state.sessions.forEach(s=>{ if(s.date_est) counts[s.date_est]=(counts[s.date_est]||0)+s.duration_seconds; });
  let streak=0, best=0, cur=0;
  const today = isoDateEST();
  const d = new Date(); 
  for (let i=0;i<365;i++) {
    const ds = isoDateEST(d);
    const total = counts[ds]||0;
    if (total>0 && total<MAX_OUT_SECONDS) { cur++; best=Math.max(best,cur); }
    else if (ds!==today) { cur=0; }
    d.setDate(d.getDate()-1);
  }
  // current streak: walk back from today
  streak=0; const d2=new Date();
  for (let i=0;i<365;i++) {
    const ds=isoDateEST(d2); const total=counts[ds]||0;
    if (total>0&&total<MAX_OUT_SECONDS) streak++;
    else if (i>0) break;
    d2.setDate(d2.getDate()-1);
  }
  return {streak, best};
}

function calcDayOfWeek() {
  const dow = Array(7).fill(0).map(()=>({total:0,days:0}));
  const byDate = {};
  state.sessions.forEach(s=>{
    if(!s.date_est) return;
    byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;
  });
  Object.entries(byDate).forEach(([d,sec])=>{
    const day=new Date(d+'T12:00:00').getDay();
    dow[day].total+=sec; dow[day].days++;
  });
  const avgs=dow.map((d,i)=>({day:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i], avg:d.days?Math.round(d.total/d.days):0}));
  const active=avgs.filter(a=>a.avg>0);
  if (!active.length) return {best:null,worst:null};
  const best=active.reduce((a,b)=>a.avg<b.avg?a:b);
  const worst=active.reduce((a,b)=>a.avg>b.avg?a:b);
  return {best,worst};
}

function weekGrade() {
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-7);
  const byDate={};
  state.sessions.filter(s=>new Date(s.started_at)>=cutoff).forEach(s=>{
    byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;
  });
  const days=Object.values(byDate);
  if (!days.length) return {grade:'—',color:'var(--text-3)',insight:'No data this week yet.'};
  const avg=days.reduce((a,b)=>a+b,0)/days.length;
  const over=days.filter(d=>d>=MAX_OUT_SECONDS).length;
  const pct=Math.round(((days.length-over)/days.length)*100);
  let grade,color,insight;
  if (pct>=95){grade='A';color='var(--sage)';insight='Excellent week — nearly perfect compliance.';}
  else if (pct>=80){grade='B';color='var(--sky)';insight=`Good week — ${over} day${over!==1?'s':''} over the limit.`;}
  else if (pct>=65){grade='C';color='var(--butter)';insight=`Room to improve — ${fmtDur(Math.round(avg))} avg daily out-time.`;}
  else if (pct>=50){grade='D';color='var(--peach)';insight='Struggling this week — try setting meal reminders.';}
  else{grade='F';color:'var(--peach)';insight='Very tough week — you\'ve got this, keep going!';}
  return {grade,color,insight};
}

// ── Tray schedule helpers ──
function currentTrayInfo() {
  const info = state.traySchedule[state.currentTray];
  if (!info) return null;
  const start = new Date(info.start_date+'T12:00:00');
  const end   = new Date(start); end.setDate(end.getDate()+info.days_to_wear);
  const today = new Date(isoDateEST()+'T12:00:00');
  const daysOn   = Math.max(0,Math.round((today-start)/(86400000)))+1;
  const daysLeft = Math.max(0,Math.round((end-today)/86400000));
  const pct = Math.min(100,Math.round((daysOn/info.days_to_wear)*100));
  return {daysOn, daysLeft, daysToWear:info.days_to_wear, pct, startDate:info.start_date, endDate:isoDateEST(end)};
}

// ── Timer persistence ──
function persistTimer() {
  if (state.running&&state.startedAt) localStorage.setItem('sw_startedAt',state.startedAt.toISOString());
  else localStorage.removeItem('sw_startedAt');
}
function restoreTimer() {
  const saved=localStorage.getItem('sw_startedAt'); if(!saved) return;
  const startedAt=new Date(saved);
  if (Date.now()-startedAt.getTime()>4*3600000){localStorage.removeItem('sw_startedAt');return;}
  state.running=true; state.startedAt=startedAt;
  state.elapsed=Math.floor((Date.now()-startedAt.getTime())/1000);
  state.ticker=setInterval(()=>{state.elapsed=Math.floor((Date.now()-state.startedAt.getTime())/1000);updateSWDisplay();},1000);
}

// ── Supabase ──
async function loadAll() {
  const [sessions,notes,schedule,tray] = await Promise.all([
    db.from('sessions').select('*').order('started_at',{ascending:false}),
    db.from('daily_notes').select('*'),
    db.from('tray_schedule').select('*'),
    db.from('settings').select('value').eq('key','current_tray').single(),
  ]);
  if (!sessions.error) state.sessions=sessions.data||[];
  if (!notes.error) { state.notes={}; (notes.data||[]).forEach(n=>state.notes[n.date_est]=n.note); }
  if (!schedule.error) { state.traySchedule={}; (schedule.data||[]).forEach(t=>state.traySchedule[t.tray_number]={start_date:t.start_date,days_to_wear:t.days_to_wear}); }
  if (tray.data) { state.currentTray=parseInt(tray.data.value)||1; state.draftTray=state.currentTray; }
}
async function saveTray(tray) {
  await db.from('settings').upsert({key:'current_tray',value:String(tray)});
  state.currentTray=tray; state.draftTray=tray;
}
async function saveTraySchedule(trayNum,startDate,daysToWear) {
  await db.from('tray_schedule').upsert({tray_number:trayNum,start_date:startDate,days_to_wear:daysToWear});
  state.traySchedule[trayNum]={start_date:startDate,days_to_wear:daysToWear};
}
async function saveNote(dateEst,text) {
  if (!text.trim()) { await db.from('daily_notes').delete().eq('date_est',dateEst); delete state.notes[dateEst]; return; }
  await db.from('daily_notes').upsert({date_est:dateEst,note:text.trim(),updated_at:new Date().toISOString()});
  state.notes[dateEst]=text.trim();
}
async function saveSession(s) { const {error}=await db.from('sessions').insert(s); if(error) console.error(error); await loadAll(); }
async function deleteSession(id) {
  await db.from('sessions').delete().eq('id',id); await loadAll(); hideToast();
  refreshCurrentView();
}
async function saveManualSession(s) { await saveSession(s); refreshCurrentView(); }

function refreshCurrentView() {
  if (state.view==='dashboard') { document.getElementById('recent-sessions').innerHTML=recentSessionsHTML(); updateSWDisplay(); }
  if (state.view==='log') renderLog();
  if (state.view==='graphs') renderGraphs();
  if (state.view==='calendar') renderCalendar();
  if (state.view==='progress') renderProgress();
}

// ── Stopwatch ──
function startTimer() {
  if (state.running) return;
  state.running=true; state.startedAt=new Date(); state.elapsed=0; state.canReset=false;
  persistTimer();
  state.ticker=setInterval(()=>{state.elapsed=Math.floor((Date.now()-state.startedAt.getTime())/1000);updateSWDisplay();},1000);
  updateSWDisplay(); renderSWButtons();
}
async function stopTimer() {
  if (!state.running) return;
  clearInterval(state.ticker); state.running=false;
  const duration=state.elapsed; const startedAt=state.startedAt;
  state.lastElapsed=duration; state.canReset=true; state.elapsed=0; state.startedAt=null;
  persistTimer();
  await saveSession({
    started_at:startedAt.toISOString(), ended_at:new Date().toISOString(),
    duration_seconds:duration, date_est:isoDateEST(startedAt),
    time_est:startedAt.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:true}),
    tray_number:state.currentTray, meal_tag:state.activeMealTag||null,
  });
  state.activeMealTag=null;
  updateSWDisplay(); renderSWButtons(); refreshCurrentView();
}
function resetTimer() {
  if (state.running||!state.canReset) return;
  state.elapsed=state.lastElapsed; updateSWDisplay();
  setTimeout(()=>{state.elapsed=0;state.lastElapsed=0;state.canReset=false;updateSWDisplay();renderSWButtons();},800);
}

// ── Display ──
function updateSWDisplay() {
  const display=document.getElementById('sw-display');
  const sub=document.getElementById('sw-sub');
  const ring=document.getElementById('sw-ring');
  if(!display||!ring) return;
  display.textContent=fmt(state.elapsed);
  const todayTotal=todayTotalSec()+state.elapsed;
  const ratio=Math.min(todayTotal/MAX_OUT_SECONDS,1);
  const C=2*Math.PI*80;
  ring.style.strokeDasharray=`${C}`;
  ring.style.strokeDashoffset=`${C*(1-ratio)}`;
  ring.style.stroke=statusColor(todayTotal);
  if(sub) sub.textContent=`Today: ${fmtDur(todayTotal)} out`;
  renderStats(); renderAlert(todayTotal);
}

function renderAlert(todayTotal) {
  const el=document.getElementById('sw-alert'); if(!el) return;
  const rem=MAX_OUT_SECONDS-todayTotal;
  if (todayTotal>=WARN_SECONDS){el.className='alert-bar danger';el.innerHTML=`🚨 <strong>${fmtDur(todayTotal-MAX_OUT_SECONDS)} over limit</strong> — aligners back in!`;el.style.display='flex';}
  else if (todayTotal>=MAX_OUT_SECONDS){el.className='alert-bar warning';el.innerHTML=`⚠️ 2h limit hit — ${fmtDur(todayTotal-MAX_OUT_SECONDS)} over. Red zone in ${fmtDur(WARN_SECONDS-todayTotal)}.`;el.style.display='flex';}
  else if (rem<=900){el.className='alert-bar warning';el.innerHTML=`⚡ Only <strong>${fmtDur(rem)}</strong> left today.`;el.style.display='flex';}
  else if (state.running){el.className='alert-bar success';el.innerHTML=`▶ Running — <strong>${fmtDur(rem)}</strong> remaining today.`;el.style.display='flex';}
  else el.style.display='none';
}

function renderStats() {
  const todayTotal=todayTotalSec()+(state.running?state.elapsed:0);
  const rem=Math.max(0,MAX_OUT_SECONDS-todayTotal);
  const s7=state.sessions.filter(s=>(Date.now()-new Date(s.started_at).getTime())<7*86400000);
  const avg7=s7.length?Math.round(s7.reduce((a,b)=>a+b.duration_seconds,0)/7):0;
  const todayEl=document.getElementById('stat-today'); const remEl=document.getElementById('stat-rem'); const avgEl=document.getElementById('stat-avg');
  if(todayEl){todayEl.textContent=fmtDur(todayTotal);todayEl.className=`stat-val ${statColor(todayTotal)}`;}
  if(remEl){remEl.textContent=rem>0?fmtDur(rem):'OVER';remEl.className=`stat-val ${remColor(rem)}`;}
  if(avgEl) avgEl.textContent=avg7?fmtDur(avg7):'—';
}

function renderSWButtons() {
  const btn=document.getElementById('sw-start-btn'); const rst=document.getElementById('sw-reset-btn'); if(!btn) return;
  if (state.running){btn.textContent='⏹ Stop & Log';btn.className='sw-btn sw-btn-stop';btn.onclick=stopTimer;}
  else{btn.textContent='▶ Start';btn.className='sw-btn sw-btn-start';btn.onclick=startTimer;}
  if(rst) rst.disabled=state.running||!state.canReset;
}

// ── Tray drum ──
function drumUp(id){state.draftTray=Math.min(99,state.draftTray+1);const el=document.getElementById(`${id}-val`);if(el){el.textContent=state.draftTray;el.style.transform='translateY(-3px)';setTimeout(()=>el.style.transform='',100);}}
function drumDown(id){state.draftTray=Math.max(1,state.draftTray-1);const el=document.getElementById(`${id}-val`);if(el){el.textContent=state.draftTray;el.style.transform='translateY(3px)';setTimeout(()=>el.style.transform='',100);}}
function trayDrumHTML(id){return `<div class="tray-drum" id="${id}"><button class="tray-drum-btn" onclick="app.drumDown('${id}')">−</button><div class="tray-drum-val" id="${id}-val">${state.draftTray}</div><button class="tray-drum-btn" onclick="app.drumUp('${id}')">+</button></div>`;}
async function saveTrayFromDrum(drumId) {
  const v=state.draftTray; await saveTray(v); closeModal();
  document.querySelectorAll('.sw-tray-lbl').forEach(el=>el.textContent=`#${v}`);
  document.querySelectorAll('.mobile-tray-btn span').forEach(el=>el.textContent=`#${v}`);
}

// ── Modals ──
function openModal(html) {
  closeModal();
  const overlay=document.createElement('div'); overlay.className='modal-overlay'; overlay.id='app-modal';
  overlay.innerHTML=`<div class="modal-sheet">${html}</div>`;
  overlay.onclick=e=>{if(e.target===overlay) closeModal();};
  document.body.appendChild(overlay);
}
function closeModal(){document.getElementById('app-modal')?.remove();}

function openTrayModal() {
  state.draftTray=state.currentTray;
  openModal(`
    <h3>Current Tray</h3>
    ${trayDrumHTML('modal-drum')}
    <div class="modal-row">
      <button class="modal-btn-primary" onclick="app.saveTrayFromDrum('modal-drum')">Save</button>
      <button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button>
    </div>`);
}

function openTrayScheduleModal() {
  const info=state.traySchedule[state.currentTray]||{start_date:isoDateEST(),days_to_wear:14};
  openModal(`
    <h3>Tray #${state.currentTray} Schedule</h3>
    <div class="form-group"><label class="form-label">Tray started on</label>
      <input class="form-input" type="date" id="tray-start" value="${info.start_date}" /></div>
    <div class="form-group"><label class="form-label">Days to wear this tray</label>
      <input class="form-input" type="number" id="tray-days" min="1" max="60" value="${info.days_to_wear}" /></div>
    <div class="modal-row">
      <button class="modal-btn-primary" onclick="app.saveTraySchedule()">Save</button>
      <button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button>
    </div>`);
}

async function saveTrayScheduleModal() {
  const startDate=document.getElementById('tray-start')?.value;
  const days=parseInt(document.getElementById('tray-days')?.value)||14;
  if (!startDate) return;
  await saveTraySchedule(state.currentTray,startDate,days);
  closeModal(); render();
}

function openQuickAddModal() {
  const today=isoDateEST();
  openModal(`
    <h3>Add Past Session</h3>
    <p style="font-size:13px;color:var(--text-2);margin-bottom:16px;">Log a session you forgot to track.</p>
    <div class="form-group"><label class="form-label">Date</label>
      <input class="form-input" type="date" id="qa-date" value="${today}" max="${today}" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Start time</label>
        <input class="form-input" type="time" id="qa-start" value="12:00" /></div>
      <div class="form-group"><label class="form-label">End time</label>
        <input class="form-input" type="time" id="qa-end" value="12:30" /></div>
    </div>
    <div class="form-group"><label class="form-label">Meal (optional)</label>
      <select class="form-input" id="qa-meal">
        <option value="">None</option>
        <option value="breakfast">Breakfast</option>
        <option value="lunch">Lunch</option>
        <option value="dinner">Dinner</option>
        <option value="snack">Snack</option>
        <option value="coffee">Coffee</option>
        <option value="other">Other</option>
      </select></div>
    <div id="qa-err" style="color:var(--peach);font-size:12px;margin-bottom:8px;display:none;"></div>
    <div class="modal-row">
      <button class="modal-btn-primary" onclick="app.submitQuickAdd()">Add Session</button>
      <button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button>
    </div>`);
}

async function submitQuickAdd() {
  const date=document.getElementById('qa-date')?.value;
  const start=document.getElementById('qa-start')?.value;
  const end=document.getElementById('qa-end')?.value;
  const meal=document.getElementById('qa-meal')?.value;
  const errEl=document.getElementById('qa-err');
  if (!date||!start||!end){if(errEl){errEl.textContent='Please fill all fields.';errEl.style.display='block';} return;}
  const startDT=new Date(`${date}T${start}:00`); const endDT=new Date(`${date}T${end}:00`);
  const dur=Math.round((endDT-startDT)/1000);
  if (dur<=0){if(errEl){errEl.textContent='End time must be after start time.';errEl.style.display='block';} return;}
  closeModal();
  await saveManualSession({
    started_at:startDT.toISOString(), ended_at:endDT.toISOString(),
    duration_seconds:dur, date_est:date,
    time_est:startDT.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:true}),
    tray_number:state.currentTray, meal_tag:meal||null,
  });
}

function openNoteModal(dateEst) {
  const existing=state.notes[dateEst]||'';
  const display=new Date(dateEst+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  openModal(`
    <div class="note-date-header">${display}</div>
    <div class="form-group"><label class="form-label">Daily Note</label>
      <textarea class="note-textarea" id="note-text" placeholder="e.g. forgot at lunch, pain on right side, rubber band day…">${existing}</textarea></div>
    <div class="modal-row">
      <button class="modal-btn-primary" onclick="app.saveNote('${dateEst}')">Save Note</button>
      <button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button>
    </div>`);
  setTimeout(()=>document.getElementById('note-text')?.focus(),50);
}

async function saveNoteModal(dateEst) {
  const text=document.getElementById('note-text')?.value||'';
  await saveNote(dateEst,text); closeModal();
  if (state.view==='calendar') renderCalendar();
}

// ── Toast ──
function showDeleteToast(id,label) {
  hideToast(); state.pendingDelete=id;
  const t=document.createElement('div'); t.className='toast'; t.id='delete-toast';
  t.innerHTML=`<span>Delete session on ${label}?</span><button class="toast-confirm" onclick="app.confirmDelete()">Delete</button><button class="toast-cancel" onclick="app.hideToast()">Cancel</button>`;
  document.body.appendChild(t);
  setTimeout(()=>{if(document.getElementById('delete-toast'))hideToast();},6000);
}
function hideToast(){document.getElementById('delete-toast')?.remove();state.pendingDelete=null;}

// ── Sidebar ──
const NAV=[
  {id:'dashboard',label:'Dashboard',icon:'⊞'},
  {id:'log',      label:'Log',      icon:'☰'},
  {id:'progress', label:'Progress', icon:'◎'},
  {id:'graphs',   label:'Graphs',   icon:'⌇'},
  {id:'calendar', label:'Calendar', icon:'▦'},
];

function sidebarHTML() {
  return `<aside class="sidebar">
    <div class="sidebar-logo"><h1>Invisalign</h1><p>22hr wear tracker</p></div>
    <div class="nav-label">Views</div>
    ${NAV.map(i=>`<div class="nav-item ${state.view===i.id?'active':''}" onclick="app.navigate('${i.id}')">${i.icon} ${i.label}</div>`).join('')}
    <div class="tray-badge">
      <label>Current Tray</label>
      ${trayDrumHTML('sidebar-drum')}
      <button class="tray-save-btn" onclick="app.saveTrayFromDrum('sidebar-drum')">Save tray</button>
    </div>
  </aside>`;
}
function mobileHeaderHTML(){return `<header class="mobile-header"><span class="mobile-header-title">Invisalign</span><button class="mobile-tray-btn" onclick="app.openTrayModal()">Tray <span>#${state.currentTray}</span></button></header>`;}
function mobileNavHTML(){return `<nav class="mobile-nav"><div class="mobile-nav-inner">${NAV.map(i=>`<div class="mobile-nav-item ${state.view===i.id?'active':''}" onclick="app.navigate('${i.id}')"><span class="mob-icon">${i.icon}</span><span>${i.label}</span></div>`).join('')}</div></nav>`;}

// ── Dashboard ──
const MEAL_TAGS=['breakfast','lunch','dinner','snack','coffee','other'];

function dashboardHTML() {
  const C=2*Math.PI*80;
  const todayTotal=todayTotalSec()+(state.running?state.elapsed:0);
  const ratio=Math.min(todayTotal/MAX_OUT_SECONDS,1);
  const rem=Math.max(0,MAX_OUT_SECONDS-todayTotal);
  const s7=state.sessions.filter(s=>(Date.now()-new Date(s.started_at).getTime())<7*86400000);
  const avg7=s7.length?Math.round(s7.reduce((a,b)=>a+b.duration_seconds,0)/7):0;
  const trayInfo=currentTrayInfo();

  return `
    <div class="page-title">Dashboard</div>
    <div id="sw-alert" class="alert-bar" style="display:none"></div>
    <div class="dash-grid">

      <div class="card stopwatch-card span-full">
        <div class="ring-container">
          <svg class="ring-svg" width="200" height="200" viewBox="0 0 200 200">
            <circle class="ring-bg" cx="100" cy="100" r="80"/>
            <circle class="ring-track" id="sw-ring" cx="100" cy="100" r="80"
              stroke-dasharray="${C}" stroke-dashoffset="${C*(1-ratio)}"
              style="stroke:${statusColor(todayTotal)}"/>
          </svg>
          <div class="sw-display" id="sw-display">${fmt(state.elapsed)}</div>
          <div class="sw-sub" id="sw-sub">Today: ${fmtDur(todayTotal)} out</div>
        </div>
        <p class="sw-status">Tray <span class="sw-tray-lbl">#${state.currentTray}</span> &nbsp;·&nbsp;
          ${state.running?`<span class="running-lbl">Running since ${state.startedAt?.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:true,hour:'2-digit',minute:'2-digit'})}</span>`:'<span style="color:var(--text-3)">Stopped</span>'}
        </p>
        <p class="meal-tag-label">Tag this session (optional)</p>
        <div class="meal-tags">
          ${MEAL_TAGS.map(t=>`<div class="meal-tag ${state.activeMealTag===t?'active':''}" onclick="app.setMealTag('${t}')">${t}</div>`).join('')}
        </div>
        <div class="sw-btns">
          <button class="${state.running?'sw-btn sw-btn-stop':'sw-btn sw-btn-start'}" id="sw-start-btn" onclick="${state.running?'app.stop()':'app.start()'}">
            ${state.running?'⏹ Stop & Log':'▶ Start'}
          </button>
          <button class="sw-btn sw-btn-reset" id="sw-reset-btn" onclick="app.reset()" ${state.running||!state.canReset?'disabled':''}>Reset</button>
          <button class="sw-btn sw-btn-quick" onclick="app.openQuickAdd()">+ Past Session</button>
        </div>
      </div>

      <div class="card span-full" style="padding:0;">
        <div class="stats-grid">
          <div class="stat-cell"><div class="stat-lbl">Today out</div><div class="stat-val ${statColor(todayTotal)}" id="stat-today">${fmtDur(todayTotal)}</div></div>
          <div class="stat-cell"><div class="stat-lbl">Remaining</div><div class="stat-val ${remColor(rem)}" id="stat-rem">${rem>0?fmtDur(rem):'OVER'}</div></div>
          <div class="stat-cell"><div class="stat-lbl">7-day avg</div><div class="stat-val c-lavender" id="stat-avg">${avg7?fmtDur(avg7):'—'}</div></div>
        </div>
      </div>

      ${trayInfo ? `
      <div class="card">
        <div class="section-title">Tray Progress</div>
        <div class="tray-card">
          <div class="tray-ring">
            <svg width="72" height="72" viewBox="0 0 72 72">
              <circle cx="36" cy="36" r="28" fill="none" stroke="var(--bg-3)" stroke-width="7"/>
              <circle cx="36" cy="36" r="28" fill="none" stroke="var(--lavender)" stroke-width="7" stroke-linecap="round"
                stroke-dasharray="${2*Math.PI*28}" stroke-dashoffset="${2*Math.PI*28*(1-trayInfo.pct/100)}"
                transform="rotate(-90 36 36)" style="transition:stroke-dashoffset 0.5s"/>
            </svg>
            <div class="tray-pct">${trayInfo.pct}%</div>
          </div>
          <div class="tray-info">
            <h3>Tray #${state.currentTray}</h3>
            <p>Day <strong>${trayInfo.daysOn}</strong> of ${trayInfo.daysToWear} &nbsp;·&nbsp; <strong style="color:${trayInfo.daysLeft<=2?'var(--peach)':trayInfo.daysLeft<=4?'var(--butter)':'var(--sage)'}">${trayInfo.daysLeft} day${trayInfo.daysLeft!==1?'s':''}</strong> left</p>
            <p style="font-size:12px;color:var(--text-3);margin-top:2px;">Change on ${new Date(trayInfo.endDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}</p>
            <button class="tray-edit-btn" onclick="app.openTraySchedule()">Edit schedule</button>
          </div>
        </div>
      </div>` : `
      <div class="card">
        <div class="section-title">Tray Schedule</div>
        <p style="font-size:13px;color:var(--text-3);margin-bottom:12px;">Set your tray start date and wear duration for the change countdown.</p>
        <button class="sw-btn sw-btn-quick" style="width:100%" onclick="app.openTraySchedule()">Set Tray #${state.currentTray} Schedule</button>
      </div>`}

      <div class="card">
        <div class="section-title">Today's Note</div>
        ${state.notes[isoDateEST()]
          ?`<p style="font-size:13px;color:var(--text-2);line-height:1.6;">${state.notes[isoDateEST()]}</p><button class="tray-edit-btn" onclick="app.openNote('${isoDateEST()}')">Edit</button>`
          :`<p style="font-size:13px;color:var(--text-3);margin-bottom:10px;">No note for today.</p><button class="sw-btn sw-btn-quick" style="width:100%;padding:8px;" onclick="app.openNote('${isoDateEST()}')">+ Add Note</button>`}
      </div>

      <div class="card span-full">
        <div class="section-title">Recent Sessions</div>
        <div id="recent-sessions">${recentSessionsHTML()}</div>
      </div>
    </div>`;
}

function recentSessionsHTML() {
  const recent=state.sessions.slice(0,6);
  if (!recent.length) return `<p class="empty-state">No sessions yet. Hit Start!</p>`;
  return recent.map(s=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
      <div><span style="font-size:13px;color:var(--text);">${s.date_est}</span><span style="font-size:11px;color:var(--text-3);margin-left:8px;">${s.time_est||''}</span></div>
      <div style="display:flex;gap:8px;align-items:center;">
        ${s.meal_tag?`<span class="meal-pill">${s.meal_tag}</span>`:''}
        <span class="tray-pill">T${s.tray_number}</span>
        <span style="font-family:'DM Mono',monospace;font-size:13px;color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</span>
        <button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')">✕</button>
      </div>
    </div>`).join('');
}

// ── Log ──
function renderLog() {
  const fv=(document.getElementById('log-filter')?.value||'').toLowerCase();
  let sessions=[...state.sessions];
  if (fv) sessions=sessions.filter(s=>s.date_est?.includes(fv)||String(s.tray_number)?.includes(fv)||(s.meal_tag||'').includes(fv));

  const rows=sessions.map(s=>`<tr>
    <td class="mono">${s.date_est||'—'}</td><td>${s.time_est||'—'}</td>
    <td class="mono" style="color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</td>
    <td><span class="tray-pill">T${s.tray_number}</span></td>
    <td>${s.meal_tag?`<span class="meal-pill">${s.meal_tag}</span>`:''}</td>
    <td><button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')">✕</button></td>
  </tr>`).join('');

  const cards=sessions.map(s=>`<div class="log-card">
    <div class="log-card-left"><div class="log-card-date">${s.date_est||'—'}</div><div class="log-card-time">${s.time_est||''} ${s.meal_tag?`· ${s.meal_tag}`:''}</div></div>
    <div class="log-card-right"><div class="log-card-dur" style="color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</div>
      <div style="display:flex;gap:6px;align-items:center;"><span class="tray-pill">T${s.tray_number}</span><button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')">✕</button></div>
    </div></div>`).join('');

  document.querySelector('.main').innerHTML=`
    <div class="page-title">Session Log</div>
    <div class="log-filters">
      <input class="filter-input" placeholder="Filter by date, tray, or meal…" id="log-filter" value="${fv}" oninput="app.filterLog()"/>
      <span style="font-size:12px;color:var(--text-3)">${sessions.length} sessions</span>
      <button class="sw-btn sw-btn-quick" style="padding:8px 14px;min-width:0;font-size:12px" onclick="app.openQuickAdd()">+ Past Session</button>
    </div>
    ${!sessions.length?`<div class="card"><p class="empty-state">No sessions found.</p></div>`:`
      <div class="log-table-wrap card" style="padding:0;overflow:hidden;">
        <table class="log-table"><thead><tr><th>Date</th><th>Time</th><th>Duration</th><th>Tray</th><th>Meal</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="log-cards">${cards}</div>`}`;
}

// ── Progress ──
function renderProgress() {
  const comp30=calcCompliance(30); const comp7=calcCompliance(7);
  const {streak,best}=calcStreak();
  const {best:bestDay,worst:worstDay}=calcDayOfWeek();
  const {grade,color,insight}=weekGrade();

  document.querySelector('.main').innerHTML=`
    <div class="page-title">Progress</div>
    <div class="progress-grid">

      <div class="card" style="text-align:center;">
        <div class="section-title">Week Grade</div>
        <div class="grade-circle" style="background:${color}22;color:${color}">${grade}</div>
        <p style="font-size:12px;color:var(--text-2);">${insight}</p>
      </div>

      <div class="card span-2">
        <div class="section-title">Compliance Score</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          ${complianceBlockHTML('7-day',comp7)}
          ${complianceBlockHTML('30-day',comp30)}
        </div>
      </div>

      <div class="card">
        <div class="section-title">Current Streak</div>
        <div class="streak-badge"><div class="streak-num">${streak}</div><div class="streak-lbl">day${streak!==1?'s':''} under limit</div></div>
        <p style="font-size:12px;color:var(--text-3)">Best streak: <strong style="color:var(--rose)">${best} day${best!==1?'s':''}</strong></p>
      </div>

      <div class="card">
        <div class="section-title">Day of Week</div>
        ${bestDay?`
          <div class="insight-row"><span class="insight-key">🏆 Best day</span><span class="insight-val c-sage">${bestDay.day} · ${fmtDur(bestDay.avg)}</span></div>
          <div class="insight-row"><span class="insight-key">⚠ Worst day</span><span class="insight-val c-peach">${worstDay.day} · ${fmtDur(worstDay.avg)}</span></div>`
          :'<p style="font-size:13px;color:var(--text-3)">Need more data.</p>'}
      </div>

      <div class="card">
        <div class="section-title">All-time Stats</div>
        ${allTimeStatsHTML()}
      </div>

      <div class="card span-full">
        <div class="section-title">Compliance — last 30 days</div>
        <div class="chart-wrap" style="height:160px;"><canvas id="chart-compliance"></canvas></div>
      </div>

    </div>`;
  drawComplianceChart();
}

function complianceBlockHTML(label,pct) {
  if (pct===null) return `<div><div style="font-size:11px;color:var(--text-3);margin-bottom:6px">${label}</div><div style="font-size:24px;color:var(--text-3)">—</div></div>`;
  const col=pct>=90?'var(--sage)':pct>=70?'var(--butter)':'var(--peach)';
  return `<div>
    <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;font-weight:600">${label}</div>
    <div style="font-size:30px;font-family:'DM Mono',monospace;color:${col};margin-bottom:8px">${pct}%</div>
    <div class="compliance-bar-wrap"><div class="compliance-bar-track"><div class="compliance-bar-fill" style="width:${pct}%;background:${col}"></div></div></div>
  </div>`;
}

function allTimeStatsHTML() {
  const total=state.sessions.reduce((a,b)=>a+b.duration_seconds,0);
  const count=state.sessions.length;
  const avg=count?Math.round(total/count):0;
  const byDate={};
  state.sessions.forEach(s=>{if(s.date_est) byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;});
  const days=Object.values(byDate);
  const bestDay=days.length?Math.min(...days):0;
  return `
    <div class="insight-row"><span class="insight-key">Total sessions</span><span class="insight-val c-sky">${count}</span></div>
    <div class="insight-row"><span class="insight-key">Total out-time</span><span class="insight-val c-lavender">${fmtDur(total)}</span></div>
    <div class="insight-row"><span class="insight-key">Avg per session</span><span class="insight-val">${avg?fmtDur(avg):'—'}</span></div>
    <div class="insight-row"><span class="insight-key">Best day ever</span><span class="insight-val c-sage">${bestDay?fmtDur(bestDay):'—'}</span></div>`;
}

function drawComplianceChart() {
  const byDate={};
  state.sessions.forEach(s=>{if(s.date_est) byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;});
  const labels=[], data=[], colors=[];
  for (let i=29;i>=0;i--) {
    const d=new Date(); d.setDate(d.getDate()-i);
    const ds=isoDateEST(d); labels.push(ds.slice(5));
    const sec=byDate[ds]||0; data.push(Math.round(sec/60));
    colors.push(sec===0?'rgba(255,255,255,0.05)':sec>=WARN_SECONDS?'rgba(242,181,160,0.75)':sec>=MAX_OUT_SECONDS?'rgba(245,223,160,0.75)':'rgba(168,213,186,0.75)');
  }
  if (state.charts.comp) state.charts.comp.destroy();
  state.charts.comp=new Chart(document.getElementById('chart-compliance'),{
    type:'bar', data:{labels,datasets:[{data,backgroundColor:colors,borderRadius:3}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.raw}m`}}},
      scales:{x:{ticks:{color:'#8892AA',font:{size:9},maxRotation:0,maxTicksLimit:10},grid:{color:'rgba(255,255,255,0.03)'}},
              y:{ticks:{color:'#8892AA',callback:v=>`${v}m`},grid:{color:'rgba(255,255,255,0.05)'}}},
      responsive:true,maintainAspectRatio:false}
  });
}

// ── Graphs ──
function renderGraphs() {
  document.querySelector('.main').innerHTML=`
    <div class="page-title">Graphs</div>
    <div class="charts-grid">
      <div class="card chart-full"><div class="section-title">Daily out-time — last 30 days</div><div class="chart-wrap"><canvas id="chart-daily"></canvas></div></div>
      <div class="card"><div class="section-title">By day of week (avg)</div><div class="chart-wrap"><canvas id="chart-dow"></canvas></div></div>
      <div class="card"><div class="section-title">Session duration mix</div><div class="chart-wrap"><canvas id="chart-dist"></canvas></div></div>
      <div class="card"><div class="section-title">Meal breakdown</div><div class="chart-wrap"><canvas id="chart-meal"></canvas></div></div>
    </div>`;
  drawCharts();
}

function drawCharts() {
  const last30={};
  for(let i=29;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);last30[isoDateEST(d)]=0;}
  state.sessions.forEach(s=>{if(last30.hasOwnProperty(s.date_est))last30[s.date_est]+=s.duration_seconds/60;});
  const labels30=Object.keys(last30).map(d=>{const[,m,day]=d.split('-');return `${parseInt(m)}/${parseInt(day)}`;});
  const data30=Object.values(last30);
  const barColor=v=>v>WARN_SECONDS/60?'rgba(242,181,160,0.8)':v>MAX_OUT_SECONDS/60?'rgba(245,223,160,0.8)':'rgba(168,213,186,0.75)';

  if(state.charts.daily)state.charts.daily.destroy();
  state.charts.daily=new Chart(document.getElementById('chart-daily'),{type:'bar',
    data:{labels:labels30,datasets:[{data:data30,backgroundColor:data30.map(barColor),borderRadius:3}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${Math.round(ctx.raw)}m`}}},
      scales:{x:{ticks:{color:'#8892AA',font:{size:9},maxRotation:0},grid:{color:'rgba(255,255,255,0.03)'}},
              y:{ticks:{color:'#8892AA',callback:v=>`${v}m`},grid:{color:'rgba(255,255,255,0.05)'}}},
      responsive:true,maintainAspectRatio:false}});

  const dow=Array(7).fill(0).map(()=>({t:0,c:0}));
  const byDate={};
  state.sessions.forEach(s=>{if(s.date_est)byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;});
  Object.entries(byDate).forEach(([d,sec])=>{const day=new Date(d+'T12:00:00').getDay();dow[day].t+=sec/60;dow[day].c++;});
  const dowData=dow.map(d=>d.c?Math.round(d.t/d.c):0);

  if(state.charts.dow)state.charts.dow.destroy();
  state.charts.dow=new Chart(document.getElementById('chart-dow'),{type:'bar',
    data:{labels:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],datasets:[{data:dowData,backgroundColor:'rgba(168,212,245,0.7)',borderRadius:3}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.raw}m avg`}}},
      scales:{x:{ticks:{color:'#8892AA',font:{size:11}},grid:{display:false}},
              y:{ticks:{color:'#8892AA',callback:v=>`${v}m`},grid:{color:'rgba(255,255,255,0.05)'}}},
      responsive:true,maintainAspectRatio:false}});

  const buckets={'<15m':0,'15–30m':0,'30–60m':0,'60–90m':0,'>90m':0};
  state.sessions.forEach(s=>{const m=s.duration_seconds/60;if(m<15)buckets['<15m']++;else if(m<30)buckets['15–30m']++;else if(m<60)buckets['30–60m']++;else if(m<90)buckets['60–90m']++;else buckets['>90m']++;});

  if(state.charts.dist)state.charts.dist.destroy();
  state.charts.dist=new Chart(document.getElementById('chart-dist'),{type:'doughnut',
    data:{labels:Object.keys(buckets),datasets:[{data:Object.values(buckets),backgroundColor:['rgba(168,213,186,0.85)','rgba(168,212,245,0.8)','rgba(196,181,232,0.8)','rgba(245,223,160,0.8)','rgba(242,181,160,0.85)'],borderWidth:0}]},
    options:{plugins:{legend:{labels:{color:'#8892AA',font:{size:11}}}},responsive:true,maintainAspectRatio:false,cutout:'58%'}});

  const mealCounts={breakfast:0,lunch:0,dinner:0,snack:0,coffee:0,other:0,none:0};
  state.sessions.forEach(s=>{const tag=s.meal_tag&&mealCounts.hasOwnProperty(s.meal_tag)?s.meal_tag:'none';mealCounts[tag]++;});
  const mealLabels=Object.keys(mealCounts).filter(k=>mealCounts[k]>0);
  const mealData=mealLabels.map(k=>mealCounts[k]);

  if(state.charts.meal)state.charts.meal.destroy();
  state.charts.meal=new Chart(document.getElementById('chart-meal'),{type:'doughnut',
    data:{labels:mealLabels,datasets:[{data:mealData,backgroundColor:['rgba(245,223,160,0.8)','rgba(168,213,186,0.8)','rgba(242,181,160,0.8)','rgba(196,181,232,0.8)','rgba(168,212,245,0.8)','rgba(240,160,184,0.8)','rgba(80,90,120,0.5)'],borderWidth:0}]},
    options:{plugins:{legend:{labels:{color:'#8892AA',font:{size:11}}}},responsive:true,maintainAspectRatio:false,cutout:'58%'}});
}

// ── Calendar ──
function renderCalendar() {
  const {calYear:year,calMonth:month}=state;
  const monthName=new Date(year,month,1).toLocaleString('default',{month:'long'});
  const byDate={};
  state.sessions.forEach(s=>{if(!s.date_est)return;const[y,m]=s.date_est.split('-').map(Number);if(y===year&&m-1===month)byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;});
  const trayByDate={};
  state.sessions.forEach(s=>{if(!s.date_est)return;const[y,m]=s.date_est.split('-').map(Number);if(y===year&&m-1===month)trayByDate[s.date_est]=s.tray_number;});

  const firstDay=new Date(year,month,1).getDay();
  const daysInMonth=new Date(year,month+1,0).getDate();
  const todayStr=isoDateEST();

  let cells=Array(firstDay).fill('<div class="cal-cell empty"></div>').join('');
  for(let d=1;d<=daysInMonth;d++){
    const ds=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const sec=byDate[ds]||0; const dc=sec?durClass(sec):'';
    const note=state.notes[ds]||''; const tray=trayByDate[ds];
    cells+=`<div class="cal-cell ${ds===todayStr?'today':''} ${note?'has-note':''}" onclick="app.openNote('${ds}')">
      <div class="cal-date">${d}</div>
      ${sec?`<div class="cal-dur ${dc}">${fmtDur(sec)}</div>`:''}
      ${note?`<div class="cal-note-preview">${note}</div>`:''}
      ${tray?`<div class="cal-tray">T${tray}</div>`:''}
    </div>`;
  }

  document.querySelector('.main').innerHTML=`
    <div class="page-title">Calendar</div>
    <p style="font-size:13px;color:var(--text-3);margin-bottom:16px;">Tap any day to add or edit a note.</p>
    <div class="card">
      <div class="cal-header">
        <button class="cal-nav-btn" onclick="app.calPrev()">← Prev</button>
        <span class="cal-month-lbl">${monthName} ${year}</span>
        <button class="cal-nav-btn" onclick="app.calNext()">Next →</button>
      </div>
      <div class="cal-grid">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="cal-day-name">${d}</div>`).join('')}
        ${cells}
      </div>
      <div class="cal-legend">
        <span><span style="color:var(--sage)">■</span> Under 2h</span>
        <span><span style="color:var(--butter)">■</span> 2h–2h30m</span>
        <span><span style="color:var(--peach)">■</span> Over 2h30m</span>
        <span><span style="color:var(--lavender)">•</span> Has note</span>
      </div>
    </div>`;
}

// ── Render ──
function render() {
  document.getElementById('app').innerHTML=`
    <div class="layout">
      ${sidebarHTML()}
      <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        ${mobileHeaderHTML()}
        <main class="main">${state.view==='dashboard'?dashboardHTML():''}</main>
      </div>
    </div>
    ${mobileNavHTML()}`;
  if(state.view==='dashboard'){updateSWDisplay();renderStats();renderSWButtons();}
  else if(state.view==='log')renderLog();
  else if(state.view==='progress')renderProgress();
  else if(state.view==='graphs')renderGraphs();
  else if(state.view==='calendar')renderCalendar();
}

// ── Public API ──
window.app={
  start:startTimer, stop:stopTimer, reset:resetTimer,
  navigate(v){state.view=v;render();},
  filterLog(){renderLog();},
  calPrev(){state.calMonth--;if(state.calMonth<0){state.calMonth=11;state.calYear--;}renderCalendar();},
  calNext(){state.calMonth++;if(state.calMonth>11){state.calMonth=0;state.calYear++;}renderCalendar();},
  drumUp, drumDown, saveTrayFromDrum,
  openTrayModal, closeModal,
  openTraySchedule:openTrayScheduleModal,
  saveTraySchedule:saveTrayScheduleModal,
  openQuickAdd:openQuickAddModal,
  submitQuickAdd,
  openNote:openNoteModal,
  saveNote:saveNoteModal,
  askDelete:showDeleteToast,
  confirmDelete(){if(state.pendingDelete)deleteSession(state.pendingDelete);},
  hideToast,
  setMealTag(tag){
    state.activeMealTag=state.activeMealTag===tag?null:tag;
    document.querySelectorAll('.meal-tag').forEach(el=>{el.classList.toggle('active',el.textContent===tag&&state.activeMealTag===tag);});
  },
};

// ── Boot ──
async function init(){
  try{
    await loadAll(); restoreTimer(); render();
  } catch(e){
    document.getElementById('app').innerHTML=`<div style="text-align:center;padding:60px;color:var(--peach);"><p>⚠ Could not connect to Supabase.</p><p style="font-size:13px;color:var(--text-3);margin-top:8px;">Check config.js credentials.</p></div>`;
    console.error(e);
  }
}
init();
