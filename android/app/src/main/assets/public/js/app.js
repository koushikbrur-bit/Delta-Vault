(function(){
'use strict';

/* ---------- helpers ---------- */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS={
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
};

/* ---------- native bridge ---------- */
const Cap=window.Capacitor||null;
const isNative=!!(Cap&&typeof Cap.isNativePlatform==='function'&&Cap.isNativePlatform());
function plugin(n){
  try{ return (Cap&&Cap.Plugins&&Cap.Plugins[n])||(Cap&&Cap.registerPlugin?Cap.registerPlugin(n):null); }catch(e){ return null; }
}
const P=isNative?plugin('DeltaFiles'):null;
const AppPlug=isNative?plugin('App'):null;
async function nat(method,args){
  if(!P) throw new Error('Open this app on an Android device.');
  try{ return await P[method](args||{}); }
  catch(e){ throw new Error((e&&(e.message||e.errorMessage))||'Operation failed.'); }
}
function fileUrl(path){
  const enc=path.split('/').map(encodeURIComponent).join('/');
  return Cap&&Cap.convertFileSrc?Cap.convertFileSrc(enc):'file://'+enc;
}

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
  card:'<path d="M7 3h8l3 3v15H7z"/><path d="M10 7v3M13 7v3"/>'
};
const icon=n=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true">'+(ICONS[n]||ICONS.file)+'</svg>';
const CHECK='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

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
const KIND_OF=(()=>{ const m={}; Object.keys(EXT).forEach(k=>EXT[k].forEach(e=>{ m[e]=k; })); return m; })();
const THUMB=new Set(['jpg','jpeg','png','gif','webp','bmp','avif']);
const TEXTEXT=new Set(['txt','md','csv','tsv','json','log','js','css','html','htm','xml','yml','yaml','ini','cfg','py','sh','java','kt','c','cpp','h','srt','vtt','conf','properties']);
const extOf=n=>{ const i=n.lastIndexOf('.'); return i>0?n.slice(i+1).toLowerCase():''; };
const kindOf=it=>it.dir?'folder':(KIND_OF[extOf(it.name)]||'file');
const typeLabel=it=>it.dir?'FOLDER':(extOf(it.name)||'FILE').toUpperCase();

function fmtSize(b){
  b=Number(b)||0;
  if(b<1024) return b+' B';
  const u=['KB','MB','GB','TB']; let i=-1;
  do{ b/=1024; i++; }while(b>=1024&&i<u.length-1);
  return (b>=100?b.toFixed(0):b.toFixed(1))+' '+u[i];
}
const MON=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const p2=n=>String(n).padStart(2,'0');
function fmtDate(t){ const d=new Date(t); return p2(d.getDate())+' '+MON[d.getMonth()]+' '+String(d.getFullYear()).slice(2)+' · '+p2(d.getHours())+':'+p2(d.getMinutes()); }
function fmtTime(){ const d=new Date(); return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds()); }
const parentOf=p=>p.slice(0,p.lastIndexOf('/'))||'/';
const baseOf=p=>p.slice(p.lastIndexOf('/')+1);

/* ---------- state ---------- */
let access=null, vols=[], shortcuts=[];
let cwd='', entries=[], results=null, loading=false, loadErr='', searching=false, searchPartial=false;
let sel=new Set(), selMode=false, lastIdx=-1, clip=null;
let view=LS.get('dv-view')==='grid'?'grid':'list';
let sortKey=LS.get('dv-sort')||'name', sortDir=LS.get('dv-dir')==='-1'?-1:1;
let showHidden=LS.get('dv-hidden')==='1';
let query='', vis=[], modalEl=null, started=false;
let loadTok=0, searchId=0, searchTimer=0, busyTimer=0, toastT=0, pvTok=0;
const oplog=[];
const narrow=()=>window.matchMedia&&window.matchMedia('(max-width:900px)').matches;

/* ---------- small ui helpers ---------- */
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2800); }
function logOp(msg){ oplog.unshift({t:fmtTime(),msg}); if(oplog.length>6) oplog.pop(); renderLog(); }
async function busy(label,fn){
  clearTimeout(busyTimer);
  busyTimer=setTimeout(()=>{ $('#busy-t').textContent=label; $('#busy').hidden=false; },250);
  try{ return await fn(); }
  catch(e){ toast(e.message||'Operation failed.'); return undefined; }
  finally{ clearTimeout(busyTimer); $('#busy').hidden=true; }
}

