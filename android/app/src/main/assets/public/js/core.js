/* Delta Vault 2.0 core: bridge, helpers, modal, jobs, pane switching, sidebar. */
(function(){
'use strict';

const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DV=window.DV={panes:{},S:{access:null,vols:[],shortcuts:[],pane:'files',cwd:'',query:'',started:false},$,$$,esc};

DV.LS={
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
};
DV.sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- native bridge ---------- */
const Cap=window.Capacitor||null;
DV.isNative=!!(Cap&&typeof Cap.isNativePlatform==='function'&&Cap.isNativePlatform());
function plugin(n){
  try{ return (Cap&&Cap.Plugins&&Cap.Plugins[n])||(Cap&&Cap.registerPlugin?Cap.registerPlugin(n):null); }catch(e){ return null; }
}
DV.P=DV.isNative?plugin('DeltaFiles'):null;
DV.App=DV.isNative?plugin('App'):null;
DV.nat=async function(method,args){
  if(!DV.P) throw new Error('Open this app on an Android device.');
  try{ return await DV.P[method](args||{}); }
  catch(e){ throw new Error((e&&(e.message||e.errorMessage))||'Operation failed.'); }
};
DV.fileUrl=function(path){
  const enc=path.split('/').map(encodeURIComponent).join('/');
  return Cap&&Cap.convertFileSrc?Cap.convertFileSrc(enc):'file://'+enc;
};

/* ---------- icons ---------- */
const ICONS={
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  doc:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  img:'<rect x="3" y="4" width="18" height="16"/><circle cx="9" cy="10" r="1.6"/><path d="M3 18l5-5 4 4 3-3 6 6"/>',
  vid:'<rect x="3" y="5" width="18" height="14"/><path d="M10 9l5 3-5 3z"/>',
  aud:'<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  code:'<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
  arc:'<rect x="4" y="3" width="16" height="18"/><path d="M12 3v10M10 7h4M10 11h4"/>',
  sheet:'<rect x="4" y="4" width="16" height="16"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  card:'<path d="M7 3h8l3 3v15H7z"/><path d="M10 7v3M13 7v3"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  lock:'<rect x="5" y="11" width="14" height="9"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2"/>',
  dupes:'<rect x="8" y="8" width="12" height="12"/><path d="M4 16V4h12"/>',
  map:'<rect x="3" y="4" width="18" height="16"/><path d="M12 4v16M3 12h9M12 9h9"/>',
  big:'<path d="M4 20h16M7 20V10M12 20V4M17 20v-7"/>',
  files:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
};
DV.ICONS=ICONS;
DV.icon=n=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true">'+(ICONS[n]||ICONS.file)+'</svg>';
DV.CHECK='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

/* ---------- file kinds ---------- */
const EXT={
  img:['jpg','jpeg','png','gif','webp','bmp','heic','heif','svg','avif'],
  vid:['mp4','mkv','webm','3gp','mov','avi','m4v','ts'],
  aud:['mp3','m4a','wav','ogg','flac','aac','opus','amr','mid'],
  arc:['zip','rar','7z','tar','gz','tgz','apk','xapk','obb'],
  sheet:['csv','tsv','xlsx','xls','ods'],
  code:['js','css','html','htm','json','xml','py','sh','yml','yaml','java','kt','c','cpp','h'],
  doc:['txt','md','log','pdf','doc','docx','ppt','pptx','odt','rtf','ini','cfg']
};
const KIND_OF={}; Object.keys(EXT).forEach(k=>EXT[k].forEach(e=>{ KIND_OF[e]=k; }));
DV.THUMB=new Set(['jpg','jpeg','png','gif','webp','bmp','avif']);
DV.TEXTEXT=new Set(['txt','md','csv','tsv','json','log','js','css','html','htm','xml','yml','yaml','ini','cfg','py','sh','java','kt','c','cpp','h','srt','vtt','conf','properties']);
DV.extOf=n=>{ const i=n.lastIndexOf('.'); return i>0?n.slice(i+1).toLowerCase():''; };
DV.kindOf=it=>it.dir?'folder':(KIND_OF[DV.extOf(it.name)]||'file');
DV.typeLabel=it=>it.dir?'FOLDER':(DV.extOf(it.name)||'FILE').toUpperCase();
DV.parentOf=p=>p.slice(0,p.lastIndexOf('/'))||'/';
DV.baseOf=p=>p.slice(p.lastIndexOf('/')+1);
DV.thumbFor=it=>(!it.dir&&DV.kindOf(it)==='img'&&DV.THUMB.has(DV.extOf(it.name))&&it.size>0&&it.size<8e6)?DV.fileUrl(it.path):'';

/* ---------- formatting ---------- */
DV.fmtSize=function(b){
  b=Number(b)||0;
  if(b<1024) return b+' B';
  const u=['KB','MB','GB','TB']; let i=-1;
  do{ b/=1024; i++; }while(b>=1024&&i<u.length-1);
  return (b>=100?b.toFixed(0):b.toFixed(1))+' '+u[i];
};
const MON=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const p2=n=>String(n).padStart(2,'0');
DV.fmtDate=function(t){ const d=new Date(t); return p2(d.getDate())+' '+MON[d.getMonth()]+' '+String(d.getFullYear()).slice(2)+' · '+p2(d.getHours())+':'+p2(d.getMinutes()); };
DV.fmtShort=function(t){ const d=new Date(t); return p2(d.getDate())+' '+MON[d.getMonth()]+' '+String(d.getFullYear()).slice(2); };
DV.fmtTime=function(){ const d=new Date(); return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds()); };
DV.plural=(n,a,b)=>n+' '+(n===1?a:(b||a+'s'));

/* ---------- toast, log, busy ---------- */
let toastT=0;
DV.toast=function(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),3200); };
const oplog=[];
DV.logOp=function(msg){ oplog.unshift({t:DV.fmtTime(),msg}); if(oplog.length>6) oplog.pop(); renderLog(); };
function renderLog(){
  $('#log').innerHTML=oplog.length?oplog.map(o=>'<li><time>'+o.t+'</time>'+esc(o.msg)+'</li>').join(''):'<li>No operations yet.</li>';
}
let busyTimer=0;
DV.busy=async function(label,fn){
  clearTimeout(busyTimer);
  busyTimer=setTimeout(()=>{ $('#busy-t').textContent=label; $('#busy').hidden=false; },250);
  try{ return await fn(); }
  catch(e){ DV.toast(e.message||'Operation failed.'); return undefined; }
  finally{ clearTimeout(busyTimer); $('#busy').hidden=true; }
};
DV.isBusy=()=>!$('#busy').hidden;

