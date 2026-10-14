/* Files tab: browse, select, copy / move / rename, delete to the recycle bin, lock into the private locker. */
(function(){
'use strict';
const DV=window.DV, $=DV.$, $$=DV.$$, esc=DV.esc;

let cwd='', entries=[], results=null, loading=false, loadErr='', searching=false, searchPartial=false;
let sel=new Set(), selMode=false, lastIdx=-1, clip=null;
let view=DV.LS.get('dv-view')==='grid'?'grid':'list';
let sortKey=DV.LS.get('dv-sort')||'name', sortDir=DV.LS.get('dv-dir')==='-1'?-1:1;
let showHidden=DV.LS.get('dv-hidden')==='1';
let query='', vis=[], loadTok=0, searchId=0, searchTimer=0, pvTok=0, started=false;
const narrow=()=>window.matchMedia&&window.matchMedia('(max-width:900px)').matches;

/* ---------- ordering and filtering ---------- */
function visible(){
  const src=query?(results||[]):entries;
  return src.slice().sort(cmp);
}
function cmp(a,b){
  if(a.dir!==b.dir) return a.dir?-1:1;
  let r=0;
  if(sortKey==='name') r=a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'});
  else if(sortKey==='size') r=a.size-b.size;
  else if(sortKey==='modified') r=a.modified-b.modified;
  else r=DV.typeLabel(a).localeCompare(DV.typeLabel(b))||a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'});
  return r*sortDir;
}
const selEntries=()=>vis.filter(x=>sel.has(x.path));
const single=()=>{ const l=selEntries(); return l.length===1?l[0]:null; };

/* ---------- rendering ---------- */
function renderCrumbs(){
  const el=$('#crumbs');
  if(query){
    el.innerHTML='<span class="cr" aria-current="true">Search</span><span>/</span><span class="cr">&ldquo;'+esc(query)+'&rdquo;</span><span class="count">'+(searching?'searching':vis.length+(searchPartial?'+':'')+' match'+(vis.length===1&&!searchPartial?'':'es'))+'</span>';
    return;
  }
  const v=DV.volOf(cwd);
  if(!v){ el.innerHTML='<span class="cr" aria-current="true">'+esc(cwd||'Vault')+'</span>'; return; }
  const rel=cwd.slice(v.path.length).split('/').filter(Boolean);
  let acc=v.path;
  let h='<button class="cr" type="button" data-go="'+esc(v.path)+'"'+(rel.length?'':' aria-current="true"')+'>'+esc(v.name)+'</button>';
  rel.forEach((seg,i)=>{ acc+='/'+seg; h+='<span>/</span><button class="cr" type="button" data-go="'+esc(acc)+'"'+(i===rel.length-1?' aria-current="true"':'')+'>'+esc(seg)+'</button>'; });
  const n=entries.length;
  el.innerHTML=h+'<span class="count">'+n+' item'+(n===1?'':'s')+'</span>';
  el.scrollLeft=el.scrollWidth;
}
function itemHTML(it,i){
  const k=DV.kindOf(it), s=sel.has(it.path), cut=clip&&clip.mode==='move'&&clip.set.has(it.path);
  const sz=it.dir?'Folder':DV.fmtSize(it.size);
  const th=DV.thumbFor(it);
  const ic=th?'<img class="th" loading="lazy" decoding="async" alt="" src="'+esc(th)+'">':DV.icon(k);
  return '<div class="it'+(s?' sel':'')+(cut?' cut':'')+'" role="option" aria-selected="'+s+'" tabindex="0" data-i="'+i+'" data-k="'+k+'">'+
    '<button class="chk" type="button" data-chk tabindex="-1" aria-label="Select '+esc(it.name)+'">'+(s?DV.CHECK:'')+'</button>'+
    '<span class="ic">'+ic+'</span>'+
    '<span class="nm"><b title="'+esc(it.name)+'">'+esc(it.name)+'</b>'+(query?'<small class="pth">'+esc(DV.parentOf(it.path))+'</small>':'')+'</span>'+
    '<span class="sz">'+sz+'</span><span class="ty">'+DV.typeLabel(it)+'</span><span class="dt">'+DV.fmtDate(it.modified)+'</span></div>';
}
function renderField(){
  const f=$('#field');
  $('#fw').classList.toggle('listv',view==='list');
  f.className='field'+(view==='list'?' list':'');
  if(loading){ vis=[]; f.innerHTML=DV.emptyBox('Reading folder','Listing files on this device.'); return; }
  vis=visible();
  if(!vis.length){
    if(loadErr) f.innerHTML=DV.emptyBox('Cannot open folder',esc(loadErr)+'<br><span class="mono sm">'+esc(cwd)+'</span>',cwd&&DV.volOf(cwd)&&cwd!==DV.volOf(cwd).path?'<button class="btn pri" type="button" data-up>Go up</button>':'');
    else if(query&&searching) f.innerHTML=DV.emptyBox('Searching','Looking through this folder and everything inside it.');
    else if(query) f.innerHTML=DV.emptyBox('No matches','Nothing here is named like &ldquo;'+esc(query)+'&rdquo;.');
    else f.innerHTML=DV.emptyBox('Folder empty',showHidden?'This folder has no files.':'No visible files here. Hidden files are off.');
    return;
  }
  f.innerHTML=vis.map(itemHTML).join('');
}
function renderBar(){
  const pb=$('#b-paste');
  pb.hidden=!clip||!cwd;
  if(clip) pb.textContent=(clip.mode==='move'?'Move here':'Paste')+' ('+clip.paths.length+')';
  $('#v-grid').setAttribute('aria-pressed',String(view==='grid'));
  $('#v-list').setAttribute('aria-pressed',String(view==='list'));
  $('#hid').setAttribute('aria-pressed',String(showHidden));
  $('#dir').innerHTML=sortDir===1?'&uarr;':'&darr;';
  $('#sort').value=sortKey;
  $('#clr').hidden=!query;
}
function renderDetail(){
  const d=$('#dbody'), list=selEntries(), tok=++pvTok;
  document.body.classList.toggle('has-sel',list.length>0);
  if(!list.length){
    const n=entries.length;
    d.innerHTML='<div><h3>'+esc(cwd?DV.baseOf(cwd)||'Vault':'Vault')+'</h3><p class="mono sm mute" style="margin:6px 0 0;overflow-wrap:anywhere">'+esc(cwd)+'</p></div>'+
      '<dl class="meta"><dt>Items</dt><dd>'+n+'</dd></dl>'+
      '<div><h4 class="lbl">Controls</h4><ul class="keys"><li><kbd>Tap</kbd>Open folder or inspect file</li><li><kbd>Long press</kbd>Select several</li><li><kbd>F2</kbd>Rename</li><li><kbd>Del</kbd>Delete to bin</li><li><kbd>Backspace</kbd>Up one level</li></ul></div>';
    return;
  }
  if(list.length>1){
    const files=list.filter(x=>!x.dir), tot=files.reduce((s,x)=>s+x.size,0);
    d.innerHTML='<div><h3>'+list.length+' items selected</h3></div><dl class="meta"><dt>Folders</dt><dd>'+(list.length-files.length)+'</dd><dt>Files</dt><dd>'+files.length+'</dd><dt>File size</dt><dd>'+DV.fmtSize(tot)+'</dd></dl>'+
      '<div class="acts"><button class="btn" type="button" data-act="copy">Copy</button><button class="btn" type="button" data-act="cut">Cut</button>'+(files.length?'<button class="btn" type="button" data-act="share">Share</button>':'')+'<button class="btn" type="button" data-act="lock">Lock</button><button class="btn dng" type="button" data-act="del">Delete</button></div>';
    return;
  }
  const it=list[0], k=DV.kindOf(it), ext=DV.extOf(it.name);
  let pv='', after=null;
  if(it.dir) pv='<div class="pv big">'+DV.icon('folder')+'<span id="finfo">Counting contents</span></div>';
  else if(k==='img'&&ext!=='heic'&&ext!=='heif') pv='<div class="pv"><img alt="" src="'+esc(DV.fileUrl(it.path))+'"></div>';
  else if(k==='vid') pv='<div class="pv"><video controls preload="metadata" src="'+esc(DV.fileUrl(it.path))+'"></video></div>';
  else if(k==='aud') pv='<div class="pv" style="padding:16px"><audio controls src="'+esc(DV.fileUrl(it.path))+'"></audio></div>';
  else if(DV.TEXTEXT.has(ext)&&it.size<=50*1024*1024){
    pv='<div class="pv"><pre id="pvtxt">Loading preview</pre></div>';
    after=()=>DV.nat('readText',{path:it.path,max:16384}).then(r=>{
      if(tok!==pvTok) return; const el=$('#pvtxt'); if(!el) return;
      el.textContent=r.binary?'Binary content. No text preview.':(r.text||'(empty file)')+(r.truncated?'\n[preview truncated]':'');
    }).catch(e=>{ const el=$('#pvtxt'); if(el&&tok===pvTok) el.textContent='Preview unavailable: '+e.message; });
  } else pv='<div class="pv big">'+DV.icon(k)+'<span>No preview for this type</span></div>';
  d.innerHTML='<div><h3>'+esc(it.name)+'</h3></div>'+pv+
    '<dl class="meta"><dt>Type</dt><dd>'+DV.typeLabel(it)+'</dd>'+(it.dir?'':'<dt>Size</dt><dd>'+DV.fmtSize(it.size)+' <span class="mute">('+it.size.toLocaleString('en-US')+' B)</span></dd>')+'<dt>Modified</dt><dd>'+DV.fmtDate(it.modified)+'</dd><dt>Path</dt><dd class="mono sm">'+esc(it.path)+'</dd></dl>'+
    '<div class="acts"><button class="btn pri" type="button" data-act="open">'+(it.dir?'Open folder':'Open')+'</button>'+(it.dir?'':'<button class="btn" type="button" data-act="ext">Open with…</button><button class="btn" type="button" data-act="share">Share</button>')+'<button class="btn" type="button" data-act="copy">Copy</button><button class="btn" type="button" data-act="cut">Cut</button><button class="btn" type="button" data-act="rename">Rename</button><button class="btn" type="button" data-act="lock">Lock</button><button class="btn dng" type="button" data-act="del">Delete</button></div>';
  if(after) after();
  if(it.dir) DV.nat('folderInfo',{path:it.path}).then(r=>{
    if(tok!==pvTok) return; const el=$('#finfo'); if(!el) return;
    el.textContent=r.files+' files · '+r.folders+' folders · '+DV.fmtSize(r.bytes)+(r.partial?'+':'');
  }).catch(()=>{ const el=$('#finfo'); if(el&&tok===pvTok) el.textContent='Folder'; });
}
function renderSel(){ renderField(); renderBar(); renderDetail(); }
function render(){
  DV.S.cwd=cwd; DV.S.query=query;
  renderCrumbs(); renderField(); renderBar(); renderDetail(); DV.renderSide();
}

/* ---------- loading + navigation ---------- */
async function load(path){
  const tok=++loadTok;
  loading=true; loadErr=''; cwd=path; DV.S.cwd=path;
  setTimeout(()=>{ if(tok===loadTok&&loading) renderField(); },150);
  try{
    const r=await DV.nat('list',{path,hidden:showHidden});
    if(tok!==loadTok) return;
    entries=r.entries||[]; cwd=r.path||path;
  }catch(e){
    if(tok!==loadTok) return;
    entries=[]; loadErr=e.message;
  }
  loading=false;
  render();
  window.scrollTo(0,0); $('#fw').scrollTop=0;
}
function go(path){
  query=''; $('#q').value=''; searchId++; results=null; searching=false;
  sel=new Set(); selMode=false; lastIdx=-1;
  DV.setSide(false);
  return load(path);
}
function up(){
  const v=DV.volOf(cwd);
  if(!v||cwd===v.path) return false;
  go(DV.parentOf(cwd)); return true;
}
function reload(){ if(query) return runSearch(); return load(cwd); }

/* ---------- search ---------- */
function clearQuery(){ query=''; $('#q').value=''; searchId++; results=null; searching=false; sel=new Set(); selMode=false; render(); }
function onQuery(){
  query=$('#q').value.trim(); clearTimeout(searchTimer); results=null; sel=new Set(); selMode=false;
  if(!query){ searchId++; searching=false; render(); return; }
  searching=true; render();
  searchTimer=setTimeout(runSearch,350);
}
async function runSearch(){
  const id=++searchId, q=query; searching=true;
  try{
    const r=await DV.nat('search',{path:cwd,query:q,hidden:showHidden,limit:400,id});
    if(id!==searchId||q!==query) return;
    results=r.entries||[]; searchPartial=!!r.partial;
  }catch(e){
    if(id!==searchId) return;
    results=[]; DV.toast(e.message);
  }
  searching=false; render();
}

/* ---------- selection ---------- */
function toggle(i){
  const it=vis[i]; if(!it) return;
  if(sel.has(it.path)) sel.delete(it.path); else sel.add(it.path);
  selMode=sel.size>0; lastIdx=i; renderSel();
}
function selectRange(i){
  if(lastIdx<0||!vis[lastIdx]){ toggle(i); return; }
  const a=Math.min(lastIdx,i), b=Math.max(lastIdx,i);
  sel=new Set(vis.slice(a,b+1).map(x=>x.path)); selMode=true; renderSel();
}
function selectOnly(i){
  const it=vis[i]; if(!it) return;
  sel=new Set([it.path]); selMode=false; lastIdx=i; renderSel();
}
function clearSel(){ sel=new Set(); selMode=false; renderSel(); }
function selectAll(){
  if(!vis.length) return;
  if(sel.size===vis.length){ clearSel(); return; }
  sel=new Set(vis.map(x=>x.path)); selMode=true; renderSel();
}

const field=$('#field');
let pressT=0, pressX=0, pressY=0, longFired=false;
field.addEventListener('click',e=>{
  if(e.target.closest('[data-up]')){ up(); return; }
  if(longFired){ longFired=false; return; }
  const row=e.target.closest('.it');
  if(!row){ if(sel.size) clearSel(); return; }
  const i=+row.dataset.i, it=vis[i]; if(!it) return;
  if(e.target.closest('[data-chk]')||e.ctrlKey||e.metaKey||selMode) toggle(i);
  else if(e.shiftKey) selectRange(i);
  else if(it.dir) go(it.path);
  else if(narrow()||e.detail>=2) openInApp(it);
  else selectOnly(i);
});
field.addEventListener('pointerdown',e=>{
  longFired=false;
  if(e.pointerType==='mouse') return;
  const row=e.target.closest('.it'); if(!row) return;
  pressX=e.clientX; pressY=e.clientY;
  clearTimeout(pressT);
  pressT=setTimeout(()=>{ longFired=true; toggle(+row.dataset.i); if(navigator.vibrate){ try{ navigator.vibrate(15); }catch(x){} } },450);
});
field.addEventListener('pointermove',e=>{ if(pressT&&(Math.abs(e.clientX-pressX)>10||Math.abs(e.clientY-pressY)>10)){ clearTimeout(pressT); pressT=0; } });
['pointerup','pointercancel','pointerleave'].forEach(n=>field.addEventListener(n,()=>{ clearTimeout(pressT); pressT=0; }));
field.addEventListener('contextmenu',e=>{
  const row=e.target.closest('.it'); if(!row) return;
  e.preventDefault();
  if(!longFired) toggle(+row.dataset.i);
});
field.addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key===' '){
    const row=e.target.closest&&e.target.closest('.it'); if(!row) return;
    e.preventDefault(); const it=vis[+row.dataset.i];
    if(it&&it.dir) go(it.path); else if(it) openInApp(it);
  }
});

/* ---------- actions ---------- */
function doNewFolder(){
  if(!cwd||query){ if(query) DV.toast('Clear the search first.'); return; }
  DV.askName({title:'New folder',label:'Folder name',value:'New folder',ok:'Create'},async name=>{
    try{ await DV.nat('mkdir',{path:cwd+'/'+name}); }catch(e){ return e.message; }
    DV.logOp('Created '+name); await load(cwd);
  });
}
function doRename(){
  const it=single(); if(!it) return;
  DV.askName({title:'Rename',label:'New name',value:it.name,ok:'Rename',select:!it.dir},async name=>{
    if(name===it.name) return null;
    try{ await DV.nat('rename',{from:it.path,to:DV.parentOf(it.path)+'/'+name}); }catch(e){ return e.message; }
    DV.logOp('Renamed '+it.name+' to '+name); sel=new Set(); await reload();
  });
}
function doDelete(){
  const list=selEntries(); if(!list.length) return;
  const label=list.length===1?'&ldquo;'+esc(list[0].name)+'&rdquo;':list.length+' items';
  const hasDir=list.some(x=>x.dir);
  const w=document.createElement('div');
  w.innerHTML='<p>Move '+label+' to the recycle bin? You can restore '+(list.length===1?'it':'them')+' for 30 days.</p><label class="chkrow"><input type="checkbox" id="perm"><span>Delete permanently instead. There is no undo.'+(hasDir?' Folders are deleted with everything inside.':'')+'</span></label>';
  const m=DV.modal({title:'Delete',ok:'Move to bin',body:w,
    onOk:async()=>{
      const perm=$('#perm',w).checked;
      const r=await DV.busy(perm?'Deleting':'Moving to bin',()=>DV.nat(perm?'delete':'trashMove',{paths:list.map(x=>x.path)}));
      if(!r) return false;
      const failed=r.failed||[];
      const done=perm?list.length-failed.length:(r.done||0);
      if(done===0&&failed.length){
        DV.toast(perm?'Could not delete: '+failed[0]:(/bin|recycle/i.test(failed[0])?'The recycle bin is not available here. Tick "Delete permanently" to remove it.':'Could not move to the bin: '+failed[0]));
        return false;
      }
      DV.logOp((perm?'Deleted ':'Moved to bin: ')+DV.plural(done,'item'));
      DV.toast(failed.length?done+' done, '+failed.length+' failed: '+failed[0]:(perm?'Deleted ':'Moved to the bin: ')+DV.plural(done,'item'));
      sel=new Set(); selMode=false; await reload();
      DV.refreshVols().catch(()=>{});
      if(!perm&&DV.bin) DV.bin.refresh();
    }});
  const cb=$('#perm',w), okb=$('[data-ok]',m);
  cb.addEventListener('change',()=>{ okb.textContent=cb.checked?'Delete forever':'Move to bin'; okb.classList.toggle('dng',cb.checked); okb.classList.toggle('pri',!cb.checked); });
}
function doClip(mode){
  const list=selEntries(); if(!list.length) return;
  clip={mode,paths:list.map(x=>x.path),set:new Set(list.map(x=>x.path))};
  DV.toast((mode==='move'?'Cut ':'Copied ')+DV.plural(list.length,'item')+'. Open a folder and tap Paste.');
  sel=new Set(); selMode=false; renderSel();
}
async function doPaste(){
  if(!clip||!cwd||query){ if(query) DV.toast('Clear the search first.'); return; }
  const c=clip;
  const r=await DV.busy(c.mode==='move'?'Moving':'Copying',()=>DV.nat('paste',{paths:c.paths,dest:cwd,mode:c.mode}));
  if(!r) return;
  const failed=(r.failed&&r.failed.length)||0;
  DV.logOp((c.mode==='move'?'Moved ':'Copied ')+DV.plural(r.done,'item')+' to '+(DV.baseOf(cwd)||'root'));
  DV.toast(failed?r.done+' done, '+failed+' failed: '+r.failed[0]:(c.mode==='move'?'Moved ':'Copied ')+DV.plural(r.done,'item'));
  if(c.mode==='move') clip=null;
  sel=new Set(); await load(cwd); DV.refreshVols().catch(()=>{});
}
function doOpen(){
  const it=single(); if(!it) return;
  if(it.dir){ go(it.path); return; }
  openInApp(it);
}
function openInApp(it){
  const sib=vis.filter(x=>!x.dir);
  DV.viewer.open(it,sib);
}
function doExt(){
  const it=single(); if(!it||it.dir) return;
  DV.nat('openFile',{path:it.path}).catch(e=>DV.toast(e.message));
}
function doShare(){
  const list=selEntries().filter(x=>!x.dir); if(!list.length) return;
  DV.nat('share',{paths:list.map(x=>x.path)}).catch(e=>DV.toast(e.message));
}
async function doLock(){
  const list=selEntries(); if(!list.length) return;
  const ok=await DV.locker.lockPaths(list.map(x=>x.path));
  if(ok){ sel=new Set(); selMode=false; await reload(); DV.refreshVols().catch(()=>{}); }
}
function act(a){
  if(a==='rename') doRename();
  else if(a==='del') doDelete();
  else if(a==='copy') doClip('copy');
  else if(a==='cut') doClip('move');
  else if(a==='open') doOpen();
  else if(a==='ext') doExt();
  else if(a==='share') doShare();
  else if(a==='lock') doLock();
}
$('#dbody').addEventListener('click',e=>{ const a=e.target.closest('[data-act]'); if(a&&!a.disabled) act(a.dataset.act); });
$('#dclose').addEventListener('click',clearSel);
$('#b-new').addEventListener('click',doNewFolder);
$('#b-paste').addEventListener('click',doPaste);
$('#refresh').addEventListener('click',()=>{ if(cwd) reload(); });
$('#selall').addEventListener('click',selectAll);
$('#q').addEventListener('input',onQuery);
$('#clr').addEventListener('click',()=>{ clearQuery(); $('#q').focus(); });
$('#sort').addEventListener('change',e=>{ sortKey=e.target.value; DV.LS.set('dv-sort',sortKey); renderSel(); });
$('#dir').addEventListener('click',()=>{ sortDir*=-1; DV.LS.set('dv-dir',String(sortDir)); renderSel(); });
$('#hid').addEventListener('click',()=>{ showHidden=!showHidden; DV.LS.set('dv-hidden',showHidden?'1':'0'); renderBar(); if(cwd) reload(); });
function setView(v){ view=v; DV.LS.set('dv-view',v); renderSel(); }
$('#v-grid').addEventListener('click',()=>setView('grid'));
$('#v-list').addEventListener('click',()=>setView('list'));

document.addEventListener('keydown',e=>{
  if(DV.S.pane!=='files'||DV.modalOpen()||!$('#gate').hidden) return;
  const tg=e.target, typing=tg&&(tg.tagName==='INPUT'||tg.tagName==='TEXTAREA'||tg.tagName==='SELECT');
  if(typing){ if(e.key==='Escape'&&tg.id==='q'){ clearQuery(); tg.blur(); } return; }
  if(e.key==='Delete'&&sel.size){ e.preventDefault(); doDelete(); }
  else if(e.key==='F2'&&sel.size===1){ e.preventDefault(); doRename(); }
  else if(e.key==='Backspace'){ e.preventDefault(); if(query) clearQuery(); else up(); }
  else if(e.key==='Escape'){ if(DV.sideOpen()) DV.setSide(false); else if(sel.size) clearSel(); }
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){ e.preventDefault(); selectAll(); }
});

/* ---------- pane interface ---------- */
DV.files={
  go, reload,
  cwd:()=>cwd,
  hasSel:()=>sel.size>0,
  isStarted:()=>started,
  async start(){
    if(started&&cwd){ reload(); return; }
    started=true;
    const prim=DV.S.vols.find(v=>v.primary)||DV.S.vols[0];
    if(prim) await go(prim.path); else { loadErr='No storage was found on this device.'; render(); }
  },
  onBack(){
    if(sel.size){ clearSel(); return true; }
    if(query){ clearQuery(); return true; }
    return up();
  }
};
DV.registerPane('files',{
  show(){ render(); },
  hide(){},
  onBack:DV.files.onBack
});
render();
})();
