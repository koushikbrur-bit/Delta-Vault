/* Private locker: PIN-protected app-private storage. */
(function(){
'use strict';
const DV=window.DV, $=DV.$, esc=DV.esc;
let st={set:false,open:false,lockedFor:0};
let rel='', items=[], sel=new Set(), loading=false, err='', cdTimer=0, loaded=false;
const inPane=()=>DV.S.pane==='locker';

function syncSecure(){ if(DV.P) DV.P.setSecure({on:inPane()&&st.open}).catch(()=>{}); }
async function refreshStatus(){
  if(!DV.P){ loaded=true; return st; }
  try{ st=await DV.nat('pinStatus'); }catch(e){ err=e.message; }
  loaded=true; return st;
}
async function lockNow(silent){
  if(DV.P) try{ await DV.nat('lock'); }catch(e){}
  st.open=false; rel=''; items=[]; sel.clear();
  if(DV.viewer) DV.viewer.closeIfSecure();
  syncSecure(); if(inPane()) render();
  if(!silent) DV.toast('Locker locked.');
}

/* ---------- PIN prompt used by the locker pane and by "Lock" in Files ---------- */
function askPin(o){
  return new Promise(resolve=>{
    let fin=false; const done=v=>{ if(!fin){ fin=true; resolve(v); } };
    const w=document.createElement('div');
    w.innerHTML='<p style="margin:0 0 12px;color:var(--mute)">'+esc(o.text||'Enter your PIN.')+'</p><input class="in pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" aria-label="PIN"><div class="err" role="alert"></div>';
    const inp=$('input',w), er=$('.err',w);
    inp.addEventListener('input',()=>{ inp.value=inp.value.replace(/\D/g,''); });
    inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('[data-ok]',document.querySelector('.modal')).click(); } });
    DV.modal({title:o.title||'Enter PIN',body:w,ok:o.ok||'Unlock',focus:()=>inp.focus(),
      onOk:async()=>{
        if(inp.value.length<4){ er.textContent='Enter 4 to 8 digits.'; return false; }
        const r=await DV.nat('pinVerify',{pin:inp.value});
        if(!r.ok){ er.textContent=r.lockedFor>0?'Too many tries. Wait '+Math.ceil(r.lockedFor/1000)+' s.':'Wrong PIN. '+r.attemptsLeft+' tries left.'; inp.value=''; inp.focus(); return false; }
        st.open=true; done(true);
      },onCancel:()=>done(false)});
  });
}
DV.askPin=askPin;

function newPinForm(o){
  const w=document.createElement('div');
  w.innerHTML=(o.old?'<div class="fld"><label for="np-o">Current PIN</label><input class="in pin" id="np-o" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>':'')+
    '<div class="fld"><label for="np-a">New PIN (4 to 8 digits)</label><input class="in pin" id="np-a" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>'+
    '<div class="fld"><label for="np-b">Repeat new PIN</label><input class="in pin" id="np-b" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div><div class="err" role="alert"></div>';
  $$all(w).forEach(i=>i.addEventListener('input',()=>{ i.value=i.value.replace(/\D/g,''); }));
  return w;
}
function $$all(w){ return Array.from(w.querySelectorAll('input')); }