/* ---------- modal ---------- */
let modalEl=null;
DV.modalOpen=()=>!!modalEl;
DV.closeModal=function(reason){
  if(!modalEl) return;
  const m=modalEl; modalEl=null; m.remove();
  if(reason!=='ok'&&m._onCancel){ try{ m._onCancel(); }catch(e){} }
};
DV.modal=function(o){
  DV.closeModal('replace');
  const m=document.createElement('div'); m.className='modal';
  m.innerHTML='<div class="mp panel" role="dialog" aria-modal="true" aria-label="'+esc(o.title)+'"><div class="haz"></div><div class="mh">'+esc(o.title)+'</div><div class="mb"></div><div class="mf"><button class="btn" type="button" data-x>'+esc(o.cancel||'Cancel')+'</button><button class="btn '+(o.danger?'dng':'pri')+'" type="button" data-ok>'+esc(o.ok||'Confirm')+'</button></div></div>';
  const mb=$('.mb',m); if(typeof o.body==='string') mb.innerHTML=o.body; else mb.appendChild(o.body);
  m._onCancel=o.onCancel;
  m.addEventListener('mousedown',e=>{ if(e.target===m) DV.closeModal('cancel'); });
  $('[data-x]',m).addEventListener('click',()=>DV.closeModal('cancel'));
  const ok=$('[data-ok]',m);
  ok.addEventListener('click',async()=>{
    if(ok.disabled) return;
    ok.disabled=true; let r;
    try{ r=o.onOk?await o.onOk(m):true; }catch(e){ r=false; DV.toast(e.message||'Operation failed.'); }
    ok.disabled=false;
    if(r!==false&&modalEl===m) DV.closeModal('ok');
  });
  document.body.appendChild(m); modalEl=m;
  if(o.focus) o.focus(m); else ok.focus();
  return m;
};
DV.askName=function(o,cb){
  const w=document.createElement('div');
  w.innerHTML='<label for="nm-in">'+esc(o.label||'Name')+'</label><input class="in" id="nm-in" type="text" maxlength="200" autocomplete="off" spellcheck="false" autocapitalize="off"><div class="err" role="alert"></div>';
  const inp=$('input',w); inp.value=o.value||'';
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('[data-ok]',modalEl).click(); } });
  DV.modal({title:o.title,body:w,ok:o.ok,
    focus:()=>{ inp.focus(); const dot=(o.value||'').lastIndexOf('.'); inp.setSelectionRange(0,o.select&&dot>0?dot:inp.value.length); },
    onOk:async()=>{
      const name=inp.value.trim(), err=$('.err',w);
      if(!name){ err.textContent='Enter a name.'; return false; }
      if(/[\/\\\u0000]/.test(name)||name==='.'||name==='..'){ err.textContent='Names cannot contain slashes.'; return false; }
      const msg=await cb(name);
      if(msg){ err.textContent=msg; return false; }
    }});
};
DV.confirm=function(o){
  return new Promise(resolve=>{
    let done=false; const fin=v=>{ if(!done){ done=true; resolve(v); } };
    DV.modal({title:o.title,body:o.body,ok:o.ok,danger:o.danger,cancel:o.cancel,
      onOk:async()=>{ if(o.onOk){ const r=await o.onOk(); if(r===false) return false; } fin(true); },
      onCancel:()=>fin(false)});
  });
};

/* ---------- list rows shared by the tool panes ---------- */
DV.rowHTML=function(o){
  const ic=o.thumb?'<img class="th" loading="lazy" decoding="async" alt="" src="'+esc(o.thumb)+'">':DV.icon(o.k||'file');
  return '<div class="lrow'+(o.sel?' sel':'')+(o.cls?' '+o.cls:'')+'" role="option" aria-selected="'+(!!o.sel)+'" tabindex="0" data-id="'+esc(o.id)+'" data-k="'+(o.k||'file')+'">'+
    '<button class="chk" type="button" data-chk tabindex="-1" aria-label="Select '+esc(o.name)+'">'+(o.sel?DV.CHECK:'')+'</button>'+
    '<span class="ic">'+ic+'</span>'+
    '<span class="main"><b title="'+esc(o.name)+'">'+esc(o.name)+'</b>'+(o.tag?'<i class="tag">'+esc(o.tag)+'</i>':'')+(o.sub?'<small class="pth">'+esc(o.sub)+'</small>':'')+'</span>'+
    '<span class="meta">'+(o.meta||'')+'</span></div>';
};
DV.emptyBox=function(title,text,btn){ return '<div class="empty"><div class="haz"></div><h3>'+esc(title)+'</h3><p>'+text+'</p>'+(btn||'')+'</div>'; };
document.addEventListener('error',e=>{
  const t=e.target;
  if(t&&t.classList&&t.classList.contains('th')) t.outerHTML=DV.icon('img');
},true);

