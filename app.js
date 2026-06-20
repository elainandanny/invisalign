import { SUPABASE_URL, SUPABASE_ANON_KEY, MAX_OUT_SECONDS } from './config.js';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WARN_SECONDS = MAX_OUT_SECONDS + 30 * 60;
const TOTAL_TRAYS  = 36;
// Default schedule: trays 1-3 = 14 days, 4-36 = 7 days
function defaultDaysForTray(t) { return t <= 3 ? 14 : 7; }

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
  notes: {},
  traySchedule: {},
  currentTray: 1,
  draftTray: 1,
  calMonth: new Date().getMonth(),
  calYear:  new Date().getFullYear(),
  charts: {},
  pendingDelete: null,
};

// ── Helpers ──
const fmt = sec => [Math.floor(sec/3600), Math.floor((sec%3600)/60), sec%60].map(n=>String(n).padStart(2,'0')).join(':');
function fmtDur(sec) {
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60);
  if(h>0&&m>0) return `${h}h ${m}m`; if(h>0) return `${h}h`; return `${m}m`;
}
const isoDateEST = (d=new Date()) => d.toLocaleDateString('sv-SE',{timeZone:'America/New_York'});
const todayTotalSec = () => state.sessions.filter(s=>s.date_est===isoDateEST()).reduce((sum,s)=>sum+(s.duration_seconds||0),0);

function statusColor(sec) {
  if(sec>=WARN_SECONDS) return 'var(--peach)';
  if(sec>=MAX_OUT_SECONDS) return 'var(--butter)';
  return 'var(--sage)';
}
function durClass(sec) {
  if(sec>=WARN_SECONDS) return 'danger';
  if(sec>=MAX_OUT_SECONDS) return 'warning';
  return 'good';
}
function statColor(sec) {
  if(sec>=WARN_SECONDS) return 'c-peach';
  if(sec>=MAX_OUT_SECONDS) return 'c-butter';
  return 'c-sage';
}
function remColor(rem) {
  if(rem<=0) return 'c-peach';
  if(rem<=1800) return 'c-butter';
  return 'c-sky';
}

function calcCompliance(days=30) {
  const counts={};
  state.sessions.forEach(s=>{ if(s.date_est) counts[s.date_est]=(counts[s.date_est]||0)+s.duration_seconds; });
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-days);
  const relevant=Object.entries(counts).filter(([d])=>new Date(d+'T12:00:00')>=cutoff);
  if(!relevant.length) return null;
  return Math.round((relevant.filter(([,s])=>s<MAX_OUT_SECONDS).length/relevant.length)*100);
}

function calcStreak() {
  const counts={};
  state.sessions.forEach(s=>{ if(s.date_est) counts[s.date_est]=(counts[s.date_est]||0)+s.duration_seconds; });
  const today=isoDateEST();
  // Current streak
  let streak=0; const d1=new Date();
  for(let i=0;i<365;i++){
    const ds=isoDateEST(d1); const tot=counts[ds]||0;
    if(tot>0&&tot<MAX_OUT_SECONDS) streak++;
    else if(i>0) break;
    d1.setDate(d1.getDate()-1);
  }
  // Best streak
  let best=0,cur=0; const d2=new Date();
  d2.setDate(d2.getDate()-364);
  for(let i=0;i<365;i++){
    const ds=isoDateEST(d2); const tot=counts[ds]||0;
    if(tot>0&&tot<MAX_OUT_SECONDS){cur++;best=Math.max(best,cur);}
    else cur=0;
    d2.setDate(d2.getDate()+1);
  }
  return {streak,best};
}

function calcDayOfWeek() {
  const dow=Array(7).fill(null).map(()=>({t:0,c:0}));
  const byDate={};
  state.sessions.forEach(s=>{ if(s.date_est) byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds; });
  Object.entries(byDate).forEach(([d,sec])=>{ const day=new Date(d+'T12:00:00').getDay(); dow[day].t+=sec; dow[day].c++; });
  const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const avgs=dow.map((d,i)=>({day:names[i],avg:d.c?Math.round(d.t/d.c):0})).filter(a=>a.avg>0);
  if(!avgs.length) return {best:null,worst:null};
  return {best:avgs.reduce((a,b)=>a.avg<b.avg?a:b), worst:avgs.reduce((a,b)=>a.avg>b.avg?a:b)};
}

function weekGrade() {
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-7);
  const byDate={};
  state.sessions.filter(s=>new Date(s.started_at)>=cutoff).forEach(s=>{
    byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;
  });
  const days=Object.values(byDate);
  if(!days.length) return {grade:'—',color:'var(--text-3)',insight:'No data this week yet.'};
  const avg=days.reduce((a,b)=>a+b,0)/days.length;
  const over=days.filter(d=>d>=MAX_OUT_SECONDS).length;
  const pct=Math.round(((days.length-over)/days.length)*100);
  if(pct>=95) return {grade:'A',color:'var(--sage)',insight:'Excellent — nearly perfect compliance!'};
  if(pct>=80) return {grade:'B',color:'var(--sky)',insight:`Good — ${over} day${over!==1?'s':''} over the limit.`};
  if(pct>=65) return {grade:'C',color:'var(--butter)',insight:`${fmtDur(Math.round(avg))} avg out-time — getting there.`};
  if(pct>=50) return {grade:'D',color:'var(--peach)',insight:'Tough week — try logging meals to spot patterns.'};
  return {grade:'F',color:'var(--peach)',insight:"Hard week — you've got this. Keep going!"};
}