/* ---------- modal ---------- */
function closeModal(){ if(modalEl){ modalEl.remove(); modalEl=null; } }
function modal(o){
  closeModal();
  const m=document.createElement('div'); m.className='modal';
  m.innerHTML='<div class="mp panel" role="dialog" aria-modal="true" aria-label="'+esc(o.title)+'"><div class="haz"></div><div class="mh">'+esc(o.title)+'</div><div class="mb"></div><div class="mf"><button class="btn" type="button" data-x>Cancel</button><button class="btn '+(o.danger?'dng':'pri')+'" type="button" data-ok>'+esc(o.ok||'Confirm')+'</button></div></div>';
  const mb=$('.mb',m); if(typeof o.body==='string') mb.innerHTML=o.body; else mb.appendChild(o.body);
  m.addEventListener('mousedown',e=>{ if(e.target===m) closeModal(); });
  $('[data-x]',m).addEventListener('click',closeModal);
  const ok=$('[data-ok]',m);
  ok.addEventListener('click',async()=>{
    if(ok.disabled) return;
    ok.disabled=true; let r;
    try{ r=o.onOk?await o.onOk(m):true; }catch(e){ r=false; toast(e.message||'Operation failed.'); }
    ok.disabled=false;
    if(r!==false) closeModal();
  });
  document.body.appendChild(m); modalEl=m;
  if(o.focus) o.focus(m); else ok.focus();
}
function askName(o,cb){
  const w=document.createElement('div');
  w.innerHTML='<label for="nm-in">'+esc(o.label||'Name')+'</label><input class="in" id="nm-in" type="text" maxlength="200" autocomplete="off" spellcheck="false" autocapitalize="off"><div class="err" role="alert"></div>';
  const inp=$('input',w); inp.value=o.value||'';
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('[data-ok]',modalEl).click(); } });
  modal({title:o.title,body:w,ok:o.ok,
    focus:()=>{ inp.focus(); const dot=(o.value||'').lastIndexOf('.'); inp.setSelectionRange(0,o.select&&dot>0?dot:inp.value.length); },
    onOk:async()=>{
      const name=inp.value.trim(), err=$('.err',w);
      if(!name){ err.textContent='Enter a name.'; return false; }
      if(/[\/\\\u0000]/.test(name)||name==='.'||name==='..'){ err.textContent='Names cannot contain slashes.'; return false; }
      const msg=await cb(name);
      if(msg){ err.textContent=msg; return false; }
    }});
}

/* ---------- rendering ---------- */
const volOf=p=>vols.find(v=>p===v.path||p.startsWith(v.path+'/'))||null;

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
  else r=typeLabel(a).localeCompare(typeLabel(b))||a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'});
  return r*sortDir;
}