/* ---------- background jobs (storage scan, duplicate search) ---------- */
DV.startJob=function(method,args,onStatus){
  const h={id:null,promise:null};
  h.promise=(async()=>{
    const r=await DV.nat(method,args); h.id=r.id;
    for(;;){
      await DV.sleep(450);
      const s=await DV.nat('jobStatus',{id:r.id});
      if(onStatus) onStatus(s);
      if(s.done){ if(s.error) throw new Error(s.error); return s; }
    }
  })();
  h.cancel=()=>{ if(h.id) DV.nat('jobCancel',{id:h.id}).catch(()=>{}); };
  return h;
};

/* ---------- volumes + sidebar ---------- */
DV.volOf=p=>DV.S.vols.find(v=>p===v.path||p.startsWith(v.path+'/'))||null;
DV.refreshVols=async function(){
  const r=await DV.nat('roots');
  DV.S.vols=r.volumes||[]; DV.S.shortcuts=r.shortcuts||[];
  DV.renderSide();
};
DV.renderSide=function(){
  const cwd=DV.S.cwd, inFiles=DV.S.pane==='files'&&!DV.S.query;
  $('#locs').innerHTML=DV.S.vols.length?DV.S.vols.map(v=>'<div class="tn'+(inFiles&&cwd===v.path?' on':'')+'"><button class="tl" type="button" data-go="'+esc(v.path)+'">'+DV.icon(v.primary?'folder':'card')+'<span>'+esc(v.name)+'</span><em>'+DV.fmtSize(v.free)+' free</em></button></div>').join(''):'<p class="mono sm mute" style="margin:0">No storage found.</p>';
  $('#shorts').innerHTML=DV.S.shortcuts.length?DV.S.shortcuts.map(s=>'<div class="tn'+(inFiles&&cwd===s.path?' on':'')+'"><button class="tl" type="button" data-go="'+esc(s.path)+'">'+DV.icon('folder')+'<span>'+esc(s.name)+'</span></button></div>').join(''):'<p class="mono sm mute" style="margin:0">None yet.</p>';
  const v=DV.volOf(cwd)||DV.S.vols[0];
  if(!v||!v.total){ $('#stat').textContent=''; $('#mfill').style.width='0'; }
  else{
    const used=v.total-v.free;
    $('#stat').textContent=DV.fmtSize(used)+' used · '+DV.fmtSize(v.free)+' free of '+DV.fmtSize(v.total);
    $('#mfill').style.width=Math.max(2,Math.min(100,used/v.total*100))+'%';
  }
};
DV.setSide=function(on){ $('#side').classList.toggle('open',on); $('#scrim').classList.toggle('show',on); };
DV.sideOpen=()=>$('#side').classList.contains('open');

/* ---------- panes ---------- */
DV.registerPane=function(name,impl){ DV.panes[name]=impl; };
DV.setPane=function(name){
  const prev=DV.S.pane;
  if(prev===name) return;
  const pp=DV.panes[prev]; if(pp&&pp.hide) pp.hide();
  DV.S.pane=name; document.body.dataset.pane=name;
  $$('.pane').forEach(p=>{ p.hidden=p.id!=='pane-'+name; });
  $$('#tabs [data-pane]').forEach(b=>{ const on=b.dataset.pane===name; b.setAttribute('aria-selected',String(on)); b.classList.toggle('on',on); });
  const np=DV.panes[name]; if(np&&np.show) np.show();
  DV.setSide(false); DV.renderSide(); window.scrollTo(0,0);
};
DV.openFolder=function(path){
  DV.setPane('files');
  if(DV.files) DV.files.go(path);
};

document.addEventListener('click',e=>{
  const t=e.target.closest('#tabs [data-pane]'); if(t){ DV.setPane(t.dataset.pane); return; }
  const g=e.target.closest('[data-go]'); if(g){ DV.openFolder(g.dataset.go); return; }
  const o=e.target.closest('[data-open-folder]'); if(o){ DV.openFolder(o.dataset.openFolder); return; }
});
document.addEventListener('DOMContentLoaded',()=>{});
$('#scrim').addEventListener('click',()=>DV.setSide(false));

renderLog();
})();