// ── Tray schedule ──
function currentTrayInfo() {
  const info=state.traySchedule[state.currentTray]; if(!info) return null;
  const start=new Date(info.start_date+'T12:00:00');
  const end=new Date(start); end.setDate(end.getDate()+info.days_to_wear);
  const today=new Date(isoDateEST()+'T12:00:00');
  const daysOn=Math.max(1,Math.round((today-start)/86400000)+1);
  const daysLeft=Math.max(0,Math.round((end-today)/86400000));
  const pct=Math.min(100,Math.round((daysOn/info.days_to_wear)*100));
  return {daysOn,daysLeft,daysToWear:info.days_to_wear,pct,startDate:info.start_date,endDate:isoDateEST(end)};
}

// Build default schedule from a tray-1 start date
function buildDefaultSchedule(tray1Start) {
  const schedule={};
  let cursor=new Date(tray1Start+'T12:00:00');
  for(let t=1;t<=TOTAL_TRAYS;t++){
    const days=defaultDaysForTray(t);
    schedule[t]={start_date:isoDateEST(cursor),days_to_wear:days};
    cursor.setDate(cursor.getDate()+days);
  }
  return schedule;
}

// ── Persistence ──
function persistTimer() {
  if(state.running&&state.startedAt) localStorage.setItem('sw_startedAt',state.startedAt.toISOString());
  else localStorage.removeItem('sw_startedAt');
}
function restoreTimer() {
  const saved=localStorage.getItem('sw_startedAt'); if(!saved) return;
  const startedAt=new Date(saved);
  if(Date.now()-startedAt.getTime()>4*3600000){localStorage.removeItem('sw_startedAt');return;}
  state.running=true; state.startedAt=startedAt;
  state.elapsed=Math.floor((Date.now()-startedAt.getTime())/1000);
  state.canReset=false;
  state.ticker=setInterval(()=>{state.elapsed=Math.floor((Date.now()-state.startedAt.getTime())/1000);updateSWDisplay();},1000);
}

// ── Supabase ──
async function loadAll() {
  const [sess,notes,sched,tray]=await Promise.all([
    db.from('sessions').select('*').order('started_at',{ascending:false}),
    db.from('daily_notes').select('*'),
    db.from('tray_schedule').select('*'),
    db.from('settings').select('value').eq('key','current_tray').single(),
  ]);
  if(!sess.error)  state.sessions=sess.data||[];
  if(!notes.error) { state.notes={}; (notes.data||[]).forEach(n=>state.notes[n.date_est]=n.note); }
  if(!sched.error) { state.traySchedule={}; (sched.data||[]).forEach(t=>state.traySchedule[t.tray_number]={start_date:t.start_date,days_to_wear:t.days_to_wear}); }
  if(tray.data)    { state.currentTray=parseInt(tray.data.value)||1; state.draftTray=state.currentTray; }
}

async function saveTray(tray) {
  await db.from('settings').upsert({key:'current_tray',value:String(tray)});
  state.currentTray=tray; state.draftTray=tray;
}
async function saveTrayScheduleRow(trayNum,startDate,daysToWear) {
  await db.from('tray_schedule').upsert({tray_number:trayNum,start_date:startDate,days_to_wear:daysToWear});
  state.traySchedule[trayNum]={start_date:startDate,days_to_wear:daysToWear};
}
async function saveNote(dateEst,text) {
  if(!text.trim()){await db.from('daily_notes').delete().eq('date_est',dateEst);delete state.notes[dateEst];return;}
  await db.from('daily_notes').upsert({date_est:dateEst,note:text.trim(),updated_at:new Date().toISOString()});
  state.notes[dateEst]=text.trim();
}
async function insertSession(s) { const {error}=await db.from('sessions').insert(s); if(error) console.error(error); await loadAll(); }
async function deleteSession(id) { await db.from('sessions').delete().eq('id',id); await loadAll(); hideToast(); refreshView(); }

// ── Timer ──
function startTimer() {
  if(state.running) return;
  state.running=true; state.startedAt=new Date(); state.elapsed=0; state.canReset=false;
  persistTimer();
  state.ticker=setInterval(()=>{ state.elapsed=Math.floor((Date.now()-state.startedAt.getTime())/1000); updateSWDisplay(); },1000);
  updateSWDisplay(); renderSWButtons();
}

async function stopTimer() {
  if(!state.running) return;
  clearInterval(state.ticker); state.running=false;

  // Capture everything before clearing state
  const duration   = state.elapsed;
  const startedAt  = state.startedAt;
  const mealTag    = state.activeMealTag;
  const endedAt    = new Date();
  const timeEst    = startedAt.toLocaleTimeString('en-US', {timeZone:'America/New_York', hour12:true});
  const dateEst    = isoDateEST(startedAt);

  // Clear state — canReset must be true before any DOM update
  state.lastElapsed   = duration;
  state.canReset      = true;
  state.elapsed       = 0;
  state.startedAt     = null;
  state.activeMealTag = null;
  persistTimer();

  // Update buttons and display immediately (reset is now enabled)
  renderSWButtons();
  updateSWDisplay();

  // Save to Supabase, then do a partial DOM refresh (never replaces button area)
  try {
    await insertSession({
      started_at:       startedAt.toISOString(),
      ended_at:         endedAt.toISOString(),
      duration_seconds: duration,
      date_est:         dateEst,
      time_est:         timeEst,
      tray_number:      state.currentTray,
      meal_tag:         mealTag || null,
    });
    const rs = document.getElementById('recent-sessions');
    if(rs) rs.innerHTML = recentSessionsHTML();
    renderStats();
    updateSWDisplay();
  } catch(e) {
    console.error('Failed to save session:', e);
    const al = document.getElementById('sw-alert');
    if(al) { al.className='alert-bar danger'; al.innerHTML='⚠ Session could not be saved — check your connection.'; al.style.display='flex'; }
  }
}

