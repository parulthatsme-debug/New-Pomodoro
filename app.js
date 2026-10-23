(() => {
"use strict";
const $ = id => document.getElementById(id);
const TZ = "Asia/Kolkata";
const DB_KEY = "aiapget-clock-pomodoro-v1";
const CLIENT_KEY = "aiapget-clock-drive-client-id-v1";
const DUR_KEY = "aiapget-clock-last-duration-v2";
const BREAK_DURS = {short:15,long:60};
const CIRC = 2 * Math.PI * 174;
let db = null, breakType = "short", analyticsRange = "day", driveToken = null, tokenClient = null;
let lastSavedHash = "", tickHandle = null, cloudTimer = null;
let alarmContext = null;
const fmtDateKey = d => new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
function nowMs(){ return Date.now(); }
function nowDateLocalInput(){ // local display in India timezone for datetime-local fields
  const parts = new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date()).replace(" ","T");
  return parts.slice(0,16);
}
function indiaParts(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB",{timeZone:TZ,weekday:"short",day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(date);
  return Object.fromEntries(p.map(x=>[x.type,x.value]));
}
function indiaInputToMs(val) {
  if(!val) return NaN;
  // Convert the supplied wall-clock time in Asia/Kolkata to a UTC epoch.
  const [dt,hm] = val.split("T"); if(!dt || !hm) return NaN;
  const [y,m,d] = dt.split("-").map(Number), [h,mi] = hm.split(":").map(Number);
  return Date.UTC(y,m-1,d,h,mi,0) - (5*60+30)*60000;
}
function fmtClock(ms, seconds=false) {
  if(!ms) return "—";
  return new Intl.DateTimeFormat("en-IN",{timeZone:TZ,hour:"2-digit",minute:"2-digit",...(seconds?{second:"2-digit"}:{}),hour12:true}).format(new Date(ms));
}
function fmtStamp(ms) {
  if(!ms) return "—";
  return new Intl.DateTimeFormat("en-IN",{timeZone:TZ,day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:true}).format(new Date(ms));
}
function fmtLongDate(ms) {
  return new Intl.DateTimeFormat("en-IN",{timeZone:TZ,weekday:"short",day:"2-digit",month:"short",year:"numeric"}).format(new Date(ms));
}
function fmtDuration(mins) {
  mins = Math.max(0,Math.round(mins||0));
  return `${Math.floor(mins/60)}h ${mins%60}m`;
}
function mmss(ms) {
  const s = Math.max(0,Math.ceil(ms/1000));
  return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
}
function safeNum(v, def=0){const n=Number(v);return Number.isFinite(n)?n:def}
function blankDb() {
 return {version:1,sessions:[],breaks:[],timer:{state:"idle",duration:60,remainingMs:60*60000,startedAt:null,deadline:null,sessionId:null,elapsedBefore:0},breakSchedule:null,breakState:null,dailyTargetHours:7,logs:[],backupSnapshots:[],lastLocalBackupDate:null,createdAt:nowMs(),updatedAt:nowMs()};
}
function loadDb(){
 try { const parsed=JSON.parse(localStorage.getItem(DB_KEY)||"null"); if(parsed&&typeof parsed==="object") { const base=blankDb(); db={...base,...parsed,timer:{...base.timer,...(parsed.timer||{})}}; if(!Array.isArray(db.sessions))db.sessions=[];if(!Array.isArray(db.breaks))db.breaks=[];if(!Array.isArray(db.backupSnapshots))db.backupSnapshots=[]; return; } } catch(e){}
 db=blankDb();
}
function serialize(){return JSON.stringify(db);}
function localSnapshot(){
 const day=fmtDateKey(new Date());
 if(db.lastLocalBackupDate !== day) {
   db.backupSnapshots.unshift({date:day,at:nowMs(),data:JSON.parse(JSON.stringify({...db,backupSnapshots:[]}))});
   db.backupSnapshots=db.backupSnapshots.slice(0,30);
   db.lastLocalBackupDate=day;
 }
}
function persist({cloud=true}={}) {
 if(!db)return;
 db.updatedAt=nowMs();
 localSnapshot();
 const serial=serialize();
 try {
   localStorage.setItem(DB_KEY,serial);
   lastSavedHash=serial;
   $("saveBadge").textContent="AUTO-SAVED";
   $("localStatus").textContent="Last saved "+fmtClock(nowMs());
   $("saveBadge").className="status-pill status-green";
 } catch(e) {
   $("saveBadge").textContent="STORAGE ISSUE";
   $("saveBadge").className="status-pill";
   toast("Browser storage is full or unavailable. Export a backup.");
 }
 updateLocalBackupList();
 renderTopMetrics(); renderHistory(); renderAnalytics();
 if(cloud) queueDriveSync();
}
function toast(msg) {const el=$("toast");el.textContent=msg;el.classList.add("show");clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.remove("show"),2600);}
function buildDial() {
 const ticks=$("ticks"), labels=$("labels"); ticks.innerHTML="";labels.innerHTML="";
 for(let i=0;i<60;i++){
   const a=(i*6-90)*Math.PI/180, major=i%5===0;
   const r1=major?185:190, r2=major?207:199;
   const x1=250+Math.cos(a)*r1,y1=250+Math.sin(a)*r1,x2=250+Math.cos(a)*r2,y2=250+Math.sin(a)*r2;
   const line=document.createElementNS("http://www.w3.org/2000/svg","line");
   line.setAttribute("x1",x1);line.setAttribute("y1",y1);line.setAttribute("x2",x2);line.setAttribute("y2",y2);line.setAttribute("class","dial-tick"+(major?" major":""));ticks.appendChild(line);
   if(major){
     const text=document.createElementNS("http://www.w3.org/2000/svg","text");
     const labelAngle=(-i*6-90)*Math.PI/180; const rt=222, lx=250+Math.cos(labelAngle)*rt,ly=250+Math.sin(labelAngle)*rt+7;
     text.setAttribute("x",lx);text.setAttribute("y",ly);text.setAttribute("text-anchor","middle");text.setAttribute("class","dial-label");
     text.textContent=String(i).padStart(2,"0");labels.appendChild(text);
   }
 }
 $("pomodoroProgress").setAttribute("stroke-dasharray",CIRC);
}
function rotateLine(id,angle){$(id).setAttribute("transform",`rotate(${angle} 250 250)`);}
function renderRealClock() {
 const p=indiaParts(new Date());
 $("weekday").textContent=p.weekday.toUpperCase();
 $("month").textContent=p.month.toUpperCase();
 $("dayNumber").textContent=p.day;
 $("year").textContent=p.year;
 const h=Number(p.hour)%12, m=Number(p.minute), s=Number(p.second);
 rotateLine("hourHand",h*30+m*.5+s/120);
 rotateLine("minuteHand",m*6+s*.1);
 rotateLine("secondHand",s*6);
}
function getActiveSession(){ const id=db.timer.sessionId; return id?db.sessions.find(s=>s.id===id):null; }
function elapsedMs(t, now=nowMs()){
 if(t.state==="running"&&t.startedAt) return Math.max(0,(t.elapsedBefore||0)+now-t.startedAt);
 return Math.max(0,t.elapsedBefore||0);
}
function remainingMs(t, now=nowMs()){
 if(t.state==="running"&&t.deadline) return Math.max(0,t.deadline-now);
 if(t.state==="paused") return Math.max(0,t.remainingMs||0);
 return Math.max(0,t.remainingMs||0);
}
function setDialProgress(pct){
 pct=Math.max(0,Math.min(1,pct));
 $("pomodoroProgress").setAttribute("stroke-dashoffset",String(CIRC*(1-pct)));
}
function updateTimerView() {
 const t=db.timer, now=nowMs();
 let display=""; let pct=0; let dialElapsedMs=0; let hint="Set your duration, then start.";
 if(t.state==="running") {
   const remain=remainingMs(t,now), elapsed=Math.min(t.duration*60000,elapsedMs(t,now));
   display=mmss(remain);pct=t.duration?elapsed/(t.duration*60000):0;dialElapsedMs=elapsed;hint=`Session #${getActiveSession()?.number||"—"} · focused time`;
   if(remain<=0){finishSession("completed","Timer completed");return;}
 } else if(t.state==="paused") {
   const remain=Math.max(0,t.remainingMs||0), elapsed=Math.min(t.duration*60000,elapsedMs(t,now));
   display=mmss(remain);pct=t.duration?elapsed/(t.duration*60000):0;dialElapsedMs=elapsed;hint="Timer paused · resume when ready.";
 } else if(t.state==="break") {
   const b=db.breakState,remain=b?Math.max(0,b.endAt-now):0;
   const breakDurationMs=b?Math.max(0,b.endAt-b.startAt):safeNum(t.duration,60)*60000;
   const elapsed=Math.max(0,breakDurationMs-remain);
   display=mmss(remain);pct=breakDurationMs?elapsed/breakDurationMs:0;dialElapsedMs=elapsed;hint=b?`${b.type==="short"?"Short":"Long"} break · auto-resume at ${fmtClock(b.endAt)}`:"Break in progress";
   if(remain<=0){finishBreak();return;}
 } else {
   display=mmss(safeNum(t.duration,60)*60000);pct=0;dialElapsedMs=0;hint="Set your duration, then start.";
 }
 // The red ring is a real minute scale: 00 at the top, increasing counter-clockwise to 55.
 // One complete revolution represents 60 elapsed minutes; the normal clock hands remain clockwise.
 $("timerDisplay").textContent=display;$("dialTimerText").textContent=display;
 const dialPct=Math.min(1,Math.max(0,dialElapsedMs/(60*60000)));
 setDialProgress(dialPct);$("timerProgress").style.width=(Math.min(1,Math.max(0,pct))*100)+"%";$("elapsedLabel").textContent=Math.round(Math.min(1,Math.max(0,pct))*100)+"% elapsed";$("timerHint").textContent=hint;
 const isFocus=t.state==="running",isPaused=t.state==="paused",isBreak=t.state==="break";
 $("startPauseText").textContent=isFocus?"Pause focus":isPaused?"Resume focus":isBreak?"Focus is on break":"Start focus";
 $("startPauseIcon").textContent=isFocus?"Ⅱ":isPaused?"▶":isBreak?"☕":"▶";
 $("startPauseBtn").disabled=isBreak;
 $("modeTitle").textContent=isFocus?"Focus in progress":isPaused?"Session paused":isBreak?"Rest & recharge":"Ready to focus?";
 $("modeEyebrow").textContent=isBreak?"SCHEDULED BREAK":isPaused?"POMODORO PAUSED":"POMODORO SESSION";
 $("modeDot").className="mode-dot "+(isFocus?"focus":isBreak?"break":"");
 $("clockStatus").textContent=isFocus?"REAL CLOCK · POMODORO RUNNING":isBreak?"REAL CLOCK · BREAK RUNNING":"REAL TIME · ASIA/KOLKATA";
 $("skipBreakBtn").hidden=!isBreak;$("stopSessionBtn").disabled=!(isFocus||isPaused);
 const s=getActiveSession();
 $("activeSessionBadge").textContent=isFocus?`SESSION #${s?.number||"—"} RUNNING`:isPaused?"SESSION PAUSED":isBreak?"ON BREAK":"NO ACTIVE SESSION";
 $("activeSessionTitle").textContent=isFocus?`Session #${s?.number||"—"} · Focus in progress`:isPaused?`Session #${s?.number||"—"} · Paused`:isBreak?"Break active":`Session #${db.sessions.length+1} ready`;
 const breakState=db.breakState;
 const breakElapsed=breakState?Math.max(0,now-breakState.startAt)/60000:0;
 $("activeSessionElapsed").textContent=isFocus?`${fmtDuration(elapsedMs(t,now)/60000)} elapsed`:isPaused?`${fmtDuration(elapsedMs(t,now)/60000)} elapsed`:isBreak?`${fmtDuration(breakElapsed)} elapsed`:"Not started";
 $("activeSessionStrip").querySelector(".active-pulse").classList.toggle("running",isFocus||isBreak);
 const sch=db.breakSchedule;
 if(sch&&sch.status==="scheduled"){
   $("nextBreakNote").innerHTML=`<span class="mini-icon">◷</span><span>${sch.type==="short"?"Short":"Long"} break at ${fmtClock(sch.startAt)} · ${BREAK_DURS[sch.type]} min</span>`;
 }else if(isBreak) $("nextBreakNote").innerHTML=`<span class="mini-icon">☕</span><span>Break ends at ${fmtClock(db.breakState?.endAt)} · automatic resume is enabled</span>`;
 else $("nextBreakNote").innerHTML=`<span class="mini-icon">◷</span><span>No break scheduled yet.</span>`;
}
function newId(){return (crypto.randomUUID?crypto.randomUUID():String(nowMs())+Math.random().toString(36).slice(2));}
function startFocus(durationArg=null, automatic=false) {
 const t=db.timer;
 if(t.state==="running")return;
 if(t.state==="break"){toast("End the active break to start focus.");return;}
 const duration=Math.max(1,Math.min(240,Math.round(durationArg||safeNum($("durationMinutes").value,60))));
 $("durationMinutes").value=duration;localStorage.setItem(DUR_KEY,String(duration));
 const start=nowMs(), id=newId(), number=db.sessions.length?Math.max(...db.sessions.map(s=>s.number||0))+1:1;
 const sess={id,number,startAt:start,plannedEndAt:start+duration*60000,actualEndAt:null,plannedMinutes:duration,actualMinutes:0,activeDurationMs:0,lastSegmentStartAt:start,status:"running",endReason:null,autoStarted:!!automatic};
 db.sessions.push(sess);
 Object.assign(t,{state:"running",duration,remainingMs:duration*60000,startedAt:start,deadline:start+duration*60000,sessionId:id,elapsedBefore:0});
 persist(); updateTimerView();toast(automatic?"Break finished · focus resumed":"Pomodoro started");
}
function finalizeSession(status,reason,endAt=nowMs()) {
 const t=db.timer, s=getActiveSession(); if(!s)return;
 s.actualEndAt=endAt;
 const activeMs=(s.activeDurationMs||0)+(t.state==="running"&&t.startedAt?Math.max(0,endAt-t.startedAt):0);
 s.activeDurationMs=activeMs;s.actualMinutes=Math.max(0,activeMs/60000);
 s.status=status;s.endReason=reason;
 s.elapsedBefore=s.actualMinutes*60000;
 Object.assign(t,{state:"idle",remainingMs:t.duration*60000,startedAt:null,deadline:null,sessionId:null,elapsedBefore:0});
}
function finishSession(status="completed",reason="Timer completed",endAt=nowMs()) {
 if(db.timer.state==="running"||db.timer.state==="paused") finalizeSession(status,reason,endAt);
 if(status==="completed") playAlarm("focus");
 persist();updateTimerView();toast(status==="completed"?"Focus session completed":"Session ended: "+reason);
}
function pauseFocus() {
 const t=db.timer;if(t.state!=="running")return;
 const now=nowMs();t.remainingMs=Math.max(0,t.deadline-now);t.elapsedBefore+=Math.max(0,now-t.startedAt);t.state="paused";t.startedAt=null;t.deadline=null;
 const s=getActiveSession();if(s){s.activeDurationMs=(s.activeDurationMs||0)+Math.max(0,now-(s.lastSegmentStartAt||s.startAt));s.status="paused";s.pausedAt=now;}
 persist();updateTimerView();toast("Focus paused");
}
function resumeFocus(){const t=db.timer;if(t.state!=="paused")return;const now=nowMs(),s=getActiveSession();t.state="running";t.startedAt=now;t.deadline=now+t.remainingMs;if(s){s.status="running";s.resumedAt=now;s.lastSegmentStartAt=now;s.plannedEndAt=t.deadline;}persist();updateTimerView();toast("Focus resumed");}
function cancelCurrentSession() {if(db.timer.state!=="running"&&db.timer.state!=="paused")return;finishSession("interrupted","Manual stop");}
function startBreak(type, startAt=nowMs(), scheduled=false) {
 const existing=db.breakState;if(existing)return;
 if(db.timer.state==="running"||db.timer.state==="paused") finalizeSession("interrupted",scheduled?"Scheduled break":"Manual break",startAt);
 const mins=BREAK_DURS[type], begin=Math.max(startAt,nowMs()),endAt=begin+mins*60000;
 const b={id:newId(),type,startAt:begin,plannedStartAt:startAt,endAt,plannedMinutes:mins,actualEndAt:null,actualMinutes:0,status:"running",scheduled:!!scheduled,manualEnd:false};
 db.breaks.push(b);db.breakState=b;
 Object.assign(db.timer,{state:"break",startedAt:null,deadline:null,sessionId:null,remainingMs:mins*60000,duration:mins,elapsedBefore:0});
 if(db.breakSchedule&&db.breakSchedule.status==="scheduled")db.breakSchedule.status="started";
 persist();updateTimerView();playAlarm("break");toast(`${type==="short"?"Short":"Long"} break started`);
}
function finishBreak(manual=false) {
 const b=db.breakState;if(!b)return;
 const end=manual?nowMs():Math.min(nowMs(),b.endAt);b.actualEndAt=end;b.actualMinutes=Math.max(0,(end-b.startAt)/60000);b.status=manual?"ended early":"completed";b.manualEnd=manual;
 db.breakState=null;db.timer.state="idle";db.timer.remainingMs=db.timer.duration*60000;
 if(db.breakSchedule&&db.breakSchedule.status==="started")db.breakSchedule.status="completed";
 persist();playAlarm("resume");startFocus(safeNum($("durationMinutes").value,safeNum(localStorage.getItem(DUR_KEY),60)),true);
}
function startScheduledBreak(sch) {
 if(!sch||sch.status!=="scheduled"||nowMs()<sch.startAt)return;
 // If page was reopened after the scheduled moment, begin it now (never claim background execution).
 sch.status="started";sch.actualStartDetectedAt=nowMs();startBreak(sch.type,sch.startAt,true);
}
function processSchedule() {
 const sch=db.breakSchedule;if(!sch||sch.status!=="scheduled")return;
 if(nowMs()>=sch.startAt) { startScheduledBreak(sch);renderSchedule(); }
}
function renderSchedule(){
 const s=db.breakSchedule;
 $("scheduleStatus").textContent=s?.status==="scheduled"?"SCHEDULED":s?.status==="started"?"BREAK STARTED":s?.status==="completed"?"COMPLETED":"NOT SCHEDULED";
 $("cancelBreakBtn").disabled=!s||!["scheduled","started"].includes(s.status);
 $("scheduledBreakCard").hidden=!s;
 if(s){$("scheduledBreakCard").textContent=`${s.type==="short"?"Short break":"Long break"} · ${fmtLongDate(s.startAt)} at ${fmtClock(s.startAt)} · ${s.status}`;}
}
function scheduleBreak(){
 const val=$("breakStart").value,at=indiaInputToMs(val);
 if(!Number.isFinite(at)){toast("Choose a break start date and time.");return;}
 if(at<=nowMs()){toast("Choose a future break start time.");return;}
 const type=breakType;
 db.breakSchedule={id:newId(),type,startAt:at,status:"scheduled",createdAt:nowMs()};
 $("cancelBreakBtn").disabled=false;persist();renderSchedule();updateTimerView();toast(`${type==="short"?"Short":"Long"} break scheduled`);
}
function cancelSchedule(){
 if(!db.breakSchedule)return;
 if(db.breakSchedule.status==="started"&&db.breakState){toast("A break is already running. Use End break & resume to override.");return;}
 db.breakSchedule.status="cancelled";persist();renderSchedule();updateTimerView();toast("Break schedule cancelled");
}
function playAlarm(kind) {
 try {const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;alarmContext=alarmContext||new AC();if(alarmContext.state==="suspended")alarmContext.resume();const freqs=kind==="break"?[660,880]:kind==="focus"?[880,660,880]:[523,784];let delay=0;freqs.forEach(f=>{const o=alarmContext.createOscillator(),g=alarmContext.createGain();o.frequency.value=f;o.type="sine";g.gain.setValueAtTime(.0001,alarmContext.currentTime+delay);g.gain.exponentialRampToValueAtTime(.13,alarmContext.currentTime+delay+.03);g.gain.exponentialRampToValueAtTime(.0001,alarmContext.currentTime+delay+.2);o.connect(g);g.connect(alarmContext.destination);o.start(alarmContext.currentTime+delay);o.stop(alarmContext.currentTime+delay+.22);delay+=.24;});}catch(e){}
}
function getSessionsInRange(range, endDate=new Date()) {
 const endKey=fmtDateKey(endDate);
 let startMs;
 if(range==="day") startMs=indiaInputToMs(endKey+"T00:00");
 else if(range==="week"){const d=new Date(endDate);d.setDate(d.getDate()-6);startMs=indiaInputToMs(fmtDateKey(d)+"T00:00");}
 else {const p=indiaParts(endDate);startMs=indiaInputToMs(`${p.year}-${String(new Date(endDate).toLocaleString("en-US",{timeZone:TZ,month:"2-digit"})).padStart(2,"0")}-01T00:00`); // replaced below with India calendar month start
   const dt=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit"}).format(endDate);startMs=indiaInputToMs(dt+"-01T00:00");
 }
 return db.sessions.filter(s=>s.startAt>=startMs&&s.startAt<=endDate.getTime()&&(range!=="day"||fmtDateKey(new Date(s.startAt))===endKey));
}
function rangeStartEnd(range, ref=new Date()){
 const key=fmtDateKey(ref);
 if(range==="day")return {start:indiaInputToMs(key+"T00:00"),end:indiaInputToMs(key+"T23:59")};
 if(range==="week"){const d=new Date(ref);d.setDate(d.getDate()-6);return {start:indiaInputToMs(fmtDateKey(d)+"T00:00"),end:ref.getTime()};}
 const monthKey=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit"}).format(ref);
 return {start:indiaInputToMs(monthKey+"-01T00:00"),end:ref.getTime()};
}
function sessionFocusMs(s, now=nowMs()) {
 if(s.actualEndAt!==null&&s.actualEndAt!==undefined) return Math.max(0,(s.activeDurationMs??(Number(s.actualMinutes||0)*60000)));
 if(s.status==="running"&&db.timer.sessionId===s.id&&db.timer.state==="running") return Math.max(0,(s.activeDurationMs||0)+now-(db.timer.startedAt||now));
 if(s.status==="paused"&&db.timer.sessionId===s.id) return Math.max(0,s.activeDurationMs||0);
 return Math.max(0,Number(s.activeDurationMs??(Number(s.actualMinutes||0)*60000)));
}
function calcRangeStats(range) {
 const bounds=rangeStartEnd(range), now=nowMs();
 const sessions=db.sessions.filter(s=>s.startAt>=bounds.start&&s.startAt<=bounds.end);
 const breaks=db.breaks.filter(b=>b.startAt>=bounds.start&&b.startAt<=bounds.end);
 const focusMs=sessions.reduce((sum,s)=>sum+sessionFocusMs(s,now),0);
 const plannedMs=sessions.reduce((sum,s)=>sum+(s.plannedMinutes||0)*60000,0);
 const completed=sessions.filter(s=>s.status==="completed").length;
 const interrupted=sessions.filter(s=>s.status==="interrupted").length;
 const breakMs=breaks.reduce((sum,b)=>sum+Math.max(0,(b.actualEndAt||now)-b.startAt),0);
 let targetMs=0;
 if(range==="day") targetMs=db.dailyTargetHours*3600000;
 else if(range==="week")targetMs=db.dailyTargetHours*7*3600000;
 else { const dt=new Date(now);const p=indiaParts(dt);const [year,month]=[Number(p.year),Number(new Intl.DateTimeFormat("en-CA",{timeZone:TZ,month:"2-digit"}).format(dt))];const day=Number(p.day);targetMs=db.dailyTargetHours*day*3600000; }
 return {sessions,breaks,focusMs,plannedMs,completed,interrupted,breakMs,targetMs,goalPct:targetMs?Math.min(999,focusMs/targetMs*100):0};
}
function renderTopMetrics(){
 const day=calcRangeStats("day");
 $("metricSessions").textContent=day.completed;
 $("metricSessionsSub").textContent=day.interrupted?`${day.interrupted} interrupted`:"Completed focus sessions";
 $("metricFocus").textContent=fmtDuration(day.focusMs/60000);
 $("metricFocusSub").textContent=`Target: ${fmtDuration(db.dailyTargetHours*60)}`;
 $("metricBreak").textContent=fmtDuration(day.breakMs/60000);
 $("metricBreakSub").textContent=`${day.breaks.length} break record(s)`;
 $("metricTarget").textContent=Math.round(day.focusMs/day.targetMs*100||0)+"%";
 $("metricTargetSub").textContent=`${fmtDuration(day.focusMs/60000)} of ${fmtDuration(db.dailyTargetHours*60)}`;
}
function renderHistory(){
 const filter=$("historyFilter").value,now=nowMs();
 let start=0;if(filter==="today")start=indiaInputToMs(fmtDateKey(new Date())+"T00:00");else if(filter==="7days")start=now-7*86400000;else if(filter==="30days")start=now-30*86400000;
 const list=db.sessions.filter(s=>s.startAt>=start).slice().sort((a,b)=>b.startAt-a.startAt);
 const tbody=$("sessionTable");
 if(!list.length)tbody.innerHTML='<tr><td colspan="6" class="empty-cell">No sessions in this range yet.</td></tr>';
 else tbody.innerHTML=list.map(s=>`<tr><td>${s.number||"—"}</td><td><strong>Session #${s.number||"—"}</strong>${s.autoStarted?' <small>auto</small>':""}</td><td>${fmtClock(s.startAt)}</td><td>${s.actualEndAt?fmtClock(s.actualEndAt):s.status==="running"?"Running":s.status==="paused"?"Paused":"—"}</td><td>${fmtDuration(sessionFocusMs(s)/60000)}</td><td><span class="result-pill ${s.status==="completed"?"result-completed":s.status==="interrupted"?"result-interrupted":"result-paused"}">${s.status==="completed"?"Completed":s.status==="interrupted"?"Interrupted":s.status==="running"?"Running":"Paused"}</span></td></tr>`).join("");
 const breakList=db.breaks.filter(b=>b.startAt>=start).slice().sort((a,b)=>b.startAt-a.startAt).slice(0,6);
 $("breakHistory").innerHTML=breakList.length?breakList.map(b=>`<div class="break-history-item"><div><b>${b.type==="short"?"Short":"Long"} break</b><span>${fmtStamp(b.startAt)}${b.endAt?" – "+fmtClock(b.actualEndAt||b.endAt):""}</span></div><strong>${fmtDuration((b.actualEndAt||now)-b.startAt>0?((b.actualEndAt||now)-b.startAt)/60000:0)}</strong></div>`).join(""):'<p class="empty-cell">Break records will appear here.</p>';
}
function chartDays(range) {
 const end=new Date(), arr=[];
 if(range==="day"){for(let i=0;i<12;i++){const d=new Date(end);d.setHours(0,0,0,0);d.setMinutes(d.getMinutes());const start=indiaInputToMs(fmtDateKey(d)+"T00:00");let slots=Array.from({length:12},(_,j)=>j);const hr=i*2;arr.push({key:`${String(hr).padStart(2,"0")}`,label:hr%3===0?`${String(hr).padStart(2,"0")}`:"",start:start+hr*3600000,end:start+(hr+2)*3600000});}}
 else if(range==="week"){for(let i=6;i>=0;i--){const d=new Date(end);d.setDate(d.getDate()-i);const key=fmtDateKey(d);arr.push({key,label:new Intl.DateTimeFormat("en-IN",{timeZone:TZ,weekday:"short"}).format(d),start:indiaInputToMs(key+"T00:00"),end:indiaInputToMs(key+"T23:59")});}}
 else {const p=indiaParts(end);const month=Number(new Intl.DateTimeFormat("en-CA",{timeZone:TZ,month:"2-digit"}).format(end));const year=Number(p.year);const days=new Date(year,month,0).getDate();for(let i=1;i<=days;i++){const key=`${year}-${String(month).padStart(2,"0")}-${String(i).padStart(2,"0")}`;arr.push({key,label:(i===1||i%5===0||i===days)?String(i):"",start:indiaInputToMs(key+"T00:00"),end:indiaInputToMs(key+"T23:59")});}}
 return arr;
}
function renderFocusChart(range) {
 const points=chartDays(range);
 const vals=points.map(p=>db.sessions.filter(s=>s.startAt>=p.start&&s.startAt<=p.end).reduce((sum,s)=>sum+sessionFocusMs(s,nowMs())/60000,0));
 const target=range==="day"?db.dailyTargetHours*60/12:db.dailyTargetHours*60;
 const max=Math.max(target,...vals,30);
 $("focusChartTitle").textContent=range==="day"?"Today's focus by 2-hour block":range==="week"?"Daily focus · last 7 days":"Daily focus · this month";
 $("focusChart").innerHTML=points.map((p,i)=>{
   const vh=Math.max(0,Math.min(100,vals[i]/max*100)), th=Math.max(0,Math.min(100,target/max*100));
   return `<div class="bar-group"><div class="bar-stack" title="${p.key}: ${Math.round(vals[i])} focused min"><div class="bar-target" style="height:${th}%"></div><div class="bar-actual" style="height:${vh}%"></div></div><span>${p.label||"&nbsp;"}</span><em>${vals[i]>=60?(vals[i]/60).toFixed(1)+"h":Math.round(vals[i])+"m"}</em></div>`;
 }).join("");
}
function renderDonut(stats){
 const total=stats.completed+stats.interrupted,done=total?stats.completed/total*360:0;
 $("resultChart").innerHTML=`<div class="donut" style="background:conic-gradient(#2d8068 0deg ${done}deg,#dfe6eb ${done}deg 360deg)"><div class="donut-center"><strong>${total}</strong><span>total sessions</span></div></div><div class="donut-legend"><div><i class="legend-dot" style="background:#2d8068"></i>${stats.completed} completed</div><div><i class="legend-dot" style="background:#dfe6eb"></i>${stats.interrupted} interrupted</div></div>`;
}
function renderAnalytics(){
 const r=calcRangeStats(analyticsRange);
 $("analysisFocus").textContent=fmtDuration(r.focusMs/60000);
 $("analysisGoal").textContent=Math.round(r.targetMs?r.focusMs/r.targetMs*100:0)+"%";
 $("analysisGoalText").textContent=`${fmtDuration(r.focusMs/60000)} / ${fmtDuration(r.targetMs/60000)}`;
 $("analysisSessions").textContent=r.completed;
 $("analysisInterrupted").textContent=`${r.interrupted} interrupted`;
 $("analysisPlanned").textContent=fmtDuration(r.plannedMs/60000);
 renderFocusChart(analyticsRange);renderDonut(r);
 const difference=r.targetMs-r.focusMs;
 const phrase=difference<=0?"Goal met or exceeded in this range.":`${fmtDuration(difference/60000)} remaining to reach this range's target.`;
 const best=r.sessions.filter(s=>s.status==="completed").sort((a,b)=>(b.actualMinutes||0)-(a.actualMinutes||0))[0];
 $("analysisSummary").innerHTML=`<b>${analyticsRange==="day"?"Daily":analyticsRange==="week"?"Weekly":"Monthly"} analysis</b><p>Actual focused time: <strong>${fmtDuration(r.focusMs/60000)}</strong> across ${r.completed} completed session(s), with ${r.interrupted} interrupted. Planned session duration total: ${fmtDuration(r.plannedMs/60000)}. Break time: ${fmtDuration(r.breakMs/60000)}. ${phrase}${best?` Longest completed session: #${best.number}, ${fmtDuration(best.actualMinutes)} (${fmtClock(best.startAt)}–${fmtClock(best.actualEndAt)}).`:""} ${r.sessions.length===0?"No session records in this range yet. Start a session to build your analysis.":""}</p>`;
}
function updateLocalBackupList(){
 const root=$("localBackups");if(!root||!db)return;
 const list=(db.backupSnapshots||[]).slice(0,30);
 const select=$("localSnapshotSelect");
 if(select){const current=select.value;select.innerHTML=list.length?list.map((x,i)=>`<option value="${i}">${x.date} · ${fmtClock(x.at)}</option>`).join(""):'<option value="">No snapshots yet</option>';if(list.length&&[...select.options].some(o=>o.value===current))select.value=current;$("restoreLocalBtn").disabled=!list.length;}
 root.innerHTML=list.length?`<b>${list.length} local snapshot(s) available</b><br><span>Stored only in this browser.</span>`:"Daily local snapshot will appear here.";
}
function exportJson(){
 const blob=new Blob([JSON.stringify({app:"AIAPGET Clock Pomodoro",version:1,exportedAt:nowMs(),data:db},null,2)],{type:"application/json"});
 download(`AIAPGET-Clock-Pomodoro-${fmtDateKey(new Date())}.json`,blob);toast("JSON backup downloaded");
}
function download(name,blob){const a=document.createElement("a"),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function exportCsv(){
 const rows=[["Session #","Start India","End India","Planned minutes","Actual minutes","Status","End reason","Auto-started"]];
 db.sessions.slice().sort((a,b)=>a.startAt-b.startAt).forEach(s=>rows.push([s.number,fmtStamp(s.startAt),s.actualEndAt?fmtStamp(s.actualEndAt):"",s.plannedMinutes,s.actualMinutes||0,s.status,s.endReason||"",s.autoStarted?"yes":"no"]));
 const csv=rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
 download("AIAPGET-Pomodoro-Sessions.csv",new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}));toast("Session CSV exported");
}
function importJsonFile(file){
 const reader=new FileReader();reader.onload=()=>{try{const p=JSON.parse(reader.result),next=p.data||p.entries||p;if(!next||!Array.isArray(next.sessions))throw new Error("Invalid backup");if(!confirm("Restore this backup? It will replace the current local diary data."))return;db={...blankDb(),...next,timer:{...blankDb().timer,...next.timer}};persist({cloud:false});hydrateInputs();renderAll();toast("Backup restored");}catch(e){toast("Could not read this backup file.");}};reader.readAsText(file);
}
function renderAll(){renderRealClock();updateTimerView();renderSchedule();renderTopMetrics();renderHistory();renderAnalytics();updateLocalBackupList();}
function hydrateInputs(){
 const t=db.timer;
 let savedDuration=localStorage.getItem(DUR_KEY);
 if(savedDuration===null){
   // New dial is a 60-minute clock. Keep an in-progress session intact,
   // but start an idle timer at 60 minutes on first load of this version.
   savedDuration=String(t.state==="idle"?60:Math.max(1,safeNum(t.duration,60)));
   localStorage.setItem(DUR_KEY,savedDuration);
   if(t.state==="idle"){t.duration=Number(savedDuration);t.remainingMs=Number(savedDuration)*60000;}
 }
 $("durationMinutes").value=savedDuration||String(t.duration||60);
 $("dailyTargetHours").value=db.dailyTargetHours||7;
 if(db.breakSchedule?.status==="scheduled"){$("breakStart").value=epochToIndiaLocal(db.breakSchedule.startAt);breakType=db.breakSchedule.type;}
 document.querySelectorAll("[data-break-type]").forEach(b=>b.classList.toggle("selected",b.dataset.breakType===breakType));
 $("fixedBreakDuration").textContent=BREAK_DURS[breakType]+" min";
}
function epochToIndiaLocal(ms){
 const p=new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(ms)).replace(" ","T");
 return p.slice(0,16);
}
function doTick(){
 renderRealClock();
 // Catch a scheduled break if the app is open; while closed, browsers cannot guarantee background execution.
 processSchedule();
 if(db.timer.state==="running"&&db.timer.deadline&&nowMs()>=db.timer.deadline)finishSession("completed","Timer completed",db.timer.deadline);
 if(db.timer.state==="break"&&db.breakState&&nowMs()>=db.breakState.endAt)finishBreak();
 updateTimerView();
}
function queueDriveSync(){
 if(!driveToken)return;
 clearTimeout(cloudTimer);cloudTimer=setTimeout(()=>syncDriveBackup({daily:true,quiet:true}),1600);
}
function driveReady(){
 return !!(window.google&&google.accounts&&google.accounts.oauth2);
}
function loadTokenClient(){
 if(!driveReady())return false;
 const clientId=$("googleClientId").value.trim();
 if(!clientId){toast("Enter the Google OAuth Client ID first.");return false;}
 localStorage.setItem(CLIENT_KEY,clientId);
 tokenClient=google.accounts.oauth2.initTokenClient({
  client_id:clientId,
  scope:"https://www.googleapis.com/auth/drive.file",
  callback:async(resp)=>{if(resp.error){driveToken=null;$("driveStatus").textContent="Authorization failed";toast("Google Drive authorization failed.");return;}driveToken=resp.access_token;$("driveStatus").textContent="Connected · token held in memory";$("syncDriveBtn").disabled=false;$("restoreDriveBtn").disabled=false;$("disconnectDriveBtn").disabled=false;await syncDriveBackup({daily:true});}
 });
 return true;
}
async function driveFetch(url,opts={}) {
 if(!driveToken)throw new Error("Drive is not connected");
 const res=await fetch(url,{...opts,headers:{...(opts.headers||{}),Authorization:"Bearer "+driveToken}});
 if(!res.ok){const body=await res.text();if(res.status===401){driveToken=null;$("driveStatus").textContent="Reconnect required";$("syncDriveBtn").disabled=true;$("restoreDriveBtn").disabled=true;$("disconnectDriveBtn").disabled=true;}throw new Error(`Google Drive API ${res.status}: ${body.slice(0,160)}`);}
 if(res.status===204)return null;return res.json();
}
async function findDriveFile(name){
 const q=encodeURIComponent(`name='${name.replace(/'/g,"\\'")}' and trashed=false`);
 const url=`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&pageSize=100&fields=files(id,name,modifiedTime)`;
 const r=await driveFetch(url);return (r.files||[])[0]||null;
}
async function upsertDriveJson(name,data){
 const file=await findDriveFile(name);
 const metadata={name,mimeType:"application/json"};
 if(file){
   return driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
 }
 const boundary="pomodoro_boundary_"+Math.random().toString(16).slice(2);
 const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
 return driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime",{method:"POST",headers:{"Content-Type":`multipart/related; boundary=${boundary}`},body});
}
async function syncDriveBackup({daily=false,quiet=false}={}) {
 if(!driveToken){if(!quiet)toast("Connect Google Drive first.");return;}
 try {
   const payload={app:"AIAPGET Physical Clock Pomodoro",version:1,exportedAt:nowMs(),data:db};
   await upsertDriveJson("AIAPGET-Pomodoro-Latest.json",payload);
   if(daily){
     const name=`AIAPGET-Pomodoro-Daily-${fmtDateKey(new Date())}.json`;
     await upsertDriveJson(name,payload);
   }
   $("driveStatus").textContent="Synced · "+fmtClock(nowMs());
   $("driveStatus").style.color="#2c8068";
   if(!quiet)toast("Google Drive backup synced");
 }catch(e){
   $("driveStatus").textContent="Sync failed · check setup";
   if(!quiet)toast(e.message.includes("Google Drive API")?"Drive sync failed. Check Drive API, Client ID and allowed origin.":"Drive sync failed: "+e.message.slice(0,100));
 }
}
async function restoreDriveBackup(){
 if(!driveToken){toast("Connect Google Drive first.");return;}
 try{
   const f=await findDriveFile("AIAPGET-Pomodoro-Latest.json");
   if(!f){toast("No latest backup found in Drive yet. Sync first.");return;}
   if(!confirm("Restore the latest Google Drive backup? This will replace the current local session data. Export a JSON backup first if you need to keep both."))return;
   const payload=await driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
   const incoming=payload.data||payload.entries||payload;
   if(!incoming||!Array.isArray(incoming.sessions))throw new Error("The Drive file is not a valid Pomodoro backup.");
   db={...blankDb(),...incoming,timer:{...blankDb().timer,...incoming.timer}};
   persist({cloud:false});hydrateInputs();renderAll();toast("Latest Google Drive backup restored");
 }catch(e){toast("Could not restore Drive backup: "+e.message.slice(0,95));}
}
function connectDrive(){
 if(!driveReady()){toast("Google Identity script is not ready. Check internet and try again.");return;}
 if(!loadTokenClient())return;
 tokenClient.requestAccessToken({prompt:driveToken?"":"consent"});
}
function disconnectDrive(){
 driveToken=null;tokenClient=null;$("driveStatus").textContent="Not connected";$("syncDriveBtn").disabled=true;$("restoreDriveBtn").disabled=true;$("disconnectDriveBtn").disabled=true;toast("Google Drive disconnected for this page session");
}
function initEvents(){
 $("startPauseBtn").addEventListener("click",()=>{
   const st=db.timer.state;
   if(st==="running")pauseFocus();
   else if(st==="paused")resumeFocus();
   else if(st==="idle")startFocus(safeNum($("durationMinutes").value,60));
 });
 $("resetTimerBtn").addEventListener("click",()=>{
   if(db.timer.state==="running"||db.timer.state==="paused"){if(!confirm("End this active session and reset the timer?"))return;finishSession("interrupted","Manual reset");}
   db.timer.state="idle";db.timer.remainingMs=safeNum($("durationMinutes").value,60)*60000;db.timer.deadline=null;db.timer.startedAt=null;db.timer.sessionId=null;persist();updateTimerView();toast("Timer reset");
 });
 $("stopSessionBtn").addEventListener("click",()=>{if(confirm("End the current focus session now?"))cancelCurrentSession();});
 $("skipBreakBtn").addEventListener("click",()=>{if(db.breakState){if(confirm("End this break now and start the next focus session?"))finishBreak(true);}});
 $("applyDuration").addEventListener("click",()=>{
   const mins=Math.round(safeNum($("durationMinutes").value,60));if(mins<1||mins>240){toast("Choose a duration from 1 to 240 minutes.");return;}
   if(db.timer.state==="running"||db.timer.state==="paused"||db.timer.state==="break"){toast("Pause/end the active timer before changing duration.");return;}
   db.timer.duration=mins;db.timer.remainingMs=mins*60000;localStorage.setItem(DUR_KEY,String(mins));persist();updateTimerView();toast(`Default session set to ${mins} min`);
 });
 $("durationMinutes").addEventListener("change",()=>{
  if(db.timer.state==="idle"){const v=Math.max(1,Math.min(240,Math.round(safeNum($("durationMinutes").value,60))));$("durationMinutes").value=v;}
 });
 document.querySelectorAll("[data-break-type]").forEach(b=>b.addEventListener("click",()=>{
  breakType=b.dataset.breakType;document.querySelectorAll("[data-break-type]").forEach(x=>x.classList.toggle("selected",x===b));$("fixedBreakDuration").textContent=BREAK_DURS[breakType]+" min";
 }));
 $("scheduleBreakBtn").addEventListener("click",scheduleBreak);$("cancelBreakBtn").addEventListener("click",cancelSchedule);
 $("historyFilter").addEventListener("change",renderHistory);
 document.querySelectorAll("[data-range]").forEach(b=>b.addEventListener("click",()=>{analyticsRange=b.dataset.range;document.querySelectorAll("[data-range]").forEach(x=>x.classList.toggle("active",x===b));renderAnalytics();}));
 $("dailyTargetHours").addEventListener("change",()=>{const x=Math.max(.5,Math.min(16,safeNum($("dailyTargetHours").value,7)));db.dailyTargetHours=x;$("dailyTargetHours").value=x;persist();});
 $("exportJsonBtn").addEventListener("click",exportJson);$("exportTop").addEventListener("click",exportJson);
 $("exportHistory").addEventListener("click",exportCsv);
 $("importJsonFile").addEventListener("change",e=>{if(e.target.files[0])importJsonFile(e.target.files[0]);e.target.value="";});
 $("connectDriveBtn").addEventListener("click",connectDrive);$("syncDriveBtn").addEventListener("click",()=>syncDriveBackup({daily:true}));$("restoreDriveBtn").addEventListener("click",restoreDriveBackup);$("disconnectDriveBtn").addEventListener("click",disconnectDrive);
 $("restoreLocalBtn").addEventListener("click",()=>{const idx=Number($("localSnapshotSelect").value),snap=db.backupSnapshots[idx];if(!snap||!snap.data){toast("Choose a valid snapshot.");return;}if(!confirm(`Restore local snapshot from ${snap.date}? Current data will be replaced.`))return;const history=db.backupSnapshots;db={...blankDb(),...snap.data,timer:{...blankDb().timer,...snap.data.timer},backupSnapshots:history};persist({cloud:false});hydrateInputs();renderAll();toast("Local snapshot restored");});
 $("googleClientId").value=localStorage.getItem(CLIENT_KEY)||"";
 window.addEventListener("beforeunload",()=>{if(db)persist({cloud:false});});
 document.addEventListener("visibilitychange",()=>{if(!document.hidden){doTick();renderAnalytics();}});
}
loadDb();
const lastDur=safeNum(localStorage.getItem(DUR_KEY),60);
if(!db.timer||!db.timer.duration)db.timer={...blankDb().timer,duration:lastDur,remainingMs:lastDur*60000};
if(db.timer.state==="running"&&db.timer.deadline&&nowMs()>=db.timer.deadline){finalizeSession("completed","Timer completed while app was closed",db.timer.deadline);db.timer.state="idle";db.timer.sessionId=null;db.timer.deadline=null;db.timer.startedAt=null;db.timer.remainingMs=db.timer.duration*60000;}
buildDial();hydrateInputs();initEvents();renderAll();persist({cloud:false});
setInterval(doTick,250);
setInterval(()=>{if(db){const day=fmtDateKey(new Date());if(db.lastLocalBackupDate!==day)persist();}},30000);
})();