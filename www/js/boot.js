/* Boot: access gate, hardware back button, app lifecycle, clock. */
(function(){
'use strict';
const DV=window.DV, $=DV.$;
let access=null;

function renderAcc(){
  const b=$('#acc'); const a=access;
  let cls='chip', t='Not on Android';
  if(DV.P&&a){
    if(a.allFiles){ cls+=' ok'; t='Full access'; }
    else if(a.media){ cls+=' warn'; t='Limited access'; }
    else { cls+=' bad'; t='No access'; }
  } else if(DV.P) t='Checking access';
  b.className=cls; b.innerHTML='<i></i>'+t;
}
function showGate(){ $('#gate').hidden=false; renderGate(); }
function hideGate(){ $('#gate').hidden=true; }
function renderGate(){
  const a=access||{}, modern=a.sdk>=30;
  if(!DV.P){
    $('#g-intro').textContent='Delta Vault is a file manager for Android. Install the app on an Android device to browse its storage.';
    $('#g-perms').hidden=true; $('#g-enter').disabled=true; $('#g-limited').hidden=true; return;
  }
  $('#g-perms').hidden=false;
  $('#p-all').hidden=!modern;
  $('#g-media-t').textContent=a.sdk>=33?'Photos, videos and audio':'Storage access';
  $('#g-media-d').textContent=a.sdk>=33?'Lets the app read your media files.':'Lets the app read'+(modern?' your media files.':' and change files on this device.');
  const sm=$('#s-media'), sa=$('#s-all');
  sm.className='chip '+(a.media?'ok':'warn'); sm.textContent=a.media?'Granted':'Needed';
  sa.className='chip '+(a.allFiles?'ok':'warn'); sa.textContent=a.allFiles?'Granted':'Needed';
  $('[data-gate="media"]').hidden=!!a.media;
  $('[data-gate="all"]').hidden=!!a.allFiles;
  $('#g-enter').disabled=!a.allFiles;
  $('#g-limited').hidden=!(modern&&a.media&&!a.allFiles);
  const note=$('#g-note');
  if(modern&&a.media&&!a.allFiles){ note.hidden=false; note.textContent='Without All files access, many folders and files stay hidden.'; }
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-gate]'); if(!b) return;
  try{
    if(b.dataset.gate==='media'){ access=await DV.nat('requestMedia'); }
    else{
      await DV.nat('requestAllFiles');
      const n=$('#g-note'); n.hidden=false; n.textContent='Switch on the option for Delta Vault, then come back to this screen.';
    }
  }catch(err){ DV.toast(err.message); }
  renderAcc(); renderGate();
});
$('#g-enter').addEventListener('click',()=>{ hideGate(); startBrowsing(); });
$('#g-limited').addEventListener('click',()=>{ DV.LS.set('dv-limited','1'); hideGate(); startBrowsing(); });
$('#acc').addEventListener('click',()=>{ if(DV.P&&access&&!access.allFiles) showGate(); });
$('#menu').addEventListener('click',()=>DV.setSide(!DV.sideOpen()));

async function refreshAccess(){
  if(!DV.P) return;
  try{ access=await DV.nat('status'); }catch(e){ return; }
  renderAcc();
  if(!$('#gate').hidden){
    renderGate();
    if(access.allFiles){ hideGate(); startBrowsing(); }
  } else if(!access.media&&!access.allFiles) showGate();
}
async function startBrowsing(){
  try{ await DV.refreshVols(); }catch(e){ DV.toast(e.message); }
  await DV.files.start();
  if(DV.bin) DV.bin.refresh();
}

/* ---------- hardware back + lifecycle ---------- */
function exitApp(){ if(DV.App&&DV.App.exitApp) DV.App.exitApp(); }
function onBack(){
  if(DV.modalOpen()){ DV.closeModal('cancel'); return; }
  if(DV.isBusy()) return;
  if(DV.viewer&&DV.viewer.isOpen()){ DV.viewer.close(); return; }
  if(!$('#gate').hidden){
    if(access&&(access.allFiles||(access.media&&DV.LS.get('dv-limited')==='1'))&&DV.files.isStarted()) hideGate(); else exitApp();
    return;
  }
  if(DV.sideOpen()){ DV.setSide(false); return; }
  const p=DV.panes[DV.S.pane];
  if(p&&p.onBack&&p.onBack()) return;
  if(DV.S.pane!=='files'){ DV.setPane('files'); return; }
  exitApp();
}
if(DV.App&&DV.App.addListener){
  DV.App.addListener('backButton',onBack);
  DV.App.addListener('appStateChange',s=>{
    if(s&&s.isActive) refreshAccess();
    else if(DV.locker&&DV.locker.isOpen()) DV.locker.lockNow();
  });
}
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden) refreshAccess();
  else if(DV.locker&&DV.locker.isOpen()) DV.locker.lockNow();
});

/* ---------- boot ---------- */
(async function boot(){
  $('#clock').textContent=DV.fmtTime();
  setInterval(()=>{ $('#clock').textContent=DV.fmtTime(); },1000);
  renderAcc();
  if(!DV.P){ showGate(); return; }
  try{ access=await DV.nat('status'); }catch(e){ access={sdk:0,media:false,allFiles:false}; }
  renderAcc();
  if(access.allFiles||(access.media&&DV.LS.get('dv-limited')==='1')) startBrowsing();
  else showGate();
})();
})();