function resetTimer() {
  if(state.running||!state.canReset) return;
  // Brief flash of last elapsed, then clear
  const saved=state.lastElapsed;
  state.elapsed=saved; updateSWDisplay();
  setTimeout(()=>{
    state.elapsed=0; state.lastElapsed=0; state.canReset=false;
    updateSWDisplay(); renderSWButtons();
  },700);
}

// ── Display updates (partial DOM, never replaces buttons) ──
function updateSWDisplay() {
  const display=document.getElementById('sw-display');
  const sub=document.getElementById('sw-sub');
  const ring=document.getElementById('sw-ring');
  if(!display||!ring) return;
  display.textContent=fmt(state.elapsed);
  const todayTotal=todayTotalSec()+state.elapsed;
  const C=2*Math.PI*80;
  ring.style.strokeDasharray=`${C}`;
  ring.style.strokeDashoffset=`${C*(1-Math.min(todayTotal/MAX_OUT_SECONDS,1))}`;
  ring.style.stroke=statusColor(todayTotal);
  if(sub) sub.textContent=`Today: ${fmtDur(todayTotal)} out`;
  renderStats(); renderAlert(todayTotal);
}

function renderAlert(todayTotal) {
  const el=document.getElementById('sw-alert'); if(!el) return;
  const rem=MAX_OUT_SECONDS-todayTotal;
  if(todayTotal>=WARN_SECONDS){el.className='alert-bar danger';el.innerHTML=`🚨 <strong>${fmtDur(todayTotal-MAX_OUT_SECONDS)} over limit</strong> — aligners back in!`;el.style.display='flex';}
  else if(todayTotal>=MAX_OUT_SECONDS){el.className='alert-bar warning';el.innerHTML=`⚠️ 2h limit reached — red zone in ${fmtDur(WARN_SECONDS-todayTotal)}.`;el.style.display='flex';}
  else if(rem<=900){el.className='alert-bar warning';el.innerHTML=`⚡ Only <strong>${fmtDur(rem)}</strong> left today.`;el.style.display='flex';}
  else if(state.running){el.className='alert-bar success';el.innerHTML=`▶ Running — <strong>${fmtDur(rem)}</strong> remaining today.`;el.style.display='flex';}
  else el.style.display='none';
}

function renderStats() {
  const tot=todayTotalSec()+(state.running?state.elapsed:0);
  const rem=Math.max(0,MAX_OUT_SECONDS-tot);
  const s7=state.sessions.filter(s=>(Date.now()-new Date(s.started_at).getTime())<7*86400000);
  const avg7=s7.length?Math.round(s7.reduce((a,b)=>a+b.duration_seconds,0)/7):0;
  const tEl=document.getElementById('stat-today'); const rEl=document.getElementById('stat-rem'); const aEl=document.getElementById('stat-avg');
  if(tEl){tEl.textContent=fmtDur(tot);tEl.className=`stat-val ${statColor(tot)}`;}
  if(rEl){rEl.textContent=rem>0?fmtDur(rem):'OVER';rEl.className=`stat-val ${remColor(rem)}`;}
  if(aEl) aEl.textContent=avg7?fmtDur(avg7):'—';
}

function renderSWButtons() {
  const btn=document.getElementById('sw-start-btn');
  const rst=document.getElementById('sw-reset-btn');
  if(!btn) return;
  if(state.running){
    btn.textContent='⏹ Stop & Log'; btn.className='sw-btn sw-btn-stop'; btn.onclick=stopTimer;
  } else {
    btn.textContent='▶ Start'; btn.className='sw-btn sw-btn-start'; btn.onclick=startTimer;
  }
  if(rst) rst.disabled=state.running||!state.canReset;
}

// ── Tray drum ──
function drumUp(id){state.draftTray=Math.min(TOTAL_TRAYS,state.draftTray+1);const el=document.getElementById(`${id}-val`);if(el){el.textContent=state.draftTray;el.style.transform='translateY(-3px)';setTimeout(()=>el.style.transform='',100);}}
function drumDown(id){state.draftTray=Math.max(1,state.draftTray-1);const el=document.getElementById(`${id}-val`);if(el){el.textContent=state.draftTray;el.style.transform='translateY(3px)';setTimeout(()=>el.style.transform='',100);}}
function trayDrumHTML(id){return `<div class="tray-drum" id="${id}"><button class="tray-drum-btn" onclick="app.drumDown('${id}')">−</button><div class="tray-drum-val" id="${id}-val">${state.draftTray}</div><button class="tray-drum-btn" onclick="app.drumUp('${id}')">+</button></div>`;}