/* ---------- views ---------- */
function render(){
  const body=$('#lk-body'); if(!body) return;
  clearInterval(cdTimer);
  $('#lk-ctl').hidden=!(st.set&&st.open);
  if(!DV.P){ body.innerHTML=DV.emptyBox('Android only','The private locker works inside the Android app.'); return; }
  if(!loaded){ body.innerHTML='<div class="card"><p>Loading</p></div>'; return; }
  if(!st.set) return createView(body);
  if(!st.open) return lockedView(body);
  openView(body);
}
function createView(body){
  body.innerHTML='<div class="card narrow"><h3>Create a PIN</h3><p>Files you lock are moved into private storage that other apps and file managers cannot see. They stay hidden until you enter this PIN.</p>'+
    '<div class="fld"><label for="c-a">PIN (4 to 8 digits)</label><input class="in pin" id="c-a" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>'+
    '<div class="fld"><label for="c-b">Repeat PIN</label><input class="in pin" id="c-b" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>'+
    '<div class="card warnc"><p><b style="color:var(--fg)">Read this.</b> If you forget the PIN, nobody can recover your locked files, including us. The only way back in is to erase the locker. Uninstalling the app or clearing its data also deletes everything inside.</p></div>'+
    '<label class="chkrow"><input type="checkbox" id="c-ok"> I understand</label><div class="err" id="c-err" role="alert" style="margin-top:8px"></div>'+
    '<div style="margin-top:12px"><button class="btn pri" type="button" id="c-go">Create locker</button></div></div>';
  $$all(body).forEach(i=>{ if(i.type==='password') i.addEventListener('input',()=>{ i.value=i.value.replace(/\D/g,''); }); });
  $('#c-go').addEventListener('click',async()=>{
    const a=$('#c-a').value, b=$('#c-b').value, er=$('#c-err');
    if(!/^\d{4,8}$/.test(a)){ er.textContent='Use 4 to 8 digits.'; return; }
    if(a!==b){ er.textContent='The two PINs do not match.'; return; }
    if(!$('#c-ok').checked){ er.textContent='Tick the box to confirm you understand.'; return; }
    const r=await DV.busy('Creating locker',()=>DV.nat('pinSet',{pin:a}));
    if(r){ st=r; DV.toast('Locker created.'); DV.logOp('Created the private locker'); syncSecure(); await loadList(''); }
  });
}
function lockedView(body){
  const left=Number(st.lockedFor)||0;
  body.innerHTML='<div class="card narrow"><h3>Locker locked</h3><p>Enter your PIN to open it.</p>'+
    '<input class="in pin" id="u-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="PIN"><div class="err" id="u-err" role="alert" style="margin-top:8px"></div>'+
    '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn pri" type="button" id="u-go">Unlock</button><button class="btn" type="button" id="u-forgot">Forgot PIN</button></div></div>';
  const inp=$('#u-pin'), er=$('#u-err'), go=$('#u-go');
  inp.addEventListener('input',()=>{ inp.value=inp.value.replace(/\D/g,''); });
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter') go.click(); });
  let until=left>0?Date.now()+left:0;
  const tick=()=>{
    const r=until-Date.now();
    if(r>0){ er.textContent='Too many tries. Try again in '+Math.ceil(r/1000)+' s.'; go.disabled=true; inp.disabled=true; }
    else{ if(until){ er.textContent=''; until=0; } go.disabled=false; inp.disabled=false; }
  };
  tick(); if(until) cdTimer=setInterval(tick,500);
  go.addEventListener('click',async()=>{
    if(inp.value.length<4){ er.textContent='Enter 4 to 8 digits.'; return; }
    let r; try{ r=await DV.nat('pinVerify',{pin:inp.value}); }catch(e){ er.textContent=e.message; return; }
    if(r.ok){ st.open=true; syncSecure(); await loadList(''); return; }
    inp.value='';
    if(r.lockedFor>0){ until=Date.now()+r.lockedFor; clearInterval(cdTimer); cdTimer=setInterval(tick,500); tick(); }
    else er.textContent='Wrong PIN. '+r.attemptsLeft+' tries left.';
  });
  $('#u-forgot').addEventListener('click',()=>erase(true));
  if(!until&&!DV.isNative) return; if(!until) setTimeout(()=>{ if(inp.isConnected) inp.focus(); },50);
}
async function loadList(path){
  loading=true; err=''; rel=path||''; sel.clear();
  render();
  try{ const r=await DV.nat('lockerList',{path:rel}); items=(r.entries||[]).sort((a,b)=>(b.dir-a.dir)||a.name.localeCompare(b.name,undefined,{numeric:true})); }
  catch(e){ err=e.message; if(/locked/i.test(e.message)){ st.open=false; syncSecure(); } items=[]; }
  loading=false; render();
}
function openView(body){
  let h='';
  if(err) h+='<div class="card bad"><p>'+esc(err)+'</p></div>';
  const parts=rel?rel.split('/'):[]; let acc='';
  h+='<nav class="crumbs2" aria-label="Locker location"><button class="cr" type="button" data-lk-go="" '+(parts.length?'':'aria-current="true"')+'>Locker</button>'+parts.map((p,i)=>{ acc+=(acc?'/':'')+p; return '<span>/</span><button class="cr" type="button" data-lk-go="'+esc(acc)+'"'+(i===parts.length-1?' aria-current="true"':'')+'>'+esc(p)+'</button>'; }).join('')+'</nav>';
  if(loading) h+='<div class="card"><p>Loading</p></div>';
  else if(!items.length) h+=DV.emptyBox('Nothing here',rel?'This folder is empty.':'Select files in the Files tab and choose Lock to hide them in here.','<button class="btn pri" type="button" data-open-folder="'+esc((DV.S.vols[0]||{}).path||'')+'">Go to Files</button>');
  else h+='<div role="listbox" aria-multiselectable="true" aria-label="Locked items">'+items.map(it=>
    DV.rowHTML({id:it.rel,sel:sel.has(it.rel),k:it.dir?'folder':DV.kindOf(it),name:it.name,sub:it.origin?'From '+it.origin:'',meta:'<strong>'+(it.dir?'Folder':DV.fmtSize(it.size))+'</strong>'+DV.fmtShort(it.modified),cls:it.dir?'open':''})).join('')+'</div>';
  if(sel.size){
    const one=sel.size===1?items.find(x=>x.rel===[...sel][0]):null;
    h+='<div class="abar"><span class="info">'+DV.plural(sel.size,'item')+' selected</span>'+
      (one&&!one.dir?'<button class="btn" type="button" data-lk="open">Open</button><button class="btn" type="button" data-lk="share">Share</button>':'')+
      (one&&one.dir?'<button class="btn" type="button" data-lk="enter">Open folder</button>':'')+
      '<button class="btn pri" type="button" data-lk="restore">Unlock &amp; restore</button><button class="btn dng" type="button" data-lk="del">Delete forever</button><button class="btn" type="button" data-lk="clear">Clear</button></div>';
  }
  body.innerHTML=h;
}
const selItems=()=>items.filter(x=>sel.has(x.rel));
async function doRestore(){
  const rels=[...sel];
  const r=await DV.busy('Restoring',()=>DV.nat('lockerRestore',{paths:rels}));
  if(!r) return;
  DV.logOp('Took '+DV.plural(r.done,'item')+' out of the locker');
  DV.toast(r.failed&&r.failed.length?('Restored '+r.done+'. '+r.failed.length+' failed.'):'Restored to their original folders.');
  await loadList(rel);
}
async function doDelete(){
  const rels=[...sel];
  const ok=await DV.confirm({title:'Delete forever',ok:'Delete forever',danger:true,body:'<p>Permanently delete '+DV.plural(rels.length,'item')+' from the locker? This cannot be undone.</p>'});
  if(!ok) return;
  const r=await DV.busy('Deleting',()=>DV.nat('lockerDelete',{paths:rels}));
  if(r){ DV.logOp('Deleted '+DV.plural(rels.length,'locked item')); await loadList(rel); }
}
function erase(forgot){
  const w=document.createElement('div');
  w.innerHTML='<p style="margin:0 0 10px">'+(forgot?'If you cannot remember the PIN, the only option is to erase the locker.':'This erases the locker.')+' <b>Every locked file is permanently deleted and the PIN is removed.</b> This cannot be undone.</p><div class="fld"><label for="er-in">Type ERASE to confirm</label><input class="in" id="er-in" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false"></div><div class="err" role="alert"></div>';
  DV.modal({title:'Erase locker',body:w,ok:'Erase everything',danger:true,focus:()=>$('#er-in').focus(),
    onOk:async()=>{
      if($('#er-in',w).value.trim()!=='ERASE'){ $('.err',w).textContent='Type ERASE exactly.'; return false; }
      const r=await DV.nat('lockerReset',{confirm:'ERASE'});
      st={set:false,open:false,lockedFor:0}; rel=''; items=[]; sel.clear(); syncSecure();
      DV.logOp('Erased the locker'); DV.toast('Locker erased.'); render();
    }});
}
function changePin(){
  const w=newPinForm({old:true});
  DV.modal({title:'Change PIN',body:w,ok:'Change PIN',focus:()=>$('#np-o',w).focus(),
    onOk:async()=>{
      const o=$('#np-o',w).value, a=$('#np-a',w).value, b=$('#np-b',w).value, er=$('.err',w);
      if(!/^\d{4,8}$/.test(a)){ er.textContent='New PIN must be 4 to 8 digits.'; return false; }
      if(a!==b){ er.textContent='The new PINs do not match.'; return false; }
      const r=await DV.nat('pinChange',{old:o,pin:a});
      if(!r.ok){ er.textContent=r.lockedFor>0?'Too many tries. Wait a moment.':'Current PIN is wrong. '+r.attemptsLeft+' tries left.'; return false; }
      DV.toast('PIN changed.'); DV.logOp('Changed the locker PIN');
    }});
}