function renderLocs(){
  const cur=volOf(cwd);
  $('#locs').innerHTML=vols.length?vols.map(v=>'<div class="tn'+(cwd===v.path&&!query?' on':'')+'"><button class="tl" type="button" data-go="'+esc(v.path)+'">'+icon(v.primary?'folder':'card')+'<span>'+esc(v.name)+'</span><em>'+fmtSize(v.free)+' free</em></button></div>').join(''):'<p class="mono sm mute" style="margin:0">No storage found.</p>';
  $('#shorts').innerHTML=shortcuts.length?shortcuts.map(s=>'<div class="tn'+(cwd===s.path&&!query?' on':'')+'"><button class="tl" type="button" data-go="'+esc(s.path)+'">'+icon('folder')+'<span>'+esc(s.name)+'</span></button></div>').join(''):'<p class="mono sm mute" style="margin:0">None yet.</p>';
  void cur;
}
function renderCrumbs(){
  const el=$('#crumbs');
  if(query){
    el.innerHTML='<span class="cr" aria-current="true">Search</span><span>/</span><span class="cr">&ldquo;'+esc(query)+'&rdquo;</span><span class="count">'+(searching?'searching':vis.length+(searchPartial?'+':'')+' match'+(vis.length===1&&!searchPartial?'':'es'))+'</span>';
    return;
  }
  const v=volOf(cwd);
  if(!v){ el.innerHTML='<span class="cr" aria-current="true">'+esc(cwd||'Vault')+'</span>'; return; }
  const rel=cwd.slice(v.path.length).split('/').filter(Boolean);
  let acc=v.path;
  let h='<button class="cr" type="button" data-go="'+esc(v.path)+'"'+(rel.length?'':' aria-current="true"')+'>'+esc(v.name)+'</button>';
  rel.forEach((seg,i)=>{ acc+='/'+seg; h+='<span>/</span><button class="cr" type="button" data-go="'+esc(acc)+'"'+(i===rel.length-1?' aria-current="true"':'')+'>'+esc(seg)+'</button>'; });
  const n=entries.length;
  el.innerHTML=h+'<span class="count">'+n+' item'+(n===1?'':'s')+'</span>';
  el.scrollLeft=el.scrollWidth;
}
function emptyBox(title,text,btn){ return '<div class="empty"><div class="haz"></div><h3>'+esc(title)+'</h3><p>'+text+'</p>'+(btn||'')+'</div>'; }
function itemHTML(it,i){
  const k=kindOf(it), s=sel.has(it.path), cut=clip&&clip.mode==='move'&&clip.set.has(it.path);
  const sz=it.dir?'Folder':fmtSize(it.size);
  let ic=icon(k);
  if(k==='img'&&THUMB.has(extOf(it.name))&&it.size>0&&it.size<8e6) ic='<img class="th" loading="lazy" decoding="async" alt="" src="'+esc(fileUrl(it.path))+'">';
  return '<div class="it'+(s?' sel':'')+(cut?' cut':'')+'" role="option" aria-selected="'+s+'" tabindex="0" data-i="'+i+'" data-k="'+k+'">'+
    '<button class="chk" type="button" data-chk tabindex="-1" aria-label="Select '+esc(it.name)+'">'+(s?CHECK:'')+'</button>'+
    '<span class="ic">'+ic+'</span>'+
    '<span class="nm"><b title="'+esc(it.name)+'">'+esc(it.name)+'</b>'+(query?'<small class="pth">'+esc(parentOf(it.path))+'</small>':'')+'</span>'+
    '<span class="sz">'+sz+'</span><span class="ty">'+typeLabel(it)+'</span><span class="dt">'+fmtDate(it.modified)+'</span></div>';
}
function renderField(){
  const f=$('#field');
  $('#fw').classList.toggle('listv',view==='list');
  f.className='field'+(view==='list'?' list':'');
  if(loading){ vis=[]; f.innerHTML=emptyBox('Reading folder','Listing files on this device.'); return; }
  vis=visible();
  if(!vis.length){
    if(loadErr) f.innerHTML=emptyBox('Cannot open folder',esc(loadErr)+'<br><span class="mono sm">'+esc(cwd)+'</span>',cwd&&volOf(cwd)&&cwd!==volOf(cwd).path?'<button class="btn pri" type="button" data-act="up">Go up</button>':'');
    else if(query&&searching) f.innerHTML=emptyBox('Searching','Looking through this folder and everything inside it.');
    else if(query) f.innerHTML=emptyBox('No matches','Nothing here is named like &ldquo;'+esc(query)+'&rdquo;.');
    else f.innerHTML=emptyBox('Folder empty',showHidden?'This folder has no files.':'No visible files here. Hidden files are off.');
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
function renderLog(){
  $('#log').innerHTML=oplog.length?oplog.map(o=>'<li><time>'+o.t+'</time>'+esc(o.msg)+'</li>').join(''):'<li>No operations yet.</li>';
}
function renderStats(){
  const v=volOf(cwd)||vols[0];
  if(!v||!v.total){ $('#stat').textContent=''; $('#mfill').style.width='0'; return; }
  const used=v.total-v.free;
  $('#stat').textContent=fmtSize(used)+' used · '+fmtSize(v.free)+' free of '+fmtSize(v.total);
  $('#mfill').style.width=Math.max(2,Math.min(100,used/v.total*100))+'%';
}
function renderAcc(){
  const b=$('#acc'); let cls='chip warn', txt='No access';
  if(!P){ txt='Not on device'; }
  else if(access&&access.allFiles){ cls='chip ok'; txt='Storage linked'; }
  else if(access&&access.media){ txt='Limited access'; }
  b.className=cls; b.innerHTML='<i></i>'+txt;
}
const selEntries=()=>vis.filter(x=>sel.has(x.path));
function renderDetail(){
  const d=$('#dbody'), list=selEntries(), tok=++pvTok;
  document.body.classList.toggle('has-sel',list.length>0);
  if(!list.length){
    const n=entries.length;
    d.innerHTML='<div><h3>'+esc(cwd?baseOf(cwd)||'Vault':'Vault')+'</h3><p class="mono sm mute" style="margin:6px 0 0;overflow-wrap:anywhere">'+esc(cwd)+'</p></div>'+
      '<dl class="meta"><dt>Items</dt><dd>'+n+'</dd></dl>'+
      '<div><h4 class="lbl">Controls</h4><ul class="keys"><li><kbd>Tap</kbd>Open folder or inspect file</li><li><kbd>Long press</kbd>Select several</li><li><kbd>Ctrl</kbd><kbd>Click</kbd>Add to selection</li><li><kbd>F2</kbd>Rename</li><li><kbd>Del</kbd>Delete</li><li><kbd>Backspace</kbd>Up one level</li></ul></div>';
    return;
  }
  if(list.length>1){
    const files=list.filter(x=>!x.dir), tot=files.reduce((s,x)=>s+x.size,0);
    d.innerHTML='<div><h3>'+list.length+' items selected</h3></div><dl class="meta"><dt>Folders</dt><dd>'+(list.length-files.length)+'</dd><dt>Files</dt><dd>'+files.length+'</dd><dt>File size</dt><dd>'+fmtSize(tot)+'</dd></dl>'+
      '<div class="acts"><button class="btn" type="button" data-act="copy">Copy</button><button class="btn" type="button" data-act="cut">Cut</button>'+(files.length?'<button class="btn" type="button" data-act="share">Share</button>':'')+'<button class="btn dng" type="button" data-act="del">Delete</button></div>';
    return;
  }
  const it=list[0], k=kindOf(it), ext=extOf(it.name);
  let pv='', after=null;
  if(it.dir) pv='<div class="pv big">'+icon('folder')+'<span id="finfo">Counting contents</span></div>';
  else if(k==='img'&&ext!=='heic'&&ext!=='heif') pv='<div class="pv"><img alt="" src="'+esc(fileUrl(it.path))+'"></div>';
  else if(k==='vid') pv='<div class="pv"><video controls preload="metadata" src="'+esc(fileUrl(it.path))+'"></video></div>';
  else if(k==='aud') pv='<div class="pv" style="padding:16px"><audio controls src="'+esc(fileUrl(it.path))+'"></audio></div>';
  else if(TEXTEXT.has(ext)&&it.size<=50*1024*1024){
    pv='<div class="pv"><pre id="pvtxt">Loading preview</pre></div>';
    after=()=>nat('readText',{path:it.path,max:16384}).then(r=>{
      if(tok!==pvTok) return; const el=$('#pvtxt'); if(!el) return;
      el.textContent=r.binary?'Binary content. No text preview.':(r.text||'(empty file)')+(r.truncated?'\n[preview truncated]':'');
    }).catch(e=>{ const el=$('#pvtxt'); if(el&&tok===pvTok) el.textContent='Preview unavailable: '+e.message; });
  } else pv='<div class="pv big">'+icon(k)+'<span>No preview for this type</span></div>';
  d.innerHTML='<div><h3>'+esc(it.name)+'</h3></div>'+pv+
    '<dl class="meta"><dt>Type</dt><dd>'+typeLabel(it)+'</dd>'+(it.dir?'':'<dt>Size</dt><dd>'+fmtSize(it.size)+' <span class="mute">('+it.size.toLocaleString('en-US')+' B)</span></dd>')+'<dt>Modified</dt><dd>'+fmtDate(it.modified)+'</dd><dt>Path</dt><dd class="mono sm">'+esc(it.path)+'</dd></dl>'+
    '<div class="acts"><button class="btn pri" type="button" data-act="open">'+(it.dir?'Open folder':'Open')+'</button>'+(it.dir?'':'<button class="btn" type="button" data-act="share">Share</button>')+'<button class="btn" type="button" data-act="copy">Copy</button><button class="btn" type="button" data-act="cut">Cut</button><button class="btn" type="button" data-act="rename">Rename</button><button class="btn dng" type="button" data-act="del">Delete</button></div>';
  if(after) after();
  if(it.dir) nat('folderInfo',{path:it.path}).then(r=>{
    if(tok!==pvTok) return; const el=$('#finfo'); if(!el) return;
    el.textContent=r.files+' files · '+r.folders+' folders · '+fmtSize(r.bytes)+(r.partial?'+':'');
  }).catch(()=>{ const el=$('#finfo'); if(el&&tok===pvTok) el.textContent='Folder'; });
}
function renderSel(){ renderField(); renderBar(); renderDetail(); }
function render(){ renderLocs(); renderCrumbs(); renderField(); renderBar(); renderDetail(); renderStats(); }

/* ---------- loading + navigation ---------- */
async function load(path){
  const tok=++loadTok;
  loading=true; loadErr=''; cwd=path;
  setTimeout(()=>{ if(tok===loadTok&&loading) renderField(); },150);
  try{
    const r=await nat('list',{path,hidden:showHidden});
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
  setSide(false);
  return load(path);
}
function up(){
  const v=volOf(cwd);
  if(!v||cwd===v.path) return false;
  go(parentOf(cwd)); return true;
}
function reload(){ if(query) return runSearch(); return load(cwd); }
async function refreshVols(){
  const r=await nat('roots');
  vols=r.volumes||[]; shortcuts=r.shortcuts||[];
  renderLocs(); renderStats();
}
function setSide(on){ $('#side').classList.toggle('open',on); $('#scrim').classList.toggle('show',on); }

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
    const r=await nat('search',{path:cwd,query:q,hidden:showHidden,limit:400,id});
    if(id!==searchId||q!==query) return;
    results=r.entries||[]; searchPartial=!!r.partial;
  }catch(e){
    if(id!==searchId) return;
    results=[]; toast(e.message);
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
const single=()=>{ const l=selEntries(); return l.length===1?l[0]:null; };

const field=$('#field');
field.addEventListener('click',e=>{
  const row=e.target.closest('.it');
  if(!row){ if(sel.size) clearSel(); return; }
  const i=+row.dataset.i, it=vis[i]; if(!it) return;
  if(e.target.closest('[data-chk]')||e.ctrlKey||e.metaKey||selMode) toggle(i);
  else if(e.shiftKey) selectRange(i);
  else if(it.dir) go(it.path);
  else selectOnly(i);
});
field.addEventListener('contextmenu',e=>{
  const row=e.target.closest('.it'); if(!row) return;
  e.preventDefault(); toggle(+row.dataset.i);
});
field.addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key===' '){
    const row=e.target.closest&&e.target.closest('.it'); if(!row) return;
    e.preventDefault(); const it=vis[+row.dataset.i];
    if(it&&it.dir) go(it.path); else selectOnly(+row.dataset.i);
  }
});
field.addEventListener('error',e=>{
  const t=e.target;
  if(t&&t.classList&&t.classList.contains('th')) t.outerHTML=icon('img');
},true);

/* ---------- actions ---------- */
function doNewFolder(){
  if(!cwd||query) { if(query) toast('Clear the search first.'); return; }
  askName({title:'New folder',label:'Folder name',value:'New folder',ok:'Create'},async name=>{
    try{ await nat('mkdir',{path:cwd+'/'+name}); }catch(e){ return e.message; }
    logOp('Created '+name); await load(cwd);
  });
}
function doRename(){
  const it=single(); if(!it) return;
  askName({title:'Rename',label:'New name',value:it.name,ok:'Rename',select:!it.dir},async name=>{
    if(name===it.name) return null;
    try{ await nat('rename',{from:it.path,to:parentOf(it.path)+'/'+name}); }catch(e){ return e.message; }
    logOp('Renamed '+it.name+' to '+name); sel=new Set(); await reload();
  });
}
function doDelete(){
  const list=selEntries(); if(!list.length) return;
  const label=list.length===1?'&ldquo;'+esc(list[0].name)+'&rdquo;':list.length+' items';
  const hasDir=list.some(x=>x.dir);
  modal({title:'Delete',danger:true,ok:'Delete',
    body:'<p>Delete '+label+' from this device? '+(hasDir?'Folders are deleted with everything inside. ':'')+'There is no recycle bin, so this cannot be undone.</p>',
    onOk:async()=>{
      const r=await busy('Deleting',()=>nat('delete',{paths:list.map(x=>x.path)}));
      if(!r) return false;
      const failed=(r.failed&&r.failed.length)||0;
      logOp('Deleted '+(list.length-failed)+' item'+(list.length-failed===1?'':'s'));
      toast(failed?failed+' item'+(failed===1?'':'s')+' could not be deleted.':'Deleted '+list.length+' item'+(list.length===1?'':'s'));
      sel=new Set(); selMode=false; await reload(); refreshVols().catch(()=>{});
    }});
}
function doClip(mode){
  const list=selEntries(); if(!list.length) return;
  clip={mode,paths:list.map(x=>x.path),set:new Set(list.map(x=>x.path))};
  toast((mode==='move'?'Cut ':'Copied ')+list.length+' item'+(list.length===1?'':'s')+'. Open a folder and tap Paste.');
  sel=new Set(); selMode=false; renderSel();
}
async function doPaste(){
  if(!clip||!cwd||query) { if(query) toast('Clear the search first.'); return; }
  const c=clip;
  const r=await busy(c.mode==='move'?'Moving':'Copying',()=>nat('paste',{paths:c.paths,dest:cwd,mode:c.mode}));
  if(!r) return;
  const failed=(r.failed&&r.failed.length)||0;
  logOp((c.mode==='move'?'Moved ':'Copied ')+r.done+' item'+(r.done===1?'':'s')+' to '+(baseOf(cwd)||'root'));
  toast(failed?r.done+' done, '+failed+' failed: '+r.failed[0]:(c.mode==='move'?'Moved ':'Copied ')+r.done+' item'+(r.done===1?'':'s'));
  if(c.mode==='move') clip=null;
  sel=new Set(); await load(cwd); refreshVols().catch(()=>{});
}
function doOpen(){
  const it=single(); if(!it) return;
  if(it.dir){ go(it.path); return; }
  nat('openFile',{path:it.path}).catch(e=>toast(e.message));
}
function doShare(){
  const list=selEntries().filter(x=>!x.dir); if(!list.length) return;
  nat('share',{paths:list.map(x=>x.path)}).catch(e=>toast(e.message));
}
function act(a){
  if(a==='newfolder') doNewFolder();
  else if(a==='paste') doPaste();
  else if(a==='rename') doRename();
  else if(a==='del') doDelete();
  else if(a==='copy') doClip('copy');
  else if(a==='cut') doClip('move');
  else if(a==='open') doOpen();
  else if(a==='share') doShare();
  else if(a==='up') up();
  else if(a==='refresh') { if(cwd) reload(); }
  else if(a==='close') clearSel();
  else if(a==='side') setSide(!$('#side').classList.contains('open'));
  else if(a==='gate'){ if(access&&!access.allFiles) showGate(); }
}

document.addEventListener('click',e=>{
  const g=e.target.closest('[data-go]'); if(g){ go(g.dataset.go); return; }
  const a=e.target.closest('[data-act]'); if(a&&!a.disabled) act(a.dataset.act);
});
$('#scrim').addEventListener('click',()=>setSide(false));
$('#q').addEventListener('input',onQuery);
$('#clr').addEventListener('click',()=>{ clearQuery(); $('#q').focus(); });
$('#sort').addEventListener('change',e=>{ sortKey=e.target.value; LS.set('dv-sort',sortKey); renderSel(); });
$('#dir').addEventListener('click',()=>{ sortDir*=-1; LS.set('dv-dir',String(sortDir)); renderSel(); });
$('#hid').addEventListener('click',()=>{ showHidden=!showHidden; LS.set('dv-hidden',showHidden?'1':'0'); renderBar(); if(cwd) reload(); });
function setView(v){ view=v; LS.set('dv-view',v); renderSel(); }
$('#v-grid').addEventListener('click',()=>setView('grid'));
$('#v-list').addEventListener('click',()=>setView('list'));

document.addEventListener('keydown',e=>{
  if(modalEl){ if(e.key==='Escape') closeModal(); return; }
  const tg=e.target, typing=tg&&(tg.tagName==='INPUT'||tg.tagName==='TEXTAREA'||tg.tagName==='SELECT');
  if(typing){ if(e.key==='Escape'&&tg.id==='q'){ clearQuery(); tg.blur(); } return; }
  if(!$('#gate').hidden) return;
  if(e.key==='Delete'&&sel.size){ e.preventDefault(); doDelete(); }
  else if(e.key==='F2'&&sel.size===1){ e.preventDefault(); doRename(); }
  else if(e.key==='Backspace'){ e.preventDefault(); if(query) clearQuery(); else up(); }
  else if(e.key==='Escape'){ if($('#side').classList.contains('open')) setSide(false); else if(sel.size) clearSel(); }
});

/* ---------- access gate ---------- */
function showGate(){ $('#gate').hidden=false; renderGate(); }
function hideGate(){ $('#gate').hidden=true; }
function renderGate(){
  const a=access||{}, modern=a.sdk>=30;
  if(!P){
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
    if(b.dataset.gate==='media'){ access=await nat('requestMedia'); }
    else {
      await nat('requestAllFiles');
      const n=$('#g-note'); n.hidden=false; n.textContent='Switch on the option for Delta Vault, then come back to this screen.';
    }
  }catch(err){ toast(err.message); }
  renderAcc(); renderGate();
});
$('#g-enter').addEventListener('click',()=>{ hideGate(); startBrowsing(); });
$('#g-limited').addEventListener('click',()=>{ LS.set('dv-limited','1'); hideGate(); startBrowsing(); });

async function refreshAccess(){
  if(!P) return;
  try{ access=await nat('status'); }catch(e){ return; }
  renderAcc();
  if(!$('#gate').hidden){
    renderGate();
    if(access.allFiles){ hideGate(); startBrowsing(); }
  } else if(!access.media&&!access.allFiles) showGate();
}
async function startBrowsing(){
  try{ await refreshVols(); }catch(e){ toast(e.message); }
  if(started&&cwd){ reload(); return; }
  started=true;
  const prim=vols.find(v=>v.primary)||vols[0];
  if(prim) await go(prim.path); else { loadErr='No storage was found on this device.'; render(); }
}