async function saveTrayFromDrum(drumId) {
  const v=state.draftTray; await saveTray(v); closeModal();
  document.querySelectorAll('.sw-tray-lbl').forEach(el=>el.textContent=`#${v}`);
  document.querySelectorAll('.mobile-tray-btn').forEach(el=>el.innerHTML=`Tray #${v}`);
  renderSidebarTray();
}
function renderSidebarTray(){const el=document.getElementById('sidebar-drum-val');if(el)el.textContent=state.currentTray;}

// ── Modals ──
function openModal(html){closeModal();const o=document.createElement('div');o.className='modal-overlay';o.id='app-modal';o.innerHTML=`<div class="modal-sheet">${html}</div>`;o.onclick=e=>{if(e.target===o)closeModal();};document.body.appendChild(o);}
function closeModal(){document.getElementById('app-modal')?.remove();}

function openTrayModal(){
  state.draftTray=state.currentTray;
  openModal(`<h3>Current Tray</h3>${trayDrumHTML('modal-drum')}<div class="modal-row"><button class="modal-btn-primary" onclick="app.saveTrayFromDrum('modal-drum')">Save</button><button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button></div>`);
}

// ── Tray schedule setup modal ──
function openSetupModal() {
  openModal(`
    <h3>Set Up Tray Schedule</h3>
    <p style="font-size:13px;color:var(--text-2);margin-bottom:16px;">Enter when you started Tray 1. We'll calculate dates for all 36 trays automatically using 2 weeks for trays 1–3 and 1 week for trays 4–36. You can adjust any tray individually after.</p>
    <div class="form-group"><label class="form-label">Tray 1 Start Date</label>
      <input class="form-input" type="date" id="setup-start" value="${isoDateEST()}" max="${isoDateEST()}" /></div>
    <div class="modal-row">
      <button class="modal-btn-primary" onclick="app.submitSetup()">Generate Schedule</button>
      <button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button>
    </div>`);
}

async function submitSetup() {
  const start=document.getElementById('setup-start')?.value; if(!start) return;
  const schedule=buildDefaultSchedule(start);
  // Upsert all 36 rows
  const rows=Object.entries(schedule).map(([t,v])=>({tray_number:parseInt(t),start_date:v.start_date,days_to_wear:v.days_to_wear}));
  await db.from('tray_schedule').upsert(rows);
  state.traySchedule=schedule;
  closeModal(); render();
}

function openTrayScheduleModal(trayNum) {
  const t=trayNum||state.currentTray;
  const info=state.traySchedule[t]||{start_date:isoDateEST(),days_to_wear:defaultDaysForTray(t)};
  openModal(`
    <h3>Tray #${t} Schedule</h3>
    <div class="form-group"><label class="form-label">Start date</label>
      <input class="form-input" type="date" id="ts-start" value="${info.start_date}" /></div>
    <div class="form-group"><label class="form-label">Days to wear</label>
      <input class="form-input" type="number" id="ts-days" min="1" max="60" value="${info.days_to_wear}" /></div>
    <div class="modal-row">
      <button class="modal-btn-primary" onclick="app.saveTrayScheduleModal(${t})">Save</button>
      <button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button>
    </div>`);
}

async function saveTrayScheduleModal(trayNum) {
  const start=document.getElementById('ts-start')?.value;
  const days=parseInt(document.getElementById('ts-days')?.value)||defaultDaysForTray(trayNum);
  if(!start) return;
  await saveTrayScheduleRow(trayNum,start,days); closeModal(); render();
}