/* ---------- called from Files ---------- */
async function lockPaths(paths){
  if(!DV.P) return false;
  await refreshStatus();
  if(!st.set){
    DV.toast('Create a PIN first.'); DV.setPane('locker'); return false;
  }
  if(!st.open){ const ok=await askPin({title:'Unlock locker',text:'Enter your PIN to move files into the locker.'}); if(!ok) return false; }
  const r=await DV.busy('Locking',()=>DV.nat('lockerAdd',{paths}));
  if(r){
    DV.logOp('Locked '+DV.plural(r.done,'item'));
    DV.toast(r.failed&&r.failed.length?('Locked '+r.done+'. '+r.failed.length+' failed.'):'Locked away in the private locker.');
  }
  if(!inPane()) await lockNow(true);
  return !!r;
}

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  if(!inPane()) return;
  const g=e.target.closest('[data-lk-go]'); if(g){ loadList(g.dataset.lkGo); return; }
  const a=e.target.closest('[data-lk]');
  if(a){
    const k=a.dataset.lk, one=selItems()[0];
    if(k==='restore') doRestore(); else if(k==='del') doDelete();
    else if(k==='clear'){ sel.clear(); render(); }
    else if(k==='enter'&&one) loadList(one.rel);
    else if(k==='open'&&one) DV.viewer.open(one,items.filter(x=>!x.dir),{secure:true});
    else if(k==='share'&&one) DV.nat('share',{paths:[one.path]}).catch(x=>DV.toast(x.message));
    return;
  }
  const row=e.target.closest('.lrow'); if(!row||!st.open) return;
  const id=row.dataset.id, it=items.find(x=>x.rel===id);
  if(it&&it.dir&&!e.target.closest('[data-chk]')&&!sel.size){ loadList(id); return; }
  if(sel.has(id)) sel.delete(id); else sel.add(id);
  render();
});
$('#lk-lock').addEventListener('click',()=>lockNow());
$('#lk-pin').addEventListener('click',changePin);
$('#lk-erase').addEventListener('click',()=>erase(false));

DV.locker={ lockPaths, refreshStatus, isOpen:()=>st.open, lockNow:()=>lockNow(true) };
DV.registerPane('locker',{
  async show(){
    await refreshStatus();
    if(st.set&&st.open){ syncSecure(); await loadList(rel); } else { syncSecure(); render(); }
  },
  hide(){ if(st.open) lockNow(true); else syncSecure(); clearInterval(cdTimer); },
  onBack(){
    if(sel.size){ sel.clear(); render(); return true; }
    if(st.open&&rel){ loadList(rel.split('/').slice(0,-1).join('/')); return true; }
    return false;
  }
});
})();
