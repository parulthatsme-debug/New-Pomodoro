(() => {
"use strict";
const $ = id => document.getElementById(id);
const TZ = "Asia/Kolkata";
const DB_KEY = "aiapget-clock-pomodoro-v1";
const LOCAL_ENC_KEY = "pomo-clock-encrypted-local-v1";
const CLIENT_KEY = "aiapget-clock-drive-client-id-v1";
const DUR_KEY = "aiapget-clock-last-duration-v3";
const SW_KEY = "pomo-clock-stopwatch-local-v1";
const BREAK_DURS = {short:15,long:60};
const CIRC = 2 * Math.PI * 174;
let db = null, breakType = "short", analyticsRange = "day", driveToken = null, tokenClient = null;
let lastSavedHash = "", tickHandle = null, cloudTimer = null, localEncryptWriteSeq = 0;
let firebaseApp = null, firebaseAuth = null, firestore = null, authUser = null, encryptionKey = null, encryptionSalt = null, cloudReady = false, cloudSyncTimer = null;
let alarmContext = null, alarmNodes = new Set();
let stopwatch = {running:false, accumulatedMs:0, startedAt:null, history:[]};
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
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
function blankDb() {
 return {version:1,sessions:[],breaks:[],timer:{state:"idle",duration:120,remainingMs:120*60000,startedAt:null,deadline:null,sessionId:null,elapsedBefore:0,mode:null,attemptId:null},pendingSessionName:"",breakSchedule:null,breakState:null,dailyTargetHours:7,logs:[],backupSnapshots:[],lastLocalBackupDate:null,createdAt:nowMs(),updatedAt:nowMs()};
}
function normalizeDbSessions(){
 if(!Array.isArray(db.sessions))db.sessions=[];
 if(!Array.isArray(db.breaks))db.breaks=[];
 if(!Array.isArray(db.backupSnapshots))db.backupSnapshots=[];
 db.timer={...blankDb().timer,...(db.timer||{})};
 db.sessions.forEach(s=>{
   if(!Array.isArray(s.focusSegments))s.focusSegments=[];
   if(!Array.isArray(s.pauseIntervals))s.pauseIntervals=[];
   if(!Array.isArray(s.recoveryAttempts))s.recoveryAttempts=[];
   if(!Number.isFinite(Number(s.targetDurationMs)))s.targetDurationMs=Math.max(1,safeNum(s.plannedMinutes,60))*60000;
   if(!s.focusSegments.length&&safeNum(s.activeDurationMs,0)>0){
     s.focusSegments.push({id:newId(),attemptId:null,mode:"legacy",startAt:s.startAt||nowMs(),endAt:s.actualEndAt||null,durationMs:safeNum(s.activeDurationMs,0),legacy:true});
   }
   if(!s.pauseIntervals.length&&safeNum(s.pauseDurationMs,0)>0){
     s.pauseIntervals.push({id:newId(),attemptId:null,type:"legacy",startAt:s.startAt||nowMs(),endAt:(s.startAt||nowMs())+safeNum(s.pauseDurationMs,0),durationMs:safeNum(s.pauseDurationMs,0),legacy:true});
   }
   if(s.id===db.timer.sessionId&&!s.recoveryAttempts.length&&["running","paused"].includes(s.status)){
     const attemptId=db.timer.attemptId||newId();db.timer.attemptId=attemptId;db.timer.mode=db.timer.mode||"initial";
     s.recoveryAttempts.push({id:attemptId,mode:db.timer.mode,startAt:s.startAt||db.timer.startedAt||nowMs(),deadline:db.timer.deadline||s.plannedEndAt||nowMs(),targetMs:s.targetDurationMs,status:s.status,endAt:null});
     if(db.timer.state==="running"&&!s.focusSegments.some(x=>x.endAt==null))openFocusSegment(s,db.timer.startedAt||s.lastSegmentStartAt||s.startAt||nowMs(),db.timer.mode,attemptId);
     if(db.timer.state==="paused"&&!s.pauseIntervals.some(x=>x.endAt==null))openPauseInterval(s,s.pausedAt||nowMs(),"manual",attemptId);
   }
 });
 // v5 recovery sessions are focus-time based, not wall-clock deadline based.
 // Migrate any active v4 recovery attempt without changing its accumulated focus or pauses.
 if(db.timer.sessionId && db.timer.mode==="recovery" && ["running","paused","break"].includes(db.timer.state)){
   const active=db.sessions.find(x=>x.id===db.timer.sessionId);
   if(active){
     db.timer.deadline=null;
     const attempt=(active.recoveryAttempts||[]).find(x=>x.id===db.timer.attemptId);
     if(attempt)attempt.deadline=null;
     const savedFocus=Math.max(0,safeNum(active.activeDurationMs,0));
     const openFocus=(active.focusSegments||[]).find(x=>x.endAt==null && x.attemptId===db.timer.attemptId);
     const liveFocus=openFocus&&db.timer.state==="running"?Math.max(0,nowMs()-openFocus.startAt):0;
     db.timer.remainingMs=Math.max(0,sessionTargetMs(active)-savedFocus-liveFocus);
     db.timer.duration=Math.max(1,Math.ceil(db.timer.remainingMs/60000));
   }
 }
}
function loadDb(){
 try{
   const parsed=JSON.parse(localStorage.getItem(DB_KEY)||"null");
   if(parsed&&typeof parsed==="object"){db={...blankDb(),...parsed,timer:{...blankDb().timer,...(parsed.timer||{})}};normalizeDbSessions();return;}
 }catch(e){}
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
   if(encryptionKey && encryptionSalt){
     const snapshot=JSON.parse(serial);
     saveEncryptedLocal(snapshot).catch(err=>{console.error("Encrypted local save failed",err);toast("Encrypted local save failed. Export a backup when possible.");});
   } else if(!authUser) {
     // Legacy local records are retained until the owner creates/unlocks encryption.
     localStorage.setItem(DB_KEY,serial);
   }
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
 if(cloud) { queueCloudSync(); queueDriveSync(); }
}
function toast(msg) {const el=$("toast");el.textContent=msg;el.classList.add("show");clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.remove("show"),2600);}
function buildDial() {
 const ticks=$("ticks"), labels=$("labels"); ticks.innerHTML="";labels.innerHTML="";
 // POMO scale: 120 one-minute divisions; the dial advances anticlockwise.
 // Major labels every 10 minutes, medium ticks every 5 minutes.
 for(let minute=0;minute<120;minute++){
   const a=(-minute*3-90)*Math.PI/180;
   const major=minute%10===0, medium=minute%5===0;
   const r1=major?184:medium?188:192, r2=major?207:medium?202:198;
   const x1=250+Math.cos(a)*r1,y1=250+Math.sin(a)*r1,x2=250+Math.cos(a)*r2,y2=250+Math.sin(a)*r2;
   const line=document.createElementNS("http://www.w3.org/2000/svg","line");
   line.setAttribute("x1",x1);line.setAttribute("y1",y1);line.setAttribute("x2",x2);line.setAttribute("y2",y2);
   line.setAttribute("class","dial-tick"+(major?" major":medium?" medium":""));ticks.appendChild(line);
   if(major){
     const text=document.createElementNS("http://www.w3.org/2000/svg","text");
     const rt=222, lx=250+Math.cos(a)*rt,ly=250+Math.sin(a)*rt+7;
     text.setAttribute("x",lx);text.setAttribute("y",ly);text.setAttribute("text-anchor","middle");text.setAttribute("class","dial-label");
     text.textContent=minute===0?"00/120":String(minute).padStart(2,"0");labels.appendChild(text);
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
 const s=getActiveSession();
 return s?sessionFocusMs(s,now):Math.max(0,t.elapsedBefore||0);
}
function remainingMs(t, now=nowMs()){
 if((t.state==="running"||t.state==="paused")&&t.mode==="recovery"){
   const s=getActiveSession();
   if(s)return Math.max(0,sessionTargetMs(s)-sessionFocusMs(s,now));
 }
 // During an initial fixed-window session, freeze the visible countdown at
 // the exact moment of manual pause. The original deadline is deliberately
 // NOT shifted: doTick() still closes the session at that fixed wall-clock time.
 if(t.state==="paused"&&t.mode!=="recovery"&&t.deadline){
   return Math.max(0,safeNum(t.remainingMs,t.deadline-now));
 }
 if(t.state==="running"&&t.deadline) return Math.max(0,t.deadline-now);
 if(t.state==="break"&&db.breakState) return Math.max(0,db.breakState.endAt-now);
 return Math.max(0,t.remainingMs||0);
}
function setDialProgress(pct){
 pct=Math.max(0,Math.min(1,pct));
 $("pomodoroProgress").setAttribute("stroke-dashoffset",String(CIRC*(1-pct)));
}
function updateTimerView() {
 const t=db.timer, now=nowMs();
 let display="", pct=0, dialElapsedMs=0, hint="Set your duration, then start.";
 const s=getActiveSession();
 // Keep the values needed by both timer and recovery panels in function scope.
 // In v5.1 they were block-scoped inside the running/paused branch, which
 // caused a ReferenceError before the right-side recovery controls rendered.
 let target=Math.max(1,s?.targetDurationMs||safeNum(t.duration,120)*60000);
 let focused=s?sessionFocusMs(s,now):elapsedMs(t,now);
 const recoveryMode=!!(s&&t.mode==="recovery"&&["running","paused","break"].includes(t.state));
 if(t.state==="running"&&recoveryMode&&sessionFocusMs(s,now)>=sessionTargetMs(s)){
   completeRecoveryAtTarget(now);return;
 }
 if((t.state==="running"||t.state==="paused")&&s&&t.mode!=="recovery"&&t.deadline&&now>=t.deadline){
   closeAttemptAtDeadline(t.deadline);
   return;
 }
 if(t.state==="running"||t.state==="paused") {
   const remain=remainingMs(t,now);
   target=Math.max(1,s?.targetDurationMs||safeNum(t.duration,120)*60000);
   focused=s?sessionFocusMs(s,now):elapsedMs(t,now);
   display=mmss(remain);pct=focused/target;dialElapsedMs=focused;
   const left=Math.max(0,target-focused);
   if(recoveryMode){
     hint=t.state==="paused"
       ? `Recovery paused · ${s?.name||`Session #${s?.number||"—"}`} · ${fmtDuration(left/60000)} focus remaining`
       : `${s?.name||`Session #${s?.number||"—"}`} · recovery focus · ${fmtDuration(left/60000)} remaining; pauses do not consume focus time`;
   }else{
     hint=t.state==="paused"
       ? `Paused · fixed window closes at ${fmtClock(t.deadline)} · ${fmtDuration(left/60000)} focus remaining`
       : `${s?.name||`Session #${s?.number||"—"}`} · window closes at ${fmtClock(t.deadline)} · ${fmtDuration(left/60000)} focus remaining`;
   }
 } else if(t.state==="break") {
   const b=db.breakState,remain=b?Math.max(0,b.endAt-now):0;
   const breakDurationMs=b?Math.max(0,b.endAt-b.startAt):safeNum(t.duration,120)*60000;
   const elapsed=Math.max(0,breakDurationMs-remain);
   display=mmss(remain);pct=breakDurationMs?elapsed/breakDurationMs:0;dialElapsedMs=elapsed;
   hint=b?`${b.type==="short"?"Short":"Long"} break · auto-resume at ${fmtClock(b.endAt)}`:"Break in progress";
   if(remain<=0){finishBreak();return;}
 } else {
   display=mmss(safeNum(t.duration,120)*60000);pct=0;dialElapsedMs=0;hint="Set your duration, then start.";
 }
 $("timerDisplay").textContent=display;$("dialTimerText").textContent=display;
 const dialPct=Math.min(1,Math.max(0,dialElapsedMs/(120*60000)));
 setDialProgress(dialPct);$("timerProgress").style.width=(Math.min(1,Math.max(0,pct))*100)+"%";
 const focusPercent=Math.round(Math.min(1,Math.max(0,pct))*100);
 $("elapsedLabel").textContent=recoveryMode?`${compactTime(focused)} / ${compactTime(target)} · ${focusPercent}%`:`${focusPercent}% of focus target`;
 $("timerHint").textContent=hint;
 const isFocus=t.state==="running",isPaused=t.state==="paused",isBreak=t.state==="break";
 const lastSession=db.sessions.slice().sort((a,b)=>b.startAt-a.startAt)[0];
 const focusStage=isFocus?"running":(lastSession?.status==="completed"?"complete":"inactive");
 $("modeDot").className="mode-dot "+focusStage;
 $("timerProgress").className=focusStage;
 const breakPanel=$("breakElapsedPanel"),breakBar=$("breakElapsedProgress");
 if(isBreak&&db.breakState){const b=db.breakState,total=Math.max(1,b.endAt-b.startAt),elapsed=Math.max(0,Math.min(total,now-b.startAt));breakPanel.classList.add("active");$("breakElapsedLabel").textContent=`${mmss(elapsed)} elapsed · ${Math.round(elapsed/total*100)}%`;breakBar.style.width=(elapsed/total*100)+"%";}else{breakPanel.classList.remove("active");$("breakElapsedLabel").textContent="Not active";breakBar.style.width="0%";}
 $("startPauseText").textContent=isFocus?(recoveryMode?"Pause recovery":"Pause focus"):isPaused?(recoveryMode?"Resume recovery":"Resume focus"):isBreak?"Focus is on break":"Start focus";
 $("startPauseIcon").textContent=isFocus?"Ⅱ":isPaused?"▶":isBreak?"☕":"▶";
 $("startPauseBtn").disabled=isBreak;
 $("modeTitle").textContent=recoveryMode?(isPaused?"Recovery paused":isBreak?"Recovery on scheduled break":"Session recovery in progress"):isFocus?"Focus in progress":isPaused?"Session paused":isBreak?"Rest & recharge":"Ready to focus?";
 $("modeEyebrow").textContent=recoveryMode?"SESSION RECOVERY":isBreak?"SCHEDULED BREAK":isPaused?"POMODORO PAUSED":"POMODORO SESSION";
 $("clockStatus").textContent=recoveryMode?(isFocus?"REAL CLOCK · RECOVERY RUNNING":isPaused?"REAL CLOCK · RECOVERY PAUSED":"REAL CLOCK · RECOVERY ON BREAK"):isFocus?"REAL CLOCK · POMODORO RUNNING":isBreak?"REAL CLOCK · BREAK RUNNING":"REAL TIME · ASIA/KOLKATA";
 $("skipBreakBtn").hidden=!isBreak;$("stopSessionBtn").disabled=!(isFocus||isPaused);
 $("activeSessionBadge").textContent=recoveryMode?(isFocus?`SESSION #${s?.number||"—"} RECOVERING`:isPaused?`SESSION #${s?.number||"—"} RECOVERY PAUSED`:`SESSION #${s?.number||"—"} ON BREAK`):isFocus?`SESSION #${s?.number||"—"} RUNNING`:isPaused?"SESSION PAUSED":isBreak?(db.breakState?.sessionId?`SESSION #${s?.number||"—"} ON BREAK`:"ON BREAK"):"NO ACTIVE SESSION";
 $("activeSessionTitle").textContent=recoveryMode?`${s?.name||`Session #${s?.number||"—"}`} · ${isPaused?"Recovery paused":isBreak?"Recovery on break":"Recovering focus"}`:isFocus?`${s?.name||`Session #${s?.number||"—"}`} · Focus in progress`:isPaused?`${s?.name||`Session #${s?.number||"—"}`} · Paused`:isBreak?(s?`${s.name} · Scheduled break`:"Break active"):`${db.pendingSessionName||`Session #${db.sessions.length+1}`} ready`;
 const breakState=db.breakState,breakElapsed=breakState?Math.max(0,now-breakState.startAt)/60000:0;
 $("activeSessionElapsed").textContent=isFocus||isPaused?(s?`${fmtDuration(sessionFocusMs(s,now)/60000)} focused`:`Not started`):isBreak?`${fmtDuration(breakElapsed)} elapsed`:"Not started";
 $("activeSessionStrip").querySelector(".active-pulse").classList.toggle("running",isFocus||isBreak);
 const durationLabel=document.querySelector('label[for="durationMinutes"]');
 if(recoveryMode){
   if(durationLabel)durationLabel.textContent="Remaining focus";
   const recoveryLeft=Math.max(0,sessionTargetMs(s)-sessionFocusMs(s,now));
   const recoveryMinutes=Math.max(1,Math.ceil(recoveryLeft/60000));
   if($("durationMinutes").value!==String(recoveryMinutes))$("durationMinutes").value=recoveryMinutes;
   $("durationMinutes").readOnly=true;$("applyDuration").disabled=true;
 }else{
   if(durationLabel)durationLabel.textContent="Session duration";
   $("durationMinutes").readOnly=false;$("applyDuration").disabled=isFocus||isPaused||isBreak;
 }
 const sch=db.breakSchedule;
 if(sch&&sch.status==="scheduled")$("nextBreakNote").innerHTML=`<span class="mini-icon">◷</span><span>${sch.type==="short"?"Short":"Long"} break at ${fmtClock(sch.startAt)} · ${BREAK_DURS[sch.type]} min</span>`;
 else if(isBreak)$("nextBreakNote").innerHTML=`<span class="mini-icon">☕</span><span>Break ends at ${fmtClock(db.breakState?.endAt)} · automatic resume is enabled</span>`;
 else $("nextBreakNote").innerHTML=`<span class="mini-icon">◷</span><span>No break scheduled yet.</span>`;
}
function newId(){return (crypto.randomUUID?crypto.randomUUID():String(nowMs())+Math.random().toString(36).slice(2));}
function sessionTargetMs(s){return Math.max(1,s.targetDurationMs||safeNum(s.plannedMinutes,60)*60000);}
function closeOpenFocusSegment(s,endAt){
 const seg=(s.focusSegments||[]).slice().reverse().find(x=>x.endAt==null);
 if(seg){seg.endAt=endAt;seg.durationMs=Math.max(0,endAt-seg.startAt);}
}
function openFocusSegment(s,startAt,mode,attemptId){
 s.focusSegments=s.focusSegments||[];
 s.focusSegments.push({id:newId(),attemptId,mode,startAt,endAt:null,durationMs:0});
}
function openPauseInterval(s,startAt,type,attemptId){
 s.pauseIntervals=s.pauseIntervals||[];
 if(s.pauseIntervals.some(x=>x.endAt==null))return;
 s.pauseIntervals.push({id:newId(),attemptId,type,startAt,endAt:null,durationMs:0});
}
function closeOpenPauseInterval(s,endAt){
 const pause=(s.pauseIntervals||[]).slice().reverse().find(x=>x.endAt==null);
 if(pause){pause.endAt=endAt;pause.durationMs=Math.max(0,endAt-pause.startAt);}
}
function refreshSessionTotals(s){
 s.activeDurationMs=(s.focusSegments||[]).reduce((sum,x)=>sum+Math.max(0,safeNum(x.durationMs,x.endAt!=null?x.endAt-x.startAt:0)),0);
 s.pauseDurationMs=(s.pauseIntervals||[]).reduce((sum,x)=>sum+Math.max(0,safeNum(x.durationMs,x.endAt!=null?x.endAt-x.startAt:0)),0);
 s.actualMinutes=s.activeDurationMs/60000;
}
function attemptDurationMs(items,attemptId){
 return (items||[]).filter(x=>x.attemptId===attemptId).reduce((sum,x)=>sum+Math.max(0,safeNum(x.durationMs,x.endAt!=null?x.endAt-x.startAt:0)),0);
}
function startFocus(durationArg=null, automatic=false) {
 const t=db.timer;
 if(t.state==="running"||t.state==="paused")return;
 if(t.state==="break"){toast("End the active break to start focus.");return;}
 const duration=Math.max(1,Math.min(120,Math.round(durationArg||safeNum($("durationMinutes").value,120))));
 $("durationMinutes").value=duration;localStorage.setItem(DUR_KEY,String(duration));
 const start=nowMs(),id=newId(),number=db.sessions.length?Math.max(...db.sessions.map(x=>x.number||0))+1:1;
 const enteredName=String($("sessionName")?.value||db.pendingSessionName||"").trim().slice(0,80);
 const sessionName=enteredName||`Session #${number}`,targetMs=duration*60000,attemptId=newId(),deadline=start+targetMs;
 const sess={id,number,name:sessionName,startAt:start,plannedEndAt:deadline,actualEndAt:null,plannedMinutes:duration,targetDurationMs:targetMs,actualMinutes:0,activeDurationMs:0,pauseDurationMs:0,pausedAt:null,lastSegmentStartAt:start,status:"running",endReason:null,autoStarted:!!automatic,focusSegments:[],pauseIntervals:[],recoveryAttempts:[{id:attemptId,mode:"initial",startAt:start,deadline,targetMs,status:"running",endAt:null}]};
 openFocusSegment(sess,start,"initial",attemptId);db.sessions.push(sess);db.pendingSessionName="";
 Object.assign(t,{state:"running",duration,remainingMs:targetMs,startedAt:start,deadline,sessionId:id,elapsedBefore:0,mode:"initial",attemptId});
 persist();updateTimerView();playAlarm("start");toast(automatic?"Break finished · original focus session resumed":"Pomodoro started");
}
function endTimerToIdle({preserveBreak=false}={}){
 const t=db.timer;
 t.startedAt=null;t.remainingMs=Math.max(0,safeNum(t.duration,120)*60000);t.elapsedBefore=0;t.mode=null;t.attemptId=null;t.deadline=null;
 if(!preserveBreak){t.state="idle";t.sessionId=null;}
 else {t.sessionId=null;t.mode=null;t.attemptId=null;}
}
function completeRecoveryAtTarget(now=nowMs()){
 const t=db.timer,s=getActiveSession();
 if(!s||t.mode!=="recovery"||t.state!=="running")return false;
 const target=sessionTargetMs(s);
 const savedBefore=Math.max(0,safeNum(s.activeDurationMs,0));
 const open=(s.focusSegments||[]).slice().reverse().find(x=>x.endAt==null&&x.attemptId===t.attemptId);
 const liveFocus=open?Math.max(0,now-open.startAt):0;
 const current=savedBefore+liveFocus;
 if(current<target)return false;
 const neededFromOpen=Math.max(0,target-savedBefore);
 const endAt=open?Math.min(now,open.startAt+neededFromOpen):now;
 if(open)closeOpenFocusSegment(s,endAt);
 refreshSessionTotals(s);
 const attempt=(s.recoveryAttempts||[]).find(x=>x.id===t.attemptId)||s.recoveryAttempts?.slice(-1)[0];
 if(attempt){attempt.endAt=endAt;attempt.status="completed";attempt.focusMs=attemptDurationMs(s.focusSegments,attempt.id);attempt.pauseMs=attemptDurationMs(s.pauseIntervals,attempt.id);}
 s.actualEndAt=endAt;s.completedAt=endAt;s.status="completed";s.endReason="Focus target achieved after recovery";s.pausedAt=null;s.lastAttemptEndAt=endAt;
 t.duration=Math.max(1,safeNum(localStorage.getItem(DUR_KEY),s.plannedMinutes||60));
 endTimerToIdle();
 $("durationMinutes").value=t.duration;
 $("sessionName").value=db.pendingSessionName||`Session #${db.sessions.reduce((m,x)=>Math.max(m,x.number||0),0)+1}`;
 persist();updateTimerView();renderHistory();playAlarm("focus");toast(`Session #${s.number} completed · original focus target achieved`);
 return true;
}
function closeAttemptAtDeadline(endAt=nowMs()){
 const t=db.timer,s=getActiveSession();if(!s||!t.deadline)return;
 const closeAt=Math.min(endAt,t.deadline);
 if(t.state==="running")closeOpenFocusSegment(s,closeAt);
 else closeOpenPauseInterval(s,closeAt);
 refreshSessionTotals(s);
 const attempt=(s.recoveryAttempts||[]).find(x=>x.id===t.attemptId)||s.recoveryAttempts?.slice(-1)[0];
 const completed=s.activeDurationMs>=sessionTargetMs(s);
 if(attempt){attempt.endAt=closeAt;attempt.status=completed?"completed":"partial";attempt.focusMs=attemptDurationMs(s.focusSegments,attempt.id);attempt.pauseMs=attemptDurationMs(s.pauseIntervals,attempt.id);}
 s.actualEndAt=closeAt;s.completedAt=completed?closeAt:null;s.status=completed?"completed":"partial";s.endReason=completed?"Focus target achieved":"Fixed session window ended";s.pausedAt=null;s.lastAttemptEndAt=closeAt;
 const preserveBreak=t.state==="break";
 endTimerToIdle({preserveBreak});
 if(completed||!preserveBreak)$("sessionName").value=db.pendingSessionName||`Session #${(db.sessions.reduce((m,x)=>Math.max(m,x.number||0),0))+1}`;
 persist();updateTimerView();renderHistory();playAlarm("focus");toast(completed?"Focus target completed":"Session window ended · remaining focus saved as Partial");
}
function finishSession(status="partial",reason="Manual stop",endAt=nowMs()){
 const t=db.timer,s=getActiveSession();if(!s)return;
 if(t.deadline&&endAt>=t.deadline){closeAttemptAtDeadline(t.deadline);return;}
 const closeAt=endAt;
 if(t.state==="running")closeOpenFocusSegment(s,closeAt);
 else if(t.state==="paused"||t.state==="break")closeOpenPauseInterval(s,closeAt);
 refreshSessionTotals(s);
 const completed=s.activeDurationMs>=sessionTargetMs(s);
 const attempt=(s.recoveryAttempts||[]).find(x=>x.id===t.attemptId)||s.recoveryAttempts?.slice(-1)[0];
 if(attempt){attempt.endAt=closeAt;attempt.status=completed?"completed":status;attempt.focusMs=attemptDurationMs(s.focusSegments,attempt.id);attempt.pauseMs=attemptDurationMs(s.pauseIntervals,attempt.id);}
 s.actualEndAt=closeAt;s.completedAt=completed?closeAt:null;s.status=completed?"completed":status;s.endReason=completed?"Focus target achieved":reason;s.pausedAt=null;s.lastAttemptEndAt=closeAt;
 if(t.mode==="recovery")t.duration=Math.max(1,safeNum(localStorage.getItem(DUR_KEY),s.plannedMinutes||60));
 endTimerToIdle();
 if($("sessionName"))$("sessionName").value=db.pendingSessionName||`Session #${db.sessions.reduce((m,x)=>Math.max(m,x.number||0),0)+1}`;
 persist();updateTimerView();renderHistory();if(completed||status==="partial")playAlarm("focus");toast(completed?"Focus session completed":`Session saved: ${s.status.toUpperCase()}`);
}
function pauseFocus(pauseType="manual"){
 const t=db.timer,s=getActiveSession();if(t.state!=="running"||!s)return;
 const now=nowMs();
 if(t.mode!=="recovery"&&t.deadline&&now>=t.deadline){closeAttemptAtDeadline(t.deadline);return;}
 closeOpenFocusSegment(s,now);refreshSessionTotals(s);
 if(t.mode==="recovery"&&s.activeDurationMs>=sessionTargetMs(s)&&completeRecoveryAtTarget(now))return;
 openPauseInterval(s,now,pauseType,t.attemptId);refreshSessionTotals(s);
 s.status="paused";s.pausedAt=now;
 t.remainingMs=t.mode==="recovery"?Math.max(0,sessionTargetMs(s)-s.activeDurationMs):Math.max(0,(t.deadline||now)-now);
 t.state="paused";t.startedAt=null;
 const attempt=(s.recoveryAttempts||[]).find(x=>x.id===t.attemptId);if(attempt)attempt.status="paused";
 persist();updateTimerView();toast(t.mode==="recovery"?"Recovery paused · remaining focus preserved":"Focus paused · original end time remains fixed");
}
function resumeFocus(){
 const t=db.timer,s=getActiveSession();if(t.state!=="paused"||!s)return;
 const now=nowMs();
 if(t.mode!=="recovery"&&t.deadline&&now>=t.deadline){closeAttemptAtDeadline(t.deadline);return;}
 closeOpenPauseInterval(s,now);refreshSessionTotals(s);
 if(t.mode==="recovery"&&s.activeDurationMs>=sessionTargetMs(s)){s.status="running";t.state="running";if(completeRecoveryAtTarget(now))return;}
 s.pausedAt=null;s.status="running";s.resumedAt=now;
 openFocusSegment(s,now,t.mode||"initial",t.attemptId);
 const attempt=(s.recoveryAttempts||[]).find(x=>x.id===t.attemptId);if(attempt)attempt.status="running";
 t.state="running";t.startedAt=now;t.remainingMs=t.mode==="recovery"?Math.max(0,sessionTargetMs(s)-s.activeDurationMs):Math.max(0,t.deadline-now);
 if(t.mode==="recovery")t.deadline=null;
 persist();updateTimerView();playAlarm("start");toast(t.mode==="recovery"?"Recovery resumed · pause time is excluded":"Focus resumed · original end time unchanged");
}
function resumeAgain(sessionId){
 if(db.timer.state!=="idle"){toast("Finish the current timer or break before recovering another session.");return;}
 const s=db.sessions.find(x=>x.id===sessionId);if(!s||s.status!=="partial"){toast("This session has no remaining focus to recover.");return;}
 refreshSessionTotals(s);const remaining=Math.max(0,sessionTargetMs(s)-s.activeDurationMs);
 if(remaining<=500){s.status="completed";s.actualEndAt=s.actualEndAt||nowMs();persist();renderHistory();return;}
 const now=nowMs(),attemptId=newId(),displayMinutes=Math.max(1,Math.ceil(remaining/60000));
 s.recoveryAttempts=s.recoveryAttempts||[];s.recoveryAttempts.push({id:attemptId,mode:"recovery",startAt:now,deadline:null,targetMs:remaining,status:"running",endAt:null});
 s.status="running";s.actualEndAt=null;s.completedAt=null;s.endReason="Recovery in progress";s.pausedAt=null;s.currentAttemptId=attemptId;
 openFocusSegment(s,now,"recovery",attemptId);
 Object.assign(db.timer,{state:"running",duration:displayMinutes,remainingMs:remaining,startedAt:now,deadline:null,sessionId:s.id,elapsedBefore:s.activeDurationMs,mode:"recovery",attemptId});
 $("durationMinutes").value=displayMinutes;$("sessionName").value=s.name;
 persist();updateTimerView();renderHistory();playAlarm("start");toast(`Resuming ${s.name||`Session #${s.number}`} · ${fmtDuration(remaining/60000)} focus remaining`);
}
function cancelCurrentSession(){if(db.timer.state!=="running"&&db.timer.state!=="paused")return;finishSession("interrupted","Manual stop");}
function startBreak(type,startAt=nowMs(),scheduled=false){
 if(db.breakState)return;
 const t=db.timer,s=getActiveSession(),now=nowMs(),begin=Math.max(startAt,now),mins=BREAK_DURS[type],endAt=begin+mins*60000;
 if(s){
   if(t.state==="running"){
     closeOpenFocusSegment(s,begin);openPauseInterval(s,begin,"scheduled-break",t.attemptId);refreshSessionTotals(s);s.status="paused";s.pausedAt=begin;
   }
   // If already manually paused, keep its open pause interval and its original deadline.
 }else{
   t.deadline=null;t.startedAt=null;t.sessionId=null;t.mode=null;t.attemptId=null;
 }
 const b={id:newId(),type,startAt:begin,plannedStartAt:startAt,endAt,plannedMinutes:mins,actualEndAt:null,actualMinutes:0,status:"running",scheduled:!!scheduled,manualEnd:false,sessionId:s?.id||null,resumeAfterBreak:!!(s&&t.state==="running")};
 db.breaks.push(b);db.breakState=b;
 Object.assign(t,{state:"break",startedAt:null,remainingMs:mins*60000});
 if(db.breakSchedule&&db.breakSchedule.status==="scheduled")db.breakSchedule.status="started";
 persist();updateTimerView();playAlarm("break");toast(`${type==="short"?"Short":"Long"} break started`);
}
function finishBreak(manual=false){
 const b=db.breakState;if(!b)return;
 const end=manual?nowMs():Math.min(nowMs(),b.endAt);b.actualEndAt=end;b.actualMinutes=Math.max(0,(end-b.startAt)/60000);b.status=manual?"ended early":"completed";b.manualEnd=manual;
 const attachedId=b.sessionId;
 if(attachedId&&db.timer.sessionId===attachedId&&db.timer.deadline&&nowMs()>=db.timer.deadline)closeAttemptAtDeadline(db.timer.deadline);
 db.breakState=null;
 if(db.breakSchedule&&db.breakSchedule.status==="started")db.breakSchedule.status="completed";
 if(attachedId){
   const s=db.sessions.find(x=>x.id===attachedId);
   if(s&&db.timer.sessionId===s.id&&["running","paused"].includes(s.status)){
     if(b.resumeAfterBreak){
       closeOpenPauseInterval(s,nowMs());refreshSessionTotals(s);s.pausedAt=null;s.status="running";
       openFocusSegment(s,nowMs(),db.timer.mode||"initial",db.timer.attemptId);
       db.timer.state="running";db.timer.startedAt=nowMs();db.timer.remainingMs=Math.max(0,db.timer.deadline-nowMs());
       persist();updateTimerView();playAlarm("start");toast("Break finished · same session resumed");
     }else{
       // A scheduled break must not override a manual pause that was already active.
       s.status="paused";db.timer.state="paused";db.timer.startedAt=null;
       db.timer.remainingMs=Math.max(0,db.timer.deadline-nowMs());
       persist();updateTimerView();toast("Break finished · your manual pause is still active");
     }
   }else{
     endTimerToIdle();persist();updateTimerView();toast("Break finished · original session remains in history");
   }
 }else{
   db.timer.state="idle";db.timer.remainingMs=db.timer.duration*60000;db.timer.startedAt=null;db.timer.deadline=null;
   persist();startFocus(safeNum($("durationMinutes").value,safeNum(localStorage.getItem(DUR_KEY),120)),true);
 }
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
 if($("breakDateAutoLabel"))$("breakDateAutoLabel").textContent=`Date is automatic: ${fmtLongDate(nowMs())} (Asia/Kolkata). A time already passed today is scheduled for tomorrow.`;
}
function nextIndiaDateKey(key){
 const [y,m,d]=key.split("-").map(Number);
 const next=new Date(Date.UTC(y,m-1,d+1));
 return `${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,"0")}-${String(next.getUTCDate()).padStart(2,"0")}`;
}
function scheduleBreak(){
 const val=$("breakTime").value;
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(val)){toast("Choose the break start time.");return;}
 let dateKey=fmtDateKey(new Date()),at=indiaInputToMs(`${dateKey}T${val}`);
 // A time already passed today means the next occurrence, tomorrow.
 if(at<=nowMs()) { dateKey=nextIndiaDateKey(dateKey); at=indiaInputToMs(`${dateKey}T${val}`); }
 const type=breakType;
 db.breakSchedule={id:newId(),type,startAt:at,status:"scheduled",createdAt:nowMs()};
 $("cancelBreakBtn").disabled=false;persist();renderSchedule();updateTimerView();toast(`${type==="short"?"Short":"Long"} break scheduled for ${fmtLongDate(at)}`);
}
function cancelSchedule(){
 if(!db.breakSchedule)return;
 if(db.breakSchedule.status==="started"&&db.breakState){toast("A break is already running. Use End break & resume to override.");return;}
 db.breakSchedule.status="cancelled";persist();renderSchedule();updateTimerView();toast("Break schedule cancelled");
}
function stopAlarm(){
 for(const node of alarmNodes){try{node.stop();}catch(e){}try{node.disconnect();}catch(e){}}
 alarmNodes.clear();
}
function playAlarm(kind){
 try{
   const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
   stopAlarm();alarmContext=alarmContext||new AC();
   if(alarmContext.state==="suspended")alarmContext.resume().catch(()=>{});
   const duration=kind==="focus"?14:8;
   // A soft, bell-like pentatonic chime with gentle inharmonic partials and rounded decay.
   const notes=kind==="focus"
     ?[523.25,659.25,784,987.77,1046.5,987.77,784,659.25,784,987.77,1174.66,1046.5,987.77,784,659.25,523.25,659.25,784,987.77,1046.5,1174.66,987.77,784]
     :[659.25,784,987.77,784,659.25,784,1046.5,987.77,784,659.25,784,1046.5,1174.66];
   const spacing=kind==="focus"?0.61:0.61;
   const noteLength=kind==="focus"?1.08:1.02;
   const base=alarmContext.currentTime+0.05;
   notes.forEach((freq,index)=>{
     const offset=index*spacing;if(offset>=duration)return;
     const start=base+offset,len=Math.min(noteLength,duration-offset);
     const bus=alarmContext.createGain();bus.gain.setValueAtTime(0.58,start);bus.connect(alarmContext.destination);
     const partials=[
       {ratio:1,gain:0.082,decay:len},
       {ratio:2.756,gain:0.021,decay:Math.min(len,0.78)},
       {ratio:5.404,gain:0.008,decay:Math.min(len,0.42)}
     ];
     const nodes=[bus];let ended=0;
     const cleanup=()=>{ended++;if(ended===partials.length){nodes.forEach(node=>{alarmNodes.delete(node);try{node.disconnect();}catch(e){}});}};
     partials.forEach(partial=>{
       const osc=alarmContext.createOscillator(),gain=alarmContext.createGain();
       osc.type="sine";osc.frequency.setValueAtTime(freq*partial.ratio,start);
       const decay=Math.max(0.08,partial.decay);
       gain.gain.setValueAtTime(0.0001,start);
       gain.gain.exponentialRampToValueAtTime(partial.gain,start+0.012);
       gain.gain.exponentialRampToValueAtTime(0.0001,start+decay);
       osc.connect(gain);gain.connect(bus);nodes.push(osc,gain);alarmNodes.add(osc);alarmNodes.add(gain);
       osc.onended=cleanup;osc.start(start);osc.stop(start+decay+0.025);
     });
     alarmNodes.add(bus);
   });
 }catch(e){console.warn("Notification chime could not be played",e);}
}
function saveSessionName(){
 const value=String($("sessionName").value||"").trim().slice(0,80);
 if(!value){toast("Enter a session name first.");$("sessionName").focus();return;}
 const active=getActiveSession();
 if(active&&(db.timer.state==="running"||db.timer.state==="paused"||db.timer.state==="break")){active.name=value;toast("Current session renamed");}
 else {db.pendingSessionName=value;toast("Next session name saved");}
 persist();updateTimerView();
}
function stopwatchElapsed(){return Math.max(0,(stopwatch.accumulatedMs||0)+(stopwatch.running&&stopwatch.startedAt?nowMs()-stopwatch.startedAt:0));}
function saveStopwatch(){
 try{localStorage.setItem(SW_KEY,JSON.stringify({running:!!stopwatch.running,accumulatedMs:safeNum(stopwatch.accumulatedMs,0),startedAt:stopwatch.startedAt||null,history:(stopwatch.history||[]).slice(0,5)}));}catch(e){toast("Stopwatch could not be saved in this browser.");}
}
function loadStopwatch(){
 try{const saved=JSON.parse(localStorage.getItem(SW_KEY)||"null");if(saved&&typeof saved==="object"){stopwatch={running:!!saved.running,accumulatedMs:Math.max(0,safeNum(saved.accumulatedMs,0)),startedAt:saved.startedAt||null,history:Array.isArray(saved.history)?saved.history.slice(0,5):[]};if(stopwatch.running&&!stopwatch.startedAt){stopwatch.running=false;}}}catch(e){}
}
function formatStopwatch(ms){const total=Math.max(0,Math.floor(ms/1000)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),sec=total%60;return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;}
function buildStopwatchDial(){
 const ticks=$("swTicks"),labels=$("swLabels");if(!ticks||!labels)return;ticks.innerHTML="";labels.innerHTML="";
 for(let i=0;i<60;i++){const a=(i*6-90)*Math.PI/180,major=i%5===0,r1=major?84:88,r2=major?98:94;const line=document.createElementNS("http://www.w3.org/2000/svg","line");line.setAttribute("x1",120+Math.cos(a)*r1);line.setAttribute("y1",120+Math.sin(a)*r1);line.setAttribute("x2",120+Math.cos(a)*r2);line.setAttribute("y2",120+Math.sin(a)*r2);line.setAttribute("class",major?"sw-tick major":"sw-tick");ticks.appendChild(line);if(major){const t=document.createElementNS("http://www.w3.org/2000/svg","text"),ang=(i*6-90)*Math.PI/180;t.setAttribute("x",120+Math.cos(ang)*75);t.setAttribute("y",120+Math.sin(ang)*75+3.5);t.setAttribute("text-anchor","middle");t.setAttribute("class","sw-label");t.textContent=String(i).padStart(2,"0");labels.appendChild(t);}}
}
function updateStopwatchView(){
 const elapsed=stopwatchElapsed(),sec=elapsed/1000;
 $("stopwatchDisplay").textContent=formatStopwatch(elapsed);
 $("swSecondHand").setAttribute("transform",`rotate(${(sec%60)*6} 120 120)`);
 $("swMinuteHand").setAttribute("transform",`rotate(${(sec/60%60)*6} 120 120)`);
 $("swHourHand").setAttribute("transform",`rotate(${(sec/3600%12)*30+(sec/60%60)*0.5} 120 120)`);
 $("stopwatchStatus").textContent=stopwatch.running?"RUNNING":elapsed>0?"PAUSED":"READY";
 $("stopwatchStartPause").textContent=stopwatch.running?"Pause":"Start";
 $("stopwatchSave").disabled=elapsed<1000;
 const list=$("stopwatchHistory");
 list.innerHTML=stopwatch.history.length?stopwatch.history.slice(0,5).map((entry,i)=>`<li><span><b>Use ${i+1}</b><small>${entry.completedAt?fmtStamp(entry.completedAt):"Saved locally"}</small></span><strong>${formatStopwatch(entry.durationMs)}</strong></li>`).join(""):'<li class="stopwatch-empty">Your saved stopwatch uses will appear here.</li>';
}
function toggleStopwatch(){
 if(stopwatch.running){stopwatch.accumulatedMs=stopwatchElapsed();stopwatch.startedAt=null;stopwatch.running=false;}else{stopwatch.startedAt=nowMs();stopwatch.running=true;}saveStopwatch();updateStopwatchView();
}
function finishStopwatch(){
 const durationMs=stopwatchElapsed();if(durationMs>=1000){stopwatch.history.unshift({durationMs,completedAt:nowMs()});stopwatch.history=stopwatch.history.slice(0,5);}
 stopwatch.running=false;stopwatch.startedAt=null;stopwatch.accumulatedMs=0;saveStopwatch();updateStopwatchView();if(durationMs>=1000)toast("Stopwatch use saved locally");
}
function resetStopwatch(){stopwatch.running=false;stopwatch.startedAt=null;stopwatch.accumulatedMs=0;saveStopwatch();updateStopwatchView();}

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
 if(range==="day"){const start=indiaInputToMs(key+"T00:00");return {start,end:start+86400000-1};}
 if(range==="week"){const d=new Date(ref);d.setDate(d.getDate()-6);return {start:indiaInputToMs(fmtDateKey(d)+"T00:00"),end:ref.getTime()};}
 const monthKey=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit"}).format(ref);
 return {start:indiaInputToMs(monthKey+"-01T00:00"),end:ref.getTime()};
}
function sessionPauseMs(s,now=nowMs()){
 if(Array.isArray(s.pauseIntervals)&&s.pauseIntervals.length){
   return s.pauseIntervals.reduce((sum,p)=>sum+Math.max(0,p.endAt!=null?(p.durationMs??p.endAt-p.startAt):((s.id===db.timer.sessionId&&(db.timer.state==="paused"||db.timer.state==="break"))?now-p.startAt:0)),0);
 }
 const saved=Math.max(0,Number(s.pauseDurationMs||0));
 return saved+(s.status==="paused"&&s.pausedAt?Math.max(0,now-s.pausedAt):0);
}
function sessionFocusMs(s,now=nowMs()){
 const saved=Math.max(0,Number(s.activeDurationMs??(Number(s.actualMinutes||0)*60000)));
 if(s.actualEndAt!==null&&s.actualEndAt!==undefined)return saved;
 if(s.id===db.timer.sessionId&&db.timer.state==="running"&&db.timer.startedAt)return saved+Math.max(0,Math.min(now,db.timer.deadline||now)-db.timer.startedAt);
 return saved;
}
function sessionFocusMsInRange(s,start,end,now=nowMs()){
 const tracked=(s.focusSegments||[]).filter(seg=>!seg.legacy&&Number.isFinite(Number(seg.startAt)));
 if(!tracked.length){return s.startAt>=start&&s.startAt<=end?sessionFocusMs(s,now):0;}
 return tracked.reduce((sum,seg)=>{
   const segStart=Number(seg.startAt);
   let segEnd=seg.endAt!=null?Number(seg.endAt):now;
   if(seg.endAt==null&&s.id===db.timer.sessionId&&db.timer.deadline)segEnd=Math.min(segEnd,db.timer.deadline);
   const overlap=Math.max(0,Math.min(segEnd,end)-Math.max(segStart,start));
   return sum+overlap;
 },0);
}
function calcRangeStats(range) {
 const bounds=rangeStartEnd(range), now=nowMs();
 const sessions=db.sessions.filter(s=>s.startAt>=bounds.start&&s.startAt<=bounds.end);
 const breaks=db.breaks.filter(b=>b.startAt>=bounds.start&&b.startAt<=bounds.end);
 const focusMs=db.sessions.reduce((sum,s)=>sum+sessionFocusMsInRange(s,bounds.start,bounds.end,now),0);
 const plannedMs=sessions.reduce((sum,s)=>sum+(s.plannedMinutes||0)*60000,0);
 const completed=sessions.filter(s=>s.status==="completed").length;
 const interrupted=sessions.filter(s=>s.status==="interrupted").length;
 const partial=sessions.filter(s=>s.status==="partial").length;
 const outstandingMs=sessions.reduce((sum,s)=>sum+(s.status==="partial"?Math.max(0,sessionTargetMs(s)-sessionFocusMs(s,now)):0),0);
 const breakMs=breaks.reduce((sum,b)=>sum+Math.max(0,(b.actualEndAt||now)-b.startAt),0);
 let targetMs=0;
 if(range==="day") targetMs=db.dailyTargetHours*3600000;
 else if(range==="week")targetMs=db.dailyTargetHours*7*3600000;
 else { const dt=new Date(now);const p=indiaParts(dt);const [year,month]=[Number(p.year),Number(new Intl.DateTimeFormat("en-CA",{timeZone:TZ,month:"2-digit"}).format(dt))];const day=Number(p.day);targetMs=db.dailyTargetHours*day*3600000; }
 return {sessions,breaks,focusMs,plannedMs,completed,interrupted,partial,outstandingMs,breakMs,targetMs,goalPct:targetMs?Math.min(999,focusMs/targetMs*100):0};
}
function renderTopMetrics(){
 const day=calcRangeStats("day");
 $("metricSessions").textContent=day.completed;
 $("metricSessionsSub").textContent=`${day.partial} partial · ${day.interrupted} interrupted`;
 $("metricFocus").textContent=fmtDuration(day.focusMs/60000);
 $("metricFocusSub").textContent=`Target: ${fmtDuration(db.dailyTargetHours*60)}`;
 $("metricBreak").textContent=fmtDuration(day.breakMs/60000);
 $("metricBreakSub").textContent=`${day.breaks.length} break record(s)`;
 $("metricTarget").textContent=Math.round(day.focusMs/day.targetMs*100||0)+"%";
 $("metricTargetSub").textContent=`${fmtDuration(day.focusMs/60000)} of ${fmtDuration(db.dailyTargetHours*60)}`;
}
function compactTime(ms){
 const minutes=Math.max(0,Math.round(ms/60000));
 return minutes<60?`${minutes}m`:`${Math.floor(minutes/60)}h ${minutes%60}m`;
}
function renderSessionDetails(s){
 const attempts=(s.recoveryAttempts||[]).slice().sort((a,b)=>a.startAt-b.startAt);
 const events=[];
 attempts.forEach((a,i)=>{
   if(i>0){const previous=attempts[i-1],gapStart=previous.endAt||previous.deadline,gapEnd=a.startAt;if(gapStart&&gapEnd>gapStart)events.push({at:gapStart,type:"gap",start:gapStart,end:gapEnd,label:"Waiting before recovery",duration:gapEnd-gapStart});}
   (s.focusSegments||[]).filter(x=>x.attemptId===a.id).forEach(x=>events.push({at:x.startAt,type:"focus",start:x.startAt,end:x.endAt,label:a.mode==="recovery"?"Recovery focus":"Focus period",duration:x.endAt==null?Math.max(0,nowMs()-x.startAt):safeNum(x.durationMs,x.endAt-x.startAt)}));
   (s.pauseIntervals||[]).filter(x=>x.attemptId===a.id).forEach(x=>events.push({at:x.startAt,type:"pause",start:x.startAt,end:x.endAt,label:x.type==="scheduled-break"?"Scheduled break / pause":"Focus paused",duration:x.endAt==null?Math.max(0,nowMs()-x.startAt):safeNum(x.durationMs,x.endAt-x.startAt)}));
   if(a.endAt)events.push({at:a.endAt,type:"window",start:a.endAt,end:a.endAt,label:a.status==="completed"?"Focus target achieved":"Focus window ended",duration:0});
 });
 if(!events.length){
   const legacyFocus=sessionFocusMs(s),legacyPause=sessionPauseMs(s);
   return `<div class="session-detail-card"><div class="session-detail-summary"><b>Session target</b><strong>${compactTime(sessionTargetMs(s))}</strong><span>Actual focus ${compactTime(legacyFocus)} · Session pause ${compactTime(legacyPause)}</span></div><p class="session-detail-note">Detailed period-by-period timestamps will be available for sessions recorded after this update. Earlier records remain preserved.</p></div>`;
 }
 events.sort((a,b)=>a.at-b.at||({focus:0,pause:1,window:2,gap:3}[a.type]-({focus:0,pause:1,window:2,gap:3}[b.type])));
 const timeline=events.map(e=>{
   const time=e.end?`${fmtClock(e.start)} – ${fmtClock(e.end)}`: `${fmtClock(e.start)} – ongoing`;
   const detail=e.type==="window"?"":compactTime(e.duration);
   return `<div class="session-activity-item ${e.type}"><i></i><div><b>${escapeHtml(e.label)}</b><small>${time}</small></div><strong>${detail}</strong></div>`;
 }).join("");
 const legacyFocus=(s.focusSegments||[]).filter(x=>x.legacy).reduce((sum,x)=>sum+safeNum(x.durationMs,0),0);
 const legacyPause=(s.pauseIntervals||[]).filter(x=>x.legacy).reduce((sum,x)=>sum+safeNum(x.durationMs,0),0);
 const legacyNote=(legacyFocus||legacyPause)?`<p class="session-detail-note">Earlier recorded activity: ${compactTime(legacyFocus)} focus · ${compactTime(legacyPause)} paused. Exact focus/pause timestamps were not stored by the earlier app version, so they are not reconstructed here.</p>`:"";
 const target=sessionTargetMs(s),focus=sessionFocusMs(s),remaining=Math.max(0,target-focus);
 return `<div class="session-detail-card"><div class="session-detail-summary"><b>Target ${compactTime(target)}</b><strong>${compactTime(focus)} focused</strong><span>${compactTime(sessionPauseMs(s))} paused · ${compactTime(remaining)} remaining</span></div><div><div class="session-activity-list">${timeline}</div>${legacyNote}</div></div>`;
}
function renderHistory(){
 const filter=$("historyFilter").value,now=nowMs();
 let start=0;if(filter==="today")start=indiaInputToMs(fmtDateKey(new Date())+"T00:00");else if(filter==="7days")start=now-7*86400000;else if(filter==="30days")start=now-30*86400000;
 const list=db.sessions.filter(s=>s.startAt>=start).slice().sort((a,b)=>b.startAt-a.startAt);
 const tbody=$("sessionTable");
 if(!list.length)tbody.innerHTML='<tr><td colspan="7" class="empty-cell">No sessions in this range yet.</td></tr>';
 else tbody.innerHTML=list.map(s=>{
   const focus=sessionFocusMs(s),target=sessionTargetMs(s),left=Math.max(0,target-focus),isPartial=s.status==="partial",isRecovery=s.id===db.timer.sessionId&&db.timer.mode==="recovery"&&["running","paused","break"].includes(db.timer.state);
   const resultClass=s.status==="completed"?"result-completed":s.status==="partial"?"result-partial":s.status==="interrupted"?"result-interrupted":isRecovery?"result-recovering":s.status==="running"?"result-running":"result-paused";
   const resultLabel=s.status==="completed"?"COMPLETED":isPartial?"PARTIAL":s.status==="interrupted"?"INTERRUPTED":isRecovery?(s.status==="paused"?"RECOVERY PAUSED":"RECOVERING"):s.status==="running"?"IN PROGRESS":"PAUSED";
   const activeRecovery=s.id===db.timer.sessionId&&db.timer.mode==="recovery"&&["running","paused","break"].includes(db.timer.state);
   const endLabel=s.actualEndAt?fmtClock(s.actualEndAt):activeRecovery?(db.timer.state==="paused"?"Recovery paused":db.timer.state==="break"?"On scheduled break":"Recovering"):(s.status==="running"||s.status==="paused")&&db.timer.deadline?`Until ${fmtClock(db.timer.deadline)}`:"—";
   const focusLabel=`${compactTime(focus)} / ${compactTime(target)}`;
   const button=isPartial&&left>0?`<button class="resume-again-btn" type="button" data-resume-session="${s.id}" title="Recover ${compactTime(left)} focus time">↻ Resume Again · ${compactTime(left)}</button>`:"";
   return `<tr class="session-main-row"><td>${s.number||"—"}</td><td><div class="session-title-cell"><button class="session-name-edit" type="button" data-rename-session="${s.id}" title="Rename this session">${escapeHtml(s.name||`Session #${s.number||"—"}`)} <span aria-hidden="true">✎</span></button><button class="session-detail-toggle" type="button" data-toggle-session="${s.id}" aria-expanded="false" title="Show focus and pause timeline">Details⌄</button>${s.autoStarted?' <small>auto</small>':""}</div></td><td>${fmtClock(s.startAt)}</td><td>${endLabel}</td><td>${compactTime(sessionPauseMs(s))}</td><td>${focusLabel}</td><td><span class="result-pill ${resultClass}">${resultLabel}</span>${isPartial?`<small class="remaining-focus">${compactTime(left)} focus left</small>`:""}${button}</td></tr><tr class="session-detail-row" id="session-detail-${s.id}" hidden><td colspan="7">${renderSessionDetails(s)}</td></tr>`;
 }).join("");
 tbody.querySelectorAll("[data-rename-session]").forEach(btn=>btn.addEventListener("click",()=>{const session=db.sessions.find(x=>x.id===btn.dataset.renameSession);if(!session)return;const value=prompt("Enter a name for this session:",session.name||`Session #${session.number}`);if(value===null)return;const name=value.trim().slice(0,80);if(!name){toast("Session name cannot be empty.");return;}session.name=name;persist();renderHistory();toast("Session renamed");}));
 tbody.querySelectorAll("[data-toggle-session]").forEach(btn=>btn.addEventListener("click",()=>{const row=$("session-detail-"+btn.dataset.toggleSession);if(!row)return;const open=row.hidden;row.hidden=!open;btn.setAttribute("aria-expanded",String(open));btn.textContent=open?"Hide details⌃":"Details⌄";}));
 tbody.querySelectorAll("[data-resume-session]").forEach(btn=>btn.addEventListener("click",()=>resumeAgain(btn.dataset.resumeSession)));
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
 const vals=points.map(p=>db.sessions.reduce((sum,s)=>sum+sessionFocusMsInRange(s,p.start,p.end,nowMs())/60000,0));
 const target=range==="day"?db.dailyTargetHours*60/12:db.dailyTargetHours*60;
 const max=Math.max(target,...vals,30);
 $("focusChartTitle").textContent=range==="day"?"Today's focus by 2-hour block":range==="week"?"Daily focus · last 7 days":"Daily focus · this month";
 $("focusChart").innerHTML=points.map((p,i)=>{
   const vh=Math.max(0,Math.min(100,vals[i]/max*100)), th=Math.max(0,Math.min(100,target/max*100));
   return `<div class="bar-group"><div class="bar-stack" title="${p.key}: ${Math.round(vals[i])} focused min"><div class="bar-target" style="height:${th}%"></div><div class="bar-actual" style="height:${vh}%"></div></div><span>${p.label||"&nbsp;"}</span><em>${vals[i]>=60?(vals[i]/60).toFixed(1)+"h":Math.round(vals[i])+"m"}</em></div>`;
 }).join("");
}
function renderDonut(stats){
 const active=stats.sessions.filter(s=>["running","paused"].includes(s.status)).length;
 const total=stats.completed+stats.partial+stats.interrupted+active;
 const done=total?stats.completed/total*360:0,partial=total?stats.partial/total*360:0,interrupted=total?stats.interrupted/total*360:0;
 const partialEnd=done+partial,interruptedEnd=partialEnd+interrupted;
 $("resultChart").innerHTML=`<div class="donut" style="background:conic-gradient(#2f8b68 0deg ${done}deg,#d59a35 ${done}deg ${partialEnd}deg,#cbd4d0 ${partialEnd}deg ${interruptedEnd}deg,#5b8eb5 ${interruptedEnd}deg 360deg)"><div class="donut-center"><strong>${total}</strong><span>total sessions</span></div></div><div class="donut-legend"><div><i class="legend-dot" style="background:#2f8b68"></i>${stats.completed} completed</div><div><i class="legend-dot" style="background:#d59a35"></i>${stats.partial} partial</div><div><i class="legend-dot" style="background:#cbd4d0"></i>${stats.interrupted} interrupted</div><div><i class="legend-dot" style="background:#5b8eb5"></i>${active} active</div></div>`;
}
function renderAnalytics(){
 const r=calcRangeStats(analyticsRange);
 $("analysisFocus").textContent=fmtDuration(r.focusMs/60000);
 $("analysisGoal").textContent=Math.round(r.targetMs?r.focusMs/r.targetMs*100:0)+"%";
 $("analysisGoalText").textContent=`${fmtDuration(r.focusMs/60000)} / ${fmtDuration(r.targetMs/60000)}`;
 $("analysisSessions").textContent=r.completed;
 $("analysisInterrupted").textContent=`${r.partial} partial · ${r.interrupted} interrupted`;
 $("analysisPlanned").textContent=fmtDuration(r.plannedMs/60000);
 renderFocusChart(analyticsRange);renderDonut(r);
 const difference=r.targetMs-r.focusMs;
 const phrase=difference<=0?"Goal met or exceeded in this range.":`${fmtDuration(difference/60000)} remaining to reach this range's target.`;
 const best=r.sessions.filter(s=>s.status==="completed").sort((a,b)=>(b.actualMinutes||0)-(a.actualMinutes||0))[0];
 $("analysisSummary").innerHTML=`<b>${analyticsRange==="day"?"Daily":analyticsRange==="week"?"Weekly":"Monthly"} analysis</b><p>Actual focused time: <strong>${fmtDuration(r.focusMs/60000)}</strong> across ${r.completed} completed session(s), with ${r.partial} partial and ${r.interrupted} interrupted. Outstanding focus: ${fmtDuration(r.outstandingMs/60000)}. Planned session duration total: ${fmtDuration(r.plannedMs/60000)}. Break time: ${fmtDuration(r.breakMs/60000)}. ${phrase}${best?` Longest completed session: #${best.number}, ${fmtDuration(best.actualMinutes)} (${fmtClock(best.startAt)}–${fmtClock(best.actualEndAt)}).`:""} ${r.sessions.length===0?"No session records in this range yet. Start a session to build your analysis.":""}</p>`;
}
function updateLocalBackupList(){
 const root=$("localBackups");if(!root||!db)return;
 const list=(db.backupSnapshots||[]).slice(0,30);
 const select=$("localSnapshotSelect");
 if(select){const current=select.value;select.innerHTML=list.length?list.map((x,i)=>`<option value="${i}">${x.date} · ${fmtClock(x.at)}</option>`).join(""):'<option value="">No snapshots yet</option>';if(list.length&&[...select.options].some(o=>o.value===current))select.value=current;$("restoreLocalBtn").disabled=!list.length;}
 root.innerHTML=list.length?`<b>${list.length} local snapshot(s) available</b><br><span>Stored only in this browser.</span>`:"Daily local snapshot will appear here.";
}
function exportJson(){
 const blob=new Blob([JSON.stringify({app:"POMO Clock",version:1,exportedAt:nowMs(),data:db},null,2)],{type:"application/json"});
 download(`POMO-Clock-${fmtDateKey(new Date())}.json`,blob);toast("JSON backup downloaded");
}
function download(name,blob){const a=document.createElement("a"),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function exportCsv(){
 const rows=[["Session #","Session name","Start India","Final end India","Planned minutes","Session pause minutes","Actual focus minutes","Remaining focus minutes","Status","Focus/recovery timeline (India)","End reason","Auto-started"]];
 db.sessions.slice().sort((a,b)=>a.startAt-b.startAt).forEach(s=>{
   const timeline=(s.focusSegments||[]).map(x=>`${x.mode||"focus"}: ${fmtStamp(x.startAt)}–${x.endAt?fmtStamp(x.endAt):"ongoing"}`).join(" | ");
   rows.push([s.number,s.name||`Session #${s.number}`,fmtStamp(s.startAt),s.actualEndAt?fmtStamp(s.actualEndAt):"",s.plannedMinutes,Math.round(sessionPauseMs(s)/60000*10)/10,Math.round(sessionFocusMs(s)/60000*10)/10,Math.round(Math.max(0,sessionTargetMs(s)-sessionFocusMs(s))/60000*10)/10,s.status,timeline,s.endReason||"",s.autoStarted?"yes":"no"]);
 });
 const csv=rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
 download("POMO-Clock-Sessions.csv",new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}));toast("Session CSV exported");
}
function importJsonFile(file){
 const reader=new FileReader();reader.onload=()=>{try{const p=JSON.parse(reader.result),next=p.data||p.entries||p;if(!next||!Array.isArray(next.sessions))throw new Error("Invalid backup");if(!confirm("Restore this backup? It will replace the current local diary data."))return;db={...blankDb(),...next,timer:{...blankDb().timer,...next.timer}};normalizeDbSessions();persist({cloud:false});hydrateInputs();renderAll();toast("Backup restored");}catch(e){toast("Could not read this backup file.");}};reader.readAsText(file);
}
function renderAll(){renderRealClock();updateTimerView();renderSchedule();renderTopMetrics();renderHistory();renderAnalytics();updateLocalBackupList();}
function hydrateInputs(){
 const t=db.timer;
 let savedDuration=localStorage.getItem(DUR_KEY);
 if(savedDuration===null){
   // New dial is a 120-minute clock. Keep an in-progress session intact.
   // Migrate the old 60-minute default to 120; preserve a deliberate custom duration.
   const prior=safeNum(localStorage.getItem("aiapget-clock-last-duration-v2"),60);
   const migrated=t.state==="idle"?(prior===60?120:prior):Math.max(1,safeNum(t.duration,120));
   savedDuration=String(migrated);
   localStorage.setItem(DUR_KEY,savedDuration);
   if(t.state==="idle"){t.duration=Number(savedDuration);t.remainingMs=Number(savedDuration)*60000;}
 }
 $("durationMinutes").value=savedDuration||String(t.duration||120);
 $("dailyTargetHours").value=db.dailyTargetHours||7;
 if(db.breakSchedule?.status==="scheduled"){$("breakTime").value=epochToIndiaLocal(db.breakSchedule.startAt).slice(11,16);breakType=db.breakSchedule.type;}
 $("breakDateAutoLabel").textContent=`Date is automatic: ${fmtLongDate(nowMs())} (Asia/Kolkata). A time already passed today is scheduled for tomorrow.`;
 const active=getActiveSession();$("sessionName").value=active?.name||db.pendingSessionName||`Session #${db.sessions.reduce((m,x)=>Math.max(m,x.number||0),0)+1}`;
 document.querySelectorAll("[data-break-type]").forEach(b=>b.classList.toggle("selected",b.dataset.breakType===breakType));
 $("fixedBreakDuration").textContent=BREAK_DURS[breakType]+" min";
}
function epochToIndiaLocal(ms){
 const p=new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(ms)).replace(" ","T");
 return p.slice(0,16);
}
function doTick(){
 renderRealClock();
 // Initial focus windows keep their original fixed deadline, including manual pauses.
 // Recovery has no wall-clock deadline: pauses never consume the remaining focus target.
 if(db.timer.sessionId&&db.timer.mode!=="recovery"&&db.timer.deadline&&nowMs()>=db.timer.deadline)closeAttemptAtDeadline(db.timer.deadline);
 if(db.timer.mode==="recovery"&&db.timer.state==="running"){
   const recoverySession=getActiveSession();
   if(recoverySession&&sessionFocusMs(recoverySession,nowMs())>=sessionTargetMs(recoverySession))completeRecoveryAtTarget(nowMs());
 }
 // Catch scheduled breaks while the app is open. Browsers cannot guarantee background execution while closed.
 processSchedule();
 if(db.timer.state==="break"&&db.breakState&&nowMs()>=db.breakState.endAt)finishBreak();
 updateTimerView();
}
const OWNER_EMAIL = "drparuls580@gmail.com";
const CLOUD_FORMAT = "pomo-clock-encrypted-v1";
function authMessage(message, kind="") {
 const el=$("authMessage"); if(!el)return; el.textContent=message; el.className="auth-message"+(kind?" "+kind:"");
}
function showPassphrasePanel(isNew) {
 $("passphrasePanel").hidden=false;
 $("confirmPassphraseWrap").hidden=!isNew;
 $("passphraseTitle").textContent=isNew?"Create your POMO Clock password":"Unlock your private data";
 $("passphraseHelp").textContent=isNew
  ?"Create a strong password of at least 12 characters. It encrypts your private records before cloud backup. It cannot be recovered if forgotten."
  :"Enter the password you created for POMO Clock. Your encrypted records cannot be decrypted without it.";
 $("unlockBtn").textContent=isNew?"Create password & secure data":"Unlock POMO Clock";
 $("appPassphrase").value="";$("confirmPassphrase").value="";$("appPassphrase").focus();
 $("passphrasePanel").dataset.mode=isNew?"create":"unlock";
}
function bytesToB64(bytes){let binary="";new Uint8Array(bytes).forEach(b=>binary+=String.fromCharCode(b));return btoa(binary);}
function b64ToBytes(value){const binary=atob(value);return Uint8Array.from(binary,c=>c.charCodeAt(0));}
async function deriveEncryptionKey(passphrase,saltBytes){
 const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(passphrase),"PBKDF2",false,["deriveKey"]);
 return crypto.subtle.deriveKey({name:"PBKDF2",salt:saltBytes,iterations:310000,hash:"SHA-256"},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function encryptData(data){
 if(!encryptionKey||!encryptionSalt)throw new Error("POMO Clock is locked");
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const plain=new TextEncoder().encode(JSON.stringify(data));
 const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},encryptionKey,plain);
 return {format:CLOUD_FORMAT,salt:bytesToB64(encryptionSalt),iv:bytesToB64(iv),ciphertext:bytesToB64(cipher),updatedAt:Date.now(),owner:OWNER_EMAIL};
}
async function decryptData(envelope){
 if(!encryptionKey)throw new Error("Encryption key is unavailable");
 if(!envelope||envelope.format!==CLOUD_FORMAT||!envelope.iv||!envelope.ciphertext)throw new Error("This is not a supported encrypted POMO Clock backup");
 const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64ToBytes(envelope.iv)},encryptionKey,b64ToBytes(envelope.ciphertext));
 return JSON.parse(new TextDecoder().decode(plain));
}
async function saveEncryptedLocal(data){
 const seq=++localEncryptWriteSeq;
 const envelope=await encryptData(data);
 if(seq!==localEncryptWriteSeq)return;
 localStorage.setItem(LOCAL_ENC_KEY,JSON.stringify(envelope));
 localStorage.removeItem(DB_KEY);
}
function firebaseConfigured(){
 const c=window.POMO_FIREBASE_CONFIG;
 return !!(window.firebase&&c&&c.apiKey&&c.apiKey!=="PASTE_API_KEY_HERE"&&c.appId&&c.appId!=="PASTE_APP_ID_HERE"&&c.projectId);
}
function lockApp(){
 cloudReady=false;encryptionKey=null;encryptionSalt=null;authUser=null;document.body.classList.add("auth-locked");$("authGate").hidden=false;
 $("googleSignInBtn").hidden=false;$("passphrasePanel").hidden=true;$("signOutBtn").hidden=true;
}
function unlockApp(){
 document.body.classList.remove("auth-locked");$("authGate").hidden=true;cloudReady=true;
 $("googleSignInBtn").hidden=true;$("passphrasePanel").hidden=true;$("signOutBtn").hidden=true;
 renderAll();toast("POMO Clock unlocked · encrypted cloud sync ready");
}
async function handleFirebaseUser(user){
 if(!user){lockApp();authMessage("Sign in with the authorized Google account to continue.");return;}
 if((user.email||"").toLowerCase()!==OWNER_EMAIL||!user.emailVerified){
   authMessage("Access denied. Use the verified owner account only.","error");
   await firebaseAuth.signOut();return;
 }
 authUser=user;$("googleSignInBtn").hidden=true;$("signOutBtn").hidden=false;
 try{
   const ref=firestore.collection("users").doc(user.uid).collection("privateData").doc("main");
   const snap=await ref.get();window.__pomoCloudRef=ref;
   if(snap.exists){
     window.__pomoCloudEnvelope=snap.data();
     showPassphrasePanel(false);authMessage("Owner verified. Enter your POMO Clock password to decrypt your data.","success");
   }else{
     window.__pomoCloudEnvelope=null;
     const localEnvelope=localStorage.getItem(LOCAL_ENC_KEY);
     if(localEnvelope){window.__pomoLocalEnvelope=JSON.parse(localEnvelope);showPassphrasePanel(false);$("passphrasePanel").dataset.mode="local-unlock";authMessage("Owner verified. Unlock this device's encrypted local records; they will then be secured in Firestore.","success");}
     else {window.__pomoLocalEnvelope=null;showPassphrasePanel(true);authMessage("Owner verified. Create your private encryption password to secure this device's data.","success");}
   }
 }catch(err){authMessage("Could not check your private database. Check Firestore rules and try again: "+err.message,"error");}
}
async function initializeSecureLayer(){
 if(!firebaseConfigured()){
   authMessage("Firebase setup needs one final step: paste the exact Web app config into firebase-config.js, then reload.","error");
   $("googleSignInBtn").disabled=true;return;
 }
 try{
   firebaseApp=firebase.apps.length?firebase.app():firebase.initializeApp(window.POMO_FIREBASE_CONFIG);
   firebaseAuth=firebase.auth();firestore=firebase.firestore();
   const provider=new firebase.auth.GoogleAuthProvider();provider.setCustomParameters({prompt:"select_account"});
   $("googleSignInBtn").addEventListener("click",async()=>{
     try{authMessage("Opening Google sign-in…");await firebaseAuth.signInWithPopup(provider);}catch(err){authMessage("Google sign-in failed: "+err.message,"error");}
   });
   $("unlockBtn").addEventListener("click",completePasswordSetup);
   $("appPassphrase").addEventListener("keydown",e=>{if(e.key==="Enter")completePasswordSetup();});
   $("confirmPassphrase").addEventListener("keydown",e=>{if(e.key==="Enter")completePasswordSetup();});
   $("signOutBtn").addEventListener("click",async()=>{await firebaseAuth.signOut();lockApp();});
   firebaseAuth.onAuthStateChanged(handleFirebaseUser);
 }catch(err){authMessage("Firebase initialization failed: "+err.message,"error");$("googleSignInBtn").disabled=true;}
}
async function completePasswordSetup(){
 const pass=$("appPassphrase").value, mode=$("passphrasePanel").dataset.mode;
 if(pass.length<12){authMessage("Use a password with at least 12 characters.","error");return;}
 if(mode==="create"&&pass!==$("confirmPassphrase").value){authMessage("The two passwords do not match.","error");return;}
 $("unlockBtn").disabled=true;authMessage(mode==="create"?"Encrypting your existing local records…":"Decrypting your private records…");
 try{
   const ref=window.__pomoCloudRef;
   if(mode==="create"){
     encryptionSalt=crypto.getRandomValues(new Uint8Array(16));encryptionKey=await deriveEncryptionKey(pass,encryptionSalt);
     cloudReady=true;
     await ref.set(await encryptData(db));
     await saveEncryptedLocal(db);
   }else if(mode==="local-unlock"){
     const localEnvelope=window.__pomoLocalEnvelope;
     encryptionSalt=b64ToBytes(localEnvelope.salt);encryptionKey=await deriveEncryptionKey(pass,encryptionSalt);
     const localData=await decryptData(localEnvelope);
     db={...blankDb(),...localData,timer:{...blankDb().timer,...(localData.timer||{})}};normalizeDbSessions();
     cloudReady=true;await ref.set(await encryptData(db));await saveEncryptedLocal(db);
   }else{
     const envelope=window.__pomoCloudEnvelope;
     encryptionSalt=b64ToBytes(envelope.salt);encryptionKey=await deriveEncryptionKey(pass,encryptionSalt);
     const remote=await decryptData(envelope);
     let localData=null;const localText=localStorage.getItem(LOCAL_ENC_KEY);
     if(localText){try{localData=await decryptData(JSON.parse(localText));}catch(e){localData=null;}}
     const localCandidate=localData||db;
     const localHasData=(localCandidate.sessions?.length||0)+(localCandidate.breaks?.length||0)>0;
     const remoteHasData=(remote.sessions?.length||0)+(remote.breaks?.length||0)>0;
     if(localHasData&&(!remoteHasData||safeNum(localCandidate.updatedAt,0)>safeNum(envelope.updatedAt,0))){
       db={...blankDb(),...localCandidate,timer:{...blankDb().timer,...(localCandidate.timer||{})}};normalizeDbSessions();
       cloudReady=true;await ref.set(await encryptData(db));await saveEncryptedLocal(db);
     }else{
       db={...blankDb(),...remote,timer:{...blankDb().timer,...(remote.timer||{})}};normalizeDbSessions();
       cloudReady=true;persist({cloud:false});hydrateInputs();
     }
   }
   unlockApp();
   if(mode==="create")toast("Private encryption password created · local records secured in Firestore");
   else queueCloudSync();
 }catch(err){cloudReady=false;encryptionKey=null;encryptionSalt=null;authMessage(mode==="unlock"?"Password incorrect or encrypted data could not be read. Try again.":"Could not secure your data: "+err.message,"error");}
 finally{$("unlockBtn").disabled=false;}
}
function queueCloudSync(){
 if(!cloudReady||!authUser||!window.__pomoCloudRef)return;
 clearTimeout(cloudSyncTimer);cloudSyncTimer=setTimeout(async()=>{
   try{await window.__pomoCloudRef.set(await encryptData(db));$("saveBadge").textContent="CLOUD-SAVED";}
   catch(err){console.error("POMO cloud sync",err);toast("Cloud sync failed. Your local data is still saved.");}
 },1800);
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
 if(!encryptionKey){if(!quiet)toast("Unlock POMO Clock before creating encrypted backups.");return;}
 try {
   const payload=await encryptData(db);
   await upsertDriveJson("POMO-Clock-Latest.enc.json",payload);
   if(daily){
     const name=`POMO-Clock-Daily-${fmtDateKey(new Date())}.json`;
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
 if(!encryptionKey){toast("Unlock POMO Clock before restoring encrypted backups.");return;}
 try{
   const f=await findDriveFile("POMO-Clock-Latest.enc.json");
   if(!f){toast("No latest backup found in Drive yet. Sync first.");return;}
   if(!confirm("Restore the latest Google Drive backup? This will replace the current local session data. Export a JSON backup first if you need to keep both."))return;
   const payload=await driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
   const incoming=await decryptData(payload);
   if(!incoming||!Array.isArray(incoming.sessions))throw new Error("The Drive file is not a valid encrypted POMO Clock backup.");
   db={...blankDb(),...incoming,timer:{...blankDb().timer,...incoming.timer}};normalizeDbSessions();
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
 $("saveSessionNameBtn").addEventListener("click",saveSessionName);
 $("sessionName").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();saveSessionName();}});
 $("stopwatchStartPause").addEventListener("click",toggleStopwatch);
 $("stopwatchSave").addEventListener("click",finishStopwatch);
 $("stopwatchReset").addEventListener("click",resetStopwatch);
 $("startPauseBtn").addEventListener("click",()=>{
   const st=db.timer.state;
   if(st==="running")pauseFocus("manual");
   else if(st==="paused")resumeFocus();
   else if(st==="idle")startFocus(safeNum($("durationMinutes").value,120));
 });
 $("resetTimerBtn").addEventListener("click",()=>{
   stopAlarm();
   if(db.timer.state==="running"||db.timer.state==="paused"){
     if(!confirm("End this active session and reset the timer?"))return;
     finishSession("interrupted","Manual reset");
   }
   if(db.timer.state==="break"&&db.breakState){
     if(!confirm("End the active break and reset the timer?"))return;
     const b=db.breakState,now=nowMs();b.actualEndAt=now;b.actualMinutes=Math.max(0,(now-b.startAt)/60000);b.status="ended by reset";b.manualEnd=true;db.breakState=null;
     if(b.sessionId&&db.timer.sessionId===b.sessionId)finishSession("interrupted","Reset during scheduled break",now);
     else endTimerToIdle();
     if(db.breakSchedule&&db.breakSchedule.status==="started")db.breakSchedule.status="cancelled";
   }
   db.timer.state="idle";db.timer.remainingMs=safeNum($("durationMinutes").value,120)*60000;db.timer.deadline=null;db.timer.startedAt=null;db.timer.sessionId=null;db.timer.mode=null;db.timer.attemptId=null;stopAlarm();persist();updateTimerView();toast("Timer reset");
 });
 $("stopSessionBtn").addEventListener("click",()=>{if(confirm("End this focus window now and save any remaining time for later recovery?"))finishSession("partial","Manually ended before target");});
 $("skipBreakBtn").addEventListener("click",()=>{if(db.breakState){if(confirm("End this break now and start the next focus session?"))finishBreak(true);}});
 $("applyDuration").addEventListener("click",()=>{
   const mins=Math.round(safeNum($("durationMinutes").value,120));if(mins<1||mins>120){toast("Choose a duration from 1 to 120 minutes.");return;}
   if(db.timer.state==="running"||db.timer.state==="paused"||db.timer.state==="break"){toast("Pause/end the active timer before changing duration.");return;}
   db.timer.duration=mins;db.timer.remainingMs=mins*60000;localStorage.setItem(DUR_KEY,String(mins));persist();updateTimerView();toast(`Default session set to ${mins} min`);
 });
 $("durationMinutes").addEventListener("change",()=>{
  if(db.timer.state==="idle"){const v=Math.max(1,Math.min(120,Math.round(safeNum($("durationMinutes").value,120))));$("durationMinutes").value=v;}
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
 $("restoreLocalBtn").addEventListener("click",()=>{const idx=Number($("localSnapshotSelect").value),snap=db.backupSnapshots[idx];if(!snap||!snap.data){toast("Choose a valid snapshot.");return;}if(!confirm(`Restore local snapshot from ${snap.date}? Current data will be replaced.`))return;const history=db.backupSnapshots;db={...blankDb(),...snap.data,timer:{...blankDb().timer,...snap.data.timer},backupSnapshots:history};normalizeDbSessions();persist({cloud:false});hydrateInputs();renderAll();toast("Local snapshot restored");});
 $("googleClientId").value=localStorage.getItem(CLIENT_KEY)||"";
 window.addEventListener("beforeunload",()=>{if(db&&cloudReady)persist({cloud:false});});
 document.addEventListener("visibilitychange",()=>{if(!document.hidden){doTick();renderAnalytics();}});
}
loadDb();
const lastDur=safeNum(localStorage.getItem(DUR_KEY),120);
if(!db.timer||!db.timer.duration)db.timer={...blankDb().timer,duration:lastDur,remainingMs:lastDur*60000};
if(db.timer.sessionId&&db.timer.deadline&&nowMs()>=db.timer.deadline){closeAttemptAtDeadline(db.timer.deadline);}
buildDial();buildStopwatchDial();loadStopwatch();hydrateInputs();initEvents();renderAll();updateStopwatchView();
initializeSecureLayer();
setInterval(()=>{if(db)doTick();},250);
setInterval(()=>{if(db&&cloudReady){const day=fmtDateKey(new Date());if(db.lastLocalBackupDate!==day)persist();}},30000);
setInterval(()=>{if(stopwatch.running)updateStopwatchView();},250);
})();