function openQuickAddModal() {
  const today=isoDateEST();
  openModal(`
    <h3>Add Past Session</h3>
    <p style="font-size:13px;color:var(--text-2);margin-bottom:16px;">Log a session you forgot to track.</p>
    <div class="form-group"><label class="form-label">Date</label>
      <input class="form-input" type="date" id="qa-date" value="${today}" max="${today}" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Start time</label><input class="form-input" type="time" id="qa-start" value="12:00" /></div>
      <div class="form-group"><label class="form-label">End time</label><input class="form-input" type="time" id="qa-end" value="12:30" /></div>
    </div>
    <div class="form-group"><label class="form-label">Meal (optional)</label>
      <select class="form-input" id="qa-meal">
        <option value="">None</option><option value="breakfast">Breakfast</option>
        <option value="lunch">Lunch</option><option value="dinner">Dinner</option><option value="other">Other</option>
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
  if(!date||!start||!end){if(errEl){errEl.textContent='Please fill all fields.';errEl.style.display='block';}return;}
  const sdt=new Date(`${date}T${start}:00`); const edt=new Date(`${date}T${end}:00`);
  const dur=Math.round((edt-sdt)/1000);
  if(dur<=0){if(errEl){errEl.textContent='End time must be after start time.';errEl.style.display='block';}return;}
  closeModal();
  await insertSession({started_at:sdt.toISOString(),ended_at:edt.toISOString(),duration_seconds:dur,date_est:date,
    time_est:sdt.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:true}),tray_number:state.currentTray,meal_tag:meal||null});
  refreshView();
}

function openNoteModal(dateEst) {
  const existing=state.notes[dateEst]||'';
  const display=new Date(dateEst+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  openModal(`
    <div class="note-date-header">${display}</div>
    <div class="form-group"><label class="form-label">Daily Note</label>
      <textarea class="note-textarea" id="note-text" placeholder="e.g. pain on right side, forgot at lunch, rubber band day…">${existing}</textarea></div>
    <div class="modal-row">
      <button class="modal-btn-primary" onclick="app.saveNoteModal('${dateEst}')">Save Note</button>
      ${existing?`<button class="modal-btn-cancel" style="color:var(--peach)" onclick="app.deleteNoteModal('${dateEst}')">Delete</button>`:''}
      <button class="modal-btn-cancel" onclick="app.closeModal()">Cancel</button>
    </div>`);
  setTimeout(()=>document.getElementById('note-text')?.focus(),50);
}

async function saveNoteModal(dateEst){const text=document.getElementById('note-text')?.value||'';await saveNote(dateEst,text);closeModal();if(state.view==='calendar')renderCalendar();if(state.view==='dashboard'){const el=document.getElementById('today-note');if(el)el.innerHTML=todayNoteHTML();}}
async function deleteNoteModal(dateEst){await saveNote(dateEst,'');closeModal();if(state.view==='calendar')renderCalendar();}

function todayNoteHTML(){
  const today=isoDateEST();
  if(state.notes[today]) return `<p style="font-size:13px;color:var(--text-2);line-height:1.6;">${state.notes[today]}</p><button class="tray-edit-btn" onclick="app.openNote('${today}')">Edit note</button>`;
  return `<p style="font-size:13px;color:var(--text-3);margin-bottom:10px;">No note for today.</p><button class="sw-btn sw-btn-quick" style="width:100%;padding:8px;" onclick="app.openNote('${today}')">+ Add Note</button>`;
}

// ── Toast ──
function showDeleteToast(id,label){hideToast();state.pendingDelete=id;const t=document.createElement('div');t.className='toast';t.id='delete-toast';t.innerHTML=`<span>Delete session on ${label}?</span><button class="toast-confirm" onclick="app.confirmDelete()">Delete</button><button class="toast-cancel" onclick="app.hideToast()">Cancel</button>`;document.body.appendChild(t);setTimeout(()=>{if(document.getElementById('delete-toast'))hideToast();},6000);}
function hideToast(){document.getElementById('delete-toast')?.remove();state.pendingDelete=null;}

// ── Refresh helpers ──
function refreshView() {
  if(state.view==='dashboard'){
    const rs=document.getElementById('recent-sessions'); if(rs) rs.innerHTML=recentSessionsHTML();
    updateSWDisplay();
  }
  if(state.view==='log')      renderLog();
  if(state.view==='graphs')   renderGraphs();
  if(state.view==='calendar') renderCalendar();
  if(state.view==='progress') renderProgress();
}

// ── Nav ──
const NAV=[
  {id:'dashboard',label:'Dashboard',icon:'⊞'},
  {id:'log',      label:'Log',      icon:'☰'},
  {id:'progress', label:'Progress', icon:'◎'},
  {id:'graphs',   label:'Graphs',   icon:'⌇'},
  {id:'calendar', label:'Calendar', icon:'▦'},
];

function sidebarHTML(){return `<aside class="sidebar">
  <div class="sidebar-logo"><h1>Invisalign</h1><p>22hr wear tracker</p></div>
  <div class="nav-label">Views</div>
  ${NAV.map(i=>`<div class="nav-item ${state.view===i.id?'active':''}" onclick="app.navigate('${i.id}')">${i.icon} ${i.label}</div>`).join('')}
  <div class="tray-badge"><label>Current Tray</label>${trayDrumHTML('sidebar-drum')}<button class="tray-save-btn" onclick="app.saveTrayFromDrum('sidebar-drum')">Save tray</button></div>
</aside>`;}

function mobileHeaderHTML(){return `<header class="mobile-header"><span class="mobile-header-title">Invisalign</span><button class="mobile-tray-btn" onclick="app.openTrayModal()">Tray #${state.currentTray}</button></header>`;}
function mobileNavHTML(){return `<nav class="mobile-nav"><div class="mobile-nav-inner">${NAV.map(i=>`<div class="mobile-nav-item ${state.view===i.id?'active':''}" onclick="app.navigate('${i.id}')"><span class="mob-icon">${i.icon}</span><span>${i.label}</span></div>`).join('')}</div></nav>`;}

// ── Dashboard ──
const MEAL_TAGS=['breakfast','lunch','dinner','other'];

function dashboardHTML(){
  const C=2*Math.PI*80;
  const todayTotal=todayTotalSec()+(state.running?state.elapsed:0);
  const ratio=Math.min(todayTotal/MAX_OUT_SECONDS,1);
  const rem=Math.max(0,MAX_OUT_SECONDS-todayTotal);
  const s7=state.sessions.filter(s=>(Date.now()-new Date(s.started_at).getTime())<7*86400000);
  const avg7=s7.length?Math.round(s7.reduce((a,b)=>a+b.duration_seconds,0)/7):0;
  const trayInfo=currentTrayInfo();
  const today=isoDateEST();
  const hasSchedule=Object.keys(state.traySchedule).length>0;

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
        <p class="sw-status">Tray <span class="sw-tray-lbl tray-lbl">#${state.currentTray}</span> &nbsp;·&nbsp;
          ${state.running?`<span class="running-lbl">Running since ${state.startedAt?.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:true,hour:'2-digit',minute:'2-digit'})}</span>`:'<span style="color:var(--text-3)">Stopped</span>'}
        </p>
        <p class="meal-tag-label">Tag this session (optional)</p>
        <div class="meal-tags">
          ${MEAL_TAGS.map(t=>`<div class="meal-tag ${state.activeMealTag===t?'active':''}" onclick="app.setMealTag('${t}')">${t.charAt(0).toUpperCase()+t.slice(1)}</div>`).join('')}
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

      ${trayInfo?`
      <div class="card">
        <div class="section-title">Tray Progress</div>
        <div class="tray-card">
          <div class="tray-ring">
            <svg width="72" height="72" viewBox="0 0 72 72">
              <circle cx="36" cy="36" r="28" fill="none" stroke="var(--bg-3)" stroke-width="7"/>
              <circle cx="36" cy="36" r="28" fill="none" stroke="var(--lavender)" stroke-width="7" stroke-linecap="round"
                stroke-dasharray="${2*Math.PI*28}" stroke-dashoffset="${2*Math.PI*28*(1-trayInfo.pct/100)}"
                transform="rotate(-90 36 36)"/>
            </svg>
            <div class="tray-pct">${trayInfo.pct}%</div>
          </div>
          <div class="tray-info">
            <h3>Tray #${state.currentTray} of ${TOTAL_TRAYS}</h3>
            <p>Day <strong>${trayInfo.daysOn}</strong> of ${trayInfo.daysToWear} &nbsp;·&nbsp; <strong style="color:${trayInfo.daysLeft<=2?'var(--peach)':trayInfo.daysLeft<=4?'var(--butter)':'var(--sage)'}">${trayInfo.daysLeft}d left</strong></p>
            <p style="font-size:12px;color:var(--text-3);margin-top:2px;">Change on ${new Date(trayInfo.endDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}</p>
            <button class="tray-edit-btn" onclick="app.openTrayScheduleModal(${state.currentTray})">Edit schedule</button>
          </div>
        </div>
      </div>`:`
      <div class="card">
        <div class="section-title">Tray Schedule</div>
        <p style="font-size:13px;color:var(--text-2);margin-bottom:12px;">${hasSchedule?`Tray #${state.currentTray} not configured yet.`:'Set up your tray schedule to see countdowns.'}</p>
        <button class="sw-btn sw-btn-quick" style="width:100%;padding:8px;" onclick="app.openTrayScheduleModal(${state.currentTray})">${hasSchedule?`Configure Tray #${state.currentTray}`:'Set Up Schedule'}</button>
        ${!hasSchedule?`<button class="sw-btn sw-btn-quick" style="width:100%;padding:8px;margin-top:8px;" onclick="app.openSetup()">Auto-generate All 36 Trays</button>`:''}
      </div>`}

      <div class="card" id="today-note-card">
        <div class="section-title">Today's Note</div>
        <div id="today-note">${todayNoteHTML()}</div>
      </div>

      <div class="card span-full">
        <div class="section-title">Recent Sessions</div>
        <div id="recent-sessions">${recentSessionsHTML()}</div>
      </div>
    </div>`;
}

function recentSessionsHTML(){
  const recent=state.sessions.slice(0,6);
  if(!recent.length) return `<p class="empty-state">No sessions yet. Hit Start!</p>`;
  return recent.map(s=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
      <div><span style="font-size:13px;color:var(--text);font-weight:500">${s.date_est}</span><span style="font-size:11px;color:var(--text-3);margin-left:8px;">${s.time_est||''}</span></div>
      <div style="display:flex;gap:7px;align-items:center;">
        ${s.meal_tag?`<span class="meal-pill">${s.meal_tag}</span>`:''}
        <span class="tray-pill">T${s.tray_number}</span>
        <span style="font-family:'DM Mono',monospace;font-size:13px;font-weight:600;color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</span>
        <button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')">✕</button>
      </div>
    </div>`).join('');
}

// ── Log ──
function renderLog(){
  const fv=(document.getElementById('log-filter')?.value||'').toLowerCase();
  let sessions=[...state.sessions];
  if(fv) sessions=sessions.filter(s=>s.date_est?.includes(fv)||String(s.tray_number).includes(fv)||(s.meal_tag||'').includes(fv));
  const rows=sessions.map(s=>`<tr>
    <td class="mono">${s.date_est||'—'}</td><td>${s.time_est||'—'}</td>
    <td class="mono" style="color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</td>
    <td><span class="tray-pill">T${s.tray_number}</span></td>
    <td>${s.meal_tag?`<span class="meal-pill">${s.meal_tag}</span>`:''}</td>
    <td><button class="delete-btn" onclick="app.askDelete('${s.id}','${s.date_est}')">✕</button></td>
  </tr>`).join('');
  const cards=sessions.map(s=>`<div class="log-card">
    <div class="log-card-left"><div class="log-card-date">${s.date_est||'—'}</div><div class="log-card-time">${s.time_est||''}${s.meal_tag?' · '+s.meal_tag:''}</div></div>
    <div class="log-card-right">
      <div class="log-card-dur" style="color:${statusColor(s.duration_seconds)}">${fmtDur(s.duration_seconds)}</div>
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
function renderProgress(){
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
        <p style="font-size:12px;color:var(--text-2)">${insight}</p>
      </div>
      <div class="card span-2">
        <div class="section-title">Compliance Score</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
          ${compBlockHTML('7-day',comp7)}${compBlockHTML('30-day',comp30)}
        </div>
      </div>
      <div class="card">
        <div class="section-title">Streaks</div>
        <div class="streak-badge"><div class="streak-num">${streak}</div><div class="streak-lbl">day${streak!==1?'s':''}<br>current streak</div></div>
        <p style="font-size:12px;color:var(--text-3)">Best ever: <strong style="color:var(--rose)">${best} day${best!==1?'s':''}</strong></p>
      </div>
      <div class="card">
        <div class="section-title">Day of Week</div>
        ${bestDay?`
          <div class="insight-row"><span class="insight-key">🏆 Best day</span><span class="insight-val c-sage">${bestDay.day} · ${fmtDur(bestDay.avg)}</span></div>
          <div class="insight-row"><span class="insight-key">⚠ Hardest day</span><span class="insight-val c-peach">${worstDay.day} · ${fmtDur(worstDay.avg)}</span></div>`
          :'<p style="font-size:13px;color:var(--text-3)">Need more sessions to show patterns.</p>'}
      </div>
      <div class="card">
        <div class="section-title">All-time Stats</div>
        ${allTimeHTML()}
      </div>
      <div class="card span-full">
        <div class="section-title">30-day Compliance</div>
        <div class="chart-wrap" style="height:150px;"><canvas id="chart-comp"></canvas></div>
      </div>
    </div>`;
  drawCompChart();
}

function compBlockHTML(label,pct){
  if(pct===null) return `<div><div style="font-size:11px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;font-weight:700">${label}</div><div style="font-size:28px;color:var(--text-3);font-family:'DM Mono',monospace">—</div></div>`;
  const col=pct>=90?'var(--sage)':pct>=70?'var(--butter)':'var(--peach)';
  return `<div>
    <div style="font-size:11px;color:var(--text-3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.07em;font-weight:700">${label}</div>
    <div style="font-size:32px;font-family:'DM Mono',monospace;color:${col};margin-bottom:8px;font-weight:500">${pct}%</div>
    <div class="compliance-bar-track"><div class="compliance-bar-fill" style="width:${pct}%;background:${col}"></div></div>
  </div>`;
}

function allTimeHTML(){
  const total=state.sessions.reduce((a,b)=>a+b.duration_seconds,0);
  const count=state.sessions.length;
  const avg=count?Math.round(total/count):0;
  const byDate={};
  state.sessions.forEach(s=>{if(s.date_est)byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;});
  const best=Object.values(byDate).length?Math.min(...Object.values(byDate)):0;
  return `
    <div class="insight-row"><span class="insight-key">Total sessions</span><span class="insight-val c-sky">${count}</span></div>
    <div class="insight-row"><span class="insight-key">Total out-time</span><span class="insight-val c-lavender">${fmtDur(total)}</span></div>
    <div class="insight-row"><span class="insight-key">Avg per session</span><span class="insight-val">${avg?fmtDur(avg):'—'}</span></div>
    <div class="insight-row"><span class="insight-key">Best day</span><span class="insight-val c-sage">${best?fmtDur(best):'—'}</span></div>`;
}

function drawCompChart(){
  const byDate={};
  state.sessions.forEach(s=>{if(s.date_est)byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;});
  const labels=[],data=[],colors=[];
  for(let i=29;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const ds=isoDateEST(d);labels.push(ds.slice(5));const sec=byDate[ds]||0;data.push(Math.round(sec/60));colors.push(sec===0?'rgba(0,0,0,0.06)':sec>=WARN_SECONDS?'rgba(217,123,108,0.7)':sec>=MAX_OUT_SECONDS?'rgba(212,168,67,0.7)':'rgba(107,191,142,0.7)');}
  if(state.charts.comp)state.charts.comp.destroy();
  state.charts.comp=new Chart(document.getElementById('chart-comp'),{type:'bar',
    data:{labels,datasets:[{data,backgroundColor:colors,borderRadius:3}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.raw}m`}}},
      scales:{x:{ticks:{color:'#A0A0AE',font:{size:9},maxRotation:0,maxTicksLimit:10},grid:{color:'rgba(0,0,0,0.04)'}},
              y:{ticks:{color:'#A0A0AE',callback:v=>`${v}m`},grid:{color:'rgba(0,0,0,0.05)'}}},
      responsive:true,maintainAspectRatio:false}});
}

