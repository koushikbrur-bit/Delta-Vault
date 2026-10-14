/* Storage map: scan a volume or folder, show a category bar, a drill-down treemap and the biggest items. */
(function(){
'use strict';
const DV=window.DV, $=DV.$, esc=DV.esc;

const CATS={images:'Images',video:'Video',audio:'Audio',docs:'Documents',archives:'Archives & apps',apps:'Apps',other:'Other files'};
const cache={};            /* path -> scan result */
let job=null, running=false, runPath='', prog=null, error='';
let volPath='', cur='';    /* selected volume root, folder being viewed */
const listeners=[];
const fire=()=>listeners.forEach(f=>{ try{ f(); }catch(e){} });

function nameOf(p,n){ return n===DV.BIN_NAME||n==='.DeltaVaultBin'?'Recycle bin':n; }

/* ---------- scan control (shared with the Big files tab) ---------- */
function start(path){
  if(running) return job&&job.promise;
  running=true; runPath=path; prog=null; error=''; fire(); render();
  job=DV.startJob('scanStart',{path},s=>{ prog=s; liveUpdate(); });
  const mine=job;
  return mine.promise.then(s=>{
    if(s&&s.result&&!s.cancelled){ cache[path]=s.result; if(s.result.partial) DV.toast('Scan was cut short. Results may be incomplete.'); }
  }).catch(e=>{ error=e.message||'Scan failed.'; }).then(()=>{
    running=false; job=null; prog=null; fire(); render();
  });
}
function cancel(){ if(job) job.cancel(); }
DV.scan={
  start, cancel,
  running:()=>running,
  progress:()=>prog,
  latest(path){ return cache[path]||null; },
  latestFor(){ return volPath?cache[volPath]||null:null; },
  volume:()=>volPath,
  onChange(f){ listeners.push(f); }
};

/* ---------- treemap ---------- */
function squarify(items,x,y,w,h){
  const out=[]; let rest=items.slice(), total=rest.reduce((a,b)=>a+b.v,0);
  if(total<=0||w<=0||h<=0) return out;
  const scale=w*h/total; rest.forEach(i=>{ i.a=i.v*scale; });
  const worst=(row,side)=>{
    const s=row.reduce((a,b)=>a+b.a,0), mx=Math.max(...row.map(r=>r.a)), mn=Math.min(...row.map(r=>r.a));
    return Math.max(side*side*mx/(s*s), s*s/(side*side*mn));
  };
  while(rest.length){
    const side=Math.min(w,h); const row=[rest.shift()];
    while(rest.length&&worst(row.concat(rest[0]),side)<=worst(row,side)) row.push(rest.shift());
    const s=row.reduce((a,b)=>a+b.a,0);
    if(w>=h){ const rw=s/h; let yy=y; row.forEach(r=>{ const rh=r.a/rw; out.push({it:r.it,x,y:yy,w:rw,h:rh}); yy+=rh; }); x+=rw; w-=rw; }
    else { const rh=s/w; let xx=x; row.forEach(r=>{ const rw=r.a/rh; out.push({it:r.it,x:xx,y,w:rw,h:rh}); xx+=rw; }); y+=rh; h-=rh; }
  }
  return out;
}
function mapHTML(res,width){
  const items=res.children.filter(c=>c.size>0).slice().sort((a,b)=>b.size-a.size);
  const total=items.reduce((a,b)=>a+b.size,0)+(res.restBytes||0);
  if(!total) return '';
  const H=Math.round(Math.max(240,Math.min(440,width*0.62)));
  let main=[], tiny=0, tinyN=0;
  items.forEach(c=>{ if(c.size/total<0.012&&main.length>=4){ tiny+=c.size; tinyN++; } else main.push({v:c.size,it:c}); });
  const rest=(res.restBytes||0)+tiny, restN=(res.restCount||0)+tinyN;
  if(rest>0) main.push({v:rest,it:{name:'Smaller items',size:rest,rest:true,count:restN,cat:'other'}});
  const tiles=squarify(main,0,0,width,H);
  const html=tiles.map(t=>{
    const c=t.it, big=t.w>78&&t.h>40, tag=c.rest?'div':(c.dir?'button':'div');
    const label=c.rest?'Smaller items':nameOf(res.path,c.name);
    const pct=(c.size/total*100);
    return '<'+tag+(tag==='button'?' type="button" data-drill="'+esc(c.path)+'"':'')+' class="tile" data-c="'+esc(c.cat||'other')+'" style="left:'+t.x.toFixed(1)+'px;top:'+t.y.toFixed(1)+'px;width:'+Math.max(0,t.w).toFixed(1)+'px;height:'+Math.max(0,t.h).toFixed(1)+'px" title="'+esc(label)+' · '+DV.fmtSize(c.size)+'" aria-label="'+esc(label)+', '+DV.fmtSize(c.size)+'">'+
      (big?'<b>'+esc(label)+'</b><small>'+DV.fmtSize(c.size)+' · '+pct.toFixed(pct<10?1:0)+'%</small>':'')+'</'+tag+'>';
  }).join('');
  return '<div class="tmap" style="height:'+H+'px" id="st-map">'+html+'</div>';
}

/* ---------- rendering ---------- */
function volSelect(){
  const sel=$('#st-vol'); const cur0=volPath;
  sel.innerHTML=DV.S.vols.map(v=>'<option value="'+esc(v.path)+'">'+esc(v.name)+'</option>').join('');
  if(!DV.S.vols.length){ volPath=''; return; }
  if(!DV.S.vols.some(v=>v.path===cur0)) volPath=(DV.S.vols.find(v=>v.primary)||DV.S.vols[0]).path;
  sel.value=volPath;
  if(!cur||!(cur===volPath||cur.startsWith(volPath+'/'))) cur=volPath;
}
function crumbs(){
  const v=DV.volOf(cur); if(!v) return '';
  const rel=cur.slice(v.path.length).split('/').filter(Boolean);
  let acc=v.path;
  let h='<button class="cr" type="button" data-drill="'+esc(v.path)+'"'+(rel.length?'':' aria-current="true"')+'>'+esc(v.name)+'</button>';
  rel.forEach((s,i)=>{ acc+='/'+s; h+='<span>/</span><button class="cr" type="button" data-drill="'+esc(acc)+'"'+(i===rel.length-1?' aria-current="true"':'')+'>'+esc(nameOf(acc,s))+'</button>'; });
  return '<nav class="crumbs2" aria-label="Map location">'+h+'</nav>';
}
function progressHTML(){
  const p=prog||{};
  return '<div class="card" id="st-prog"><h3>Scanning</h3><p class="sm mono" id="st-path">'+esc(runPath)+'</p><div class="prog"><i></i></div><div class="stat"><span><b id="st-files">'+(p.files||0).toLocaleString()+'</b> files</span><span><b id="st-bytes">'+DV.fmtSize(p.bytes||0)+'</b> counted</span></div></div>';
}
function liveUpdate(){
  const f=$('#st-files'), b=$('#st-bytes');
  if(f) f.textContent=(prog.files||0).toLocaleString();
  if(b) b.textContent=DV.fmtSize(prog.bytes||0);
  const big=$('#bg-prog-files'); if(big) big.textContent=(prog.files||0).toLocaleString();
}
function usageHTML(res){
  const v=DV.volOf(res.path); const isRoot=v&&v.path===res.path;
  const cats=(res.categories||[]).filter(c=>c.bytes>0);
  let totalRef=isRoot&&v.total?v.total:res.total;
  let other=0;
  if(isRoot&&v.total){ other=Math.max(0,(v.total-v.free)-res.total); }
  const bar=cats.map(c=>'<i data-c="'+c.k+'" style="width:'+(c.bytes/totalRef*100).toFixed(2)+'%" title="'+esc(CATS[c.k]||c.k)+'"></i>').join('')+
    (other>0?'<i data-c="system" style="width:'+(other/totalRef*100).toFixed(2)+'%" title="System and other"></i>':'')+'<i class="free"></i>';
  const leg=cats.map(c=>'<li data-c="'+c.k+'"><span class="sw"></span><b>'+esc(CATS[c.k]||c.k)+'</b><small>'+DV.fmtSize(c.bytes)+' · '+DV.plural(c.files,'file')+'</small></li>').join('')+
    (other>0?'<li data-c="system"><span class="sw"></span><b>System &amp; other</b><small>'+DV.fmtSize(other)+'</small></li>':'')+
    (isRoot&&v.total?'<li><span class="sw free"></span><b>Free</b><small>'+DV.fmtSize(v.free)+'</small></li>':'');
  return '<div class="card"><h3>'+(isRoot?'By type':'By type in this folder')+'</h3><div class="ubar" role="img" aria-label="Storage by type">'+bar+'</div><ul class="legend">'+leg+'</ul></div>';
}
function biggestHTML(res){
  const l=(res.children||[]).filter(c=>c.size>0).slice(0,12);
  if(!l.length) return '';
  const mx=l[0].size||1;
  return '<div class="card"><h3>Largest here</h3>'+l.map(c=>
    '<div class="lrow open" style="grid-template-columns:36px minmax(0,1fr) auto" data-k="'+(c.dir?'folder':'file')+'"><span class="ic">'+DV.icon(c.dir?'folder':DV.kindOf(c))+'</span><span class="main"><b>'+esc(nameOf(res.path,c.name))+'</b><span class="prog det" style="width:100%;margin:4px 0 0;height:6px"><i style="width:'+Math.max(2,c.size/mx*100)+'%"></i></span></span><span class="meta"><strong>'+DV.fmtSize(c.size)+'</strong>'+
    (c.dir?'<button class="btn" type="button" data-drill="'+esc(c.path)+'" style="min-height:30px;padding:0 8px">Open</button> ':'')+
    '<button class="btn" type="button" data-open-folder="'+esc(c.dir?c.path:DV.parentOf(c.path))+'" style="min-height:30px;padding:0 8px">Show in Files</button></span></div>').join('')+'</div>';
}
function render(){
  const body=$('#st-body'); if(!body) return;
  volSelect();
  $('#st-scan').hidden=running; $('#st-cancel').hidden=!running; $('#st-vol').disabled=running;
  $('#st-scan').textContent=cache[cur]?'Rescan':'Scan';
  if(!DV.S.vols.length){ body.innerHTML=DV.emptyBox('No storage','Grant access first, then come back here.'); return; }
  let h='';
  if(error) h+='<div class="card bad"><h3>Scan failed</h3><p>'+esc(error)+'</p></div>';
  if(running){ body.innerHTML=h+progressHTML(); return; }
  const res=cache[cur];
  if(!res){
    body.innerHTML=h+DV.emptyBox('Scan to see your storage','Delta Vault will walk through the selected storage and show where the space went. It only reads file sizes, so nothing is changed.','<button class="btn pri" type="button" data-st-scan>Scan now</button>');
    return;
  }
  h+=crumbs()+'<div class="stat"><span><b>'+DV.fmtSize(res.total)+'</b> in '+DV.plural(res.files,'file')+'</span><span>scanned '+DV.fmtDate(res.at||Date.now())+'</span></div>';
  h+=usageHTML(res)+'<div class="card"><h3>Map</h3><div id="st-mapwrap"></div></div>'+biggestHTML(res);
  body.innerHTML=h;
  drawMap(res);
}
function drawMap(res){
  const w=$('#st-mapwrap'); if(!w) return;
  const width=Math.max(220,Math.floor(w.getBoundingClientRect().width||w.parentNode.clientWidth-28||320));
  w.innerHTML=mapHTML(res,width)||'<p class="mute">This folder is empty.</p>';
}

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  const d=e.target.closest('[data-drill]');
  if(d&&DV.S.pane==='storage'){ drill(d.dataset.drill); return; }
  if(e.target.closest('[data-st-scan]')) startScan();
});
function startScan(){ if(!volPath) return; start(cur||volPath); }
async function drill(path){
  cur=path;
  if(!cache[path]){ await start(path); }
  else render();
  window.scrollTo(0,0);
}
$('#st-vol').addEventListener('change',e=>{ volPath=e.target.value; cur=volPath; render(); });
$('#st-scan').addEventListener('click',()=>{ delete cache[cur]; start(cur||volPath); });
$('#st-cancel').addEventListener('click',cancel);
let rt=0;
window.addEventListener('resize',()=>{ clearTimeout(rt); rt=setTimeout(()=>{ if(DV.S.pane==='storage'&&cache[cur]&&!running) drawMap(cache[cur]); },150); });

DV.registerPane('storage',{
  show(){ render(); },
  hide(){},
  onBack(){
    const v=DV.volOf(cur);
    if(!running&&v&&cur!==v.path){ drill(DV.parentOf(cur)); return true; }
    return false;
  }
});
})();