/* ---------- hardware back + app lifecycle ---------- */
function exitApp(){ if(AppPlug&&AppPlug.exitApp) AppPlug.exitApp(); }
function onBack(){
  if(modalEl){ closeModal(); return; }
  if(!$('#busy').hidden) return;
  if(!$('#gate').hidden){ if(access&&(access.allFiles||(access.media&&LS.get('dv-limited')==='1'))&&started) hideGate(); else exitApp(); return; }
  if($('#side').classList.contains('open')){ setSide(false); return; }
  if(sel.size){ clearSel(); return; }
  if(query){ clearQuery(); return; }
  if(up()) return;
  exitApp();
}
if(AppPlug&&AppPlug.addListener){
  AppPlug.addListener('backButton',onBack);
  AppPlug.addListener('appStateChange',s=>{ if(s&&s.isActive) refreshAccess(); });
}
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) refreshAccess(); });

/* ---------- boot ---------- */
(async function boot(){
  $('#clock').textContent=fmtTime();
  setInterval(()=>{ $('#clock').textContent=fmtTime(); },1000);
  renderLog(); renderBar(); renderAcc(); render();
  if(!P){ showGate(); return; }
  try{ access=await nat('status'); }catch(e){ access={sdk:0,media:false,allFiles:false}; }
  renderAcc();
  if(access.allFiles||(access.media&&LS.get('dv-limited')==='1')) startBrowsing();
  else showGate();
})();
})();