// ── Graphs ──
function renderGraphs(){
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

function drawCharts(){
  const last30={};
  for(let i=29;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);last30[isoDateEST(d)]=0;}
  state.sessions.forEach(s=>{if(last30.hasOwnProperty(s.date_est))last30[s.date_est]+=s.duration_seconds/60;});
  const l30=Object.keys(last30).map(d=>{const[,m,day]=d.split('-');return`${parseInt(m)}/${parseInt(day)}`;});
  const d30=Object.values(last30);
  const bc=v=>v>WARN_SECONDS/60?'rgba(217,123,108,0.75)':v>MAX_OUT_SECONDS/60?'rgba(212,168,67,0.75)':'rgba(107,191,142,0.7)';
  const chartOpts={plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${Math.round(ctx.raw)}m`}}},scales:{x:{ticks:{color:'#A0A0AE',font:{size:9},maxRotation:0},grid:{color:'rgba(0,0,0,0.04)'}},y:{ticks:{color:'#A0A0AE',callback:v=>`${v}m`},grid:{color:'rgba(0,0,0,0.05)'}}},responsive:true,maintainAspectRatio:false};
  if(state.charts.daily)state.charts.daily.destroy();
  state.charts.daily=new Chart(document.getElementById('chart-daily'),{type:'bar',data:{labels:l30,datasets:[{data:d30,backgroundColor:d30.map(bc),borderRadius:3}]},options:chartOpts});

  const dow=Array(7).fill(null).map(()=>({t:0,c:0}));
  const byDate={};
  state.sessions.forEach(s=>{if(s.date_est)byDate[s.date_est]=(byDate[s.date_est]||0)+s.duration_seconds;});
  Object.entries(byDate).forEach(([d,sec])=>{const day=new Date(d+'T12:00:00').getDay();dow[day].t+=sec;dow[day].c++;});
  if(state.charts.dow)state.charts.dow.destroy();
  state.charts.dow=new Chart(document.getElementById('chart-dow'),{type:'bar',
    data:{labels:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],datasets:[{data:dow.map(d=>d.c?Math.round(d.t/d.c/60):0),backgroundColor:'rgba(91,175,214,0.65)',borderRadius:3}]},
    options:{...chartOpts,plugins:{...chartOpts.plugins,tooltip:{callbacks:{label:ctx=>`${ctx.raw}m avg`}}}}});

  const buckets={'<15m':0,'15–30m':0,'30–60m':0,'60–90m':0,'>90m':0};
  state.sessions.forEach(s=>{const m=s.duration_seconds/60;if(m<15)buckets['<15m']++;else if(m<30)buckets['15–30m']++;else if(m<60)buckets['30–60m']++;else if(m<90)buckets['60–90m']++;else buckets['>90m']++;});
  if(state.charts.dist)state.charts.dist.destroy();
  state.charts.dist=new Chart(document.getElementById('chart-dist'),{type:'doughnut',
    data:{labels:Object.keys(buckets),datasets:[{data:Object.values(buckets),backgroundColor:['rgba(107,191,142,0.8)','rgba(91,175,214,0.75)','rgba(155,142,196,0.75)','rgba(212,168,67,0.75)','rgba(217,123,108,0.8)'],borderWidth:0}]},
    options:{plugins:{legend:{labels:{color:'#6B6B7A',font:{size:11}}}},responsive:true,maintainAspectRatio:false,cutout:'58%'}});

  const mc={breakfast:0,lunch:0,dinner:0,other:0,none:0};
  state.sessions.forEach(s=>{const tag=s.meal_tag&&mc.hasOwnProperty(s.meal_tag)?s.meal_tag:'none';mc[tag]++;});
  const ml=Object.keys(mc).filter(k=>mc[k]>0);
  if(state.charts.meal)state.charts.meal.destroy();
  state.charts.meal=new Chart(document.getElementById('chart-meal'),{type:'doughnut',
    data:{labels:ml,datasets:[{data:ml.map(k=>mc[k]),backgroundColor:['rgba(212,168,67,0.8)','rgba(107,191,142,0.8)','rgba(217,123,108,0.8)','rgba(155,142,196,0.75)','rgba(160,160,174,0.5)'],borderWidth:0}]},
    options:{plugins:{legend:{labels:{color:'#6B6B7A',font:{size:11}}}},responsive:true,maintainAspectRatio:false,cutout:'58%'}});
}

// ── Calendar ──
function renderCalendar(){
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
function render(){
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
  else if(state.view==='log')      renderLog();
  else if(state.view==='progress') renderProgress();
  else if(state.view==='graphs')   renderGraphs();
  else if(state.view==='calendar') renderCalendar();
}

// ── Public API ──
window.app={
  start:startTimer, stop:stopTimer, reset:resetTimer,
  navigate(v){state.view=v;render();},
  filterLog(){renderLog();},
  calPrev(){state.calMonth--;if(state.calMonth<0){state.calMonth=11;state.calYear--;}renderCalendar();},
  calNext(){state.calMonth++;if(state.calMonth>11){state.calMonth=0;state.calYear++;}renderCalendar();},
  drumUp,drumDown,saveTrayFromDrum,
  openTrayModal,closeModal,
  openSetup:openSetupModal,
  submitSetup,
  openTrayScheduleModal,
  saveTrayScheduleModal,
  openQuickAdd:openQuickAddModal,
  submitQuickAdd,
  openNote:openNoteModal,
  saveNoteModal,
  deleteNoteModal,
  askDelete:showDeleteToast,
  confirmDelete(){if(state.pendingDelete)deleteSession(state.pendingDelete);},
  hideToast,
  setMealTag(tag){
    state.activeMealTag=state.activeMealTag===tag?null:tag;
    document.querySelectorAll('.meal-tag').forEach(el=>{
      const t=el.textContent.toLowerCase();
      el.classList.toggle('active',t===tag&&state.activeMealTag===tag);
    });
  },
};

// ── Boot ──
async function init(){
  try{ await loadAll(); restoreTimer(); render(); }
  catch(e){
    document.getElementById('app').innerHTML=`<div style="text-align:center;padding:60px;color:var(--peach);"><p>⚠ Could not connect to Supabase.</p><p style="font-size:13px;color:var(--text-2);margin-top:8px;">Check config.js credentials.</p></div>`;
    console.error(e);
  }
}
init();
