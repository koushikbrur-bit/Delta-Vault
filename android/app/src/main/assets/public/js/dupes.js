/* Duplicate finder. */
(function(){
'use strict';
const DV=window.DV, $=DV.$, esc=DV.esc;
let job=null, running=false, prog=null, error='';
let groups=null, meta=null, sel=new Set(), shown=40;

function scopes(){
  const s=$('#dp-scope'); const old=s.value;
  const o=DV.S.vols.map(v=>[v.path,v.name]).concat(DV.S.shortcuts.map(x=>[x.path,x.name+' folder']));
  s.innerHTML=o.map(a=>'<option value="'+esc(a[0])+'">'+esc(a[1])+'</option>').join('');
  if(old&&o.some(a=>a[0]===old)) s.value=old;
}
function allPaths(g){ return g.files.map(f=>f.path); }
function render(){
  const body=$('#dp-body'); if(!body) return;
  scopes();
  $('#dp-run').hidden=running; $('#dp-cancel').hidden=!running; $('#dp-scope').disabled=running; $('#dp-min').disabled=running;
  if(!DV.S.vols.length){ body.innerHTML=DV.emptyBox('No storage','Grant access first, then come back here.'); return; }
  let h='';
  if(error) h+='<div class="card bad"><h3>Search failed</h3><p>'+esc(error)+'</p></div>';
  if(running){
    const p=prog||{}, det=p.total>0;
    h+='<div class="card"><h3>'+esc(stageName(p.stage))+'</h3><div class="prog'+(det?' det':'')+'"><i style="'+(det?'width:'+Math.min(100,(p.files/p.total*100)).toFixed(1)+'%':'')+'"></i></div><div class="stat"><span><b>'+(p.files||0).toLocaleString()+'</b>'+(det?' of '+p.total.toLocaleString():'')+' files</span><span><b>'+DV.fmtSize(p.bytes||0)+'</b></span></div></div>';
    body.innerHTML=h; return;
  }
  if(!groups){
    body.innerHTML=h+DV.emptyBox('Find copies you do not need','Choose where to look, then start. Files are compared by their actual content, so renamed copies are found too. Nothing is deleted until you confirm.');
    return;
  }
  if(!groups.length){ body.innerHTML=h+DV.emptyBox('No duplicates found','Nothing in this location is identical to anything else at this size.'); return; }
  if(meta&&meta.partial) h+='<div class="card warnc"><p>The search stopped early, so some duplicates may be missing.</p></div>';
  const wasted=groups.reduce((a,g)=>a+g.size*(g.files.length-1),0);
  h+='<div class="stat"><span><b>'+DV.plural(groups.length,'set')+'</b> of identical files</span><span>up to <b>'+DV.fmtSize(wasted)+'</b> can be freed</span></div>';
  h+='<div><button class="btn" type="button" data-dp="auto">Keep oldest, select the rest</button></div>';
  groups.slice(0,shown).forEach((g,gi)=>{
    const ex=DV.kindOf(g.files[0]);
    const allSel=allPaths(g).every(p=>sel.has(p));
    h+='<div class="dgroup'+(allSel?' bad':'')+'"><div class="dgh"><span class="ic">'+DV.icon(ex)+'</span><div class="t"><b>'+esc(g.files[0].name)+'</b><small>'+DV.plural(g.files.length,'copy','copies')+' · '+DV.fmtSize(g.size)+' each</small></div></div>'+
      g.files.map(f=>DV.rowHTML({id:f.path,sel:sel.has(f.path),k:DV.kindOf(f),thumb:DV.thumbFor({name:f.name,path:f.path,size:g.size}),name:f.name,sub:DV.parentOf(f.path),meta:DV.fmtShort(f.modified)})).join('')+'</div>';
  });
  if(groups.length>shown) h+='<div><button class="btn" type="button" data-dp="more">Show more ('+(groups.length-shown)+' left)</button></div>';
  if(sel.size){
    const bytes=groups.reduce((a,g)=>a+g.files.filter(f=>sel.has(f.path)).length*g.size,0);
    h+='<div class="abar"><span class="info">'+DV.plural(sel.size,'file')+' · '+DV.fmtSize(bytes)+'</span><button class="btn dng" type="button" data-dp="del">Move to bin</button><button class="btn" type="button" data-dp="clear">Clear</button></div>';
  }
  body.innerHTML=h;
}
function stageName(s){ return s==='comparing'?'Comparing content':s==='listing'?'Listing files':'Searching'; }

function run(){
  if(running) return;
  const path=$('#dp-scope').value; if(!path) return;
  running=true; prog=null; error=''; groups=null; sel.clear(); shown=40; render();
  job=DV.startJob('dupesStart',{path,minSize:Number($('#dp-min').value)||102400,hidden:false},s=>{ prog=s; if(DV.S.pane==='dupes') render(); });
  job.promise.then(s=>{
    if(s.cancelled){ groups=null; }
    else{ meta=s.result||{}; groups=(meta.groups||[]).slice().sort((a,b)=>b.size*(b.files.length-1)-a.size*(a.files.length-1)); }
  }).catch(e=>{ error=e.message||'Search failed.'; }).then(()=>{ running=false; job=null; render(); });
}
function toggle(path,g){
  if(sel.has(path)){ sel.delete(path); return; }
  /* never let every copy in a set be selected */
  const others=g.files.filter(f=>f.path!==path);
  if(others.every(f=>sel.has(f.path))){ DV.toast('Keep at least one copy of each file.'); return; }
  sel.add(path);
}
async function del(){
  const paths=[...sel];
  const ok=await DV.confirm({title:'Move to bin',ok:'Move to bin',danger:true,body:'<p>Move '+DV.plural(paths.length,'duplicate file')+' to the recycle bin? One copy of each stays where it is, and you can restore the others for 30 days.</p>'});
  if(!ok) return;
  const r=await DV.busy('Moving to bin',()=>DV.nat('trashMove',{paths}));
  if(!r) return;
  DV.logOp('Binned '+DV.plural(r.done!=null?r.done:paths.length,'duplicate'));
  DV.toast('Duplicates moved to the recycle bin.');
  const gone=new Set(paths);
  groups.forEach(g=>{ g.files=g.files.filter(f=>!gone.has(f.path)); });
  groups=groups.filter(g=>g.files.length>1); sel.clear(); render();
  if(DV.bin) DV.bin.refresh();
}
document.addEventListener('click',e=>{
  if(DV.S.pane!=='dupes'||!groups) return;
  const a=e.target.closest('[data-dp]');
  if(a){
    const k=a.dataset.dp;
    if(k==='auto'){ sel.clear(); groups.forEach(g=>{ const s=g.files.slice().sort((x,y)=>x.modified-y.modified); s.slice(1).forEach(f=>sel.add(f.path)); }); render(); }
    else if(k==='more'){ shown+=40; render(); }
    else if(k==='clear'){ sel.clear(); render(); }
    else if(k==='del') del();
    return;
  }
  const row=e.target.closest('.lrow'); if(!row) return;
  const g=groups.find(x=>x.files.some(f=>f.path===row.dataset.id)); if(!g) return;
  toggle(row.dataset.id,g); render();
});
$('#dp-run').addEventListener('click',run);
$('#dp-cancel').addEventListener('click',()=>{ if(job) job.cancel(); });
DV.registerPane('dupes',{ show(){ render(); }, hide(){}, onBack(){ if(sel.size){ sel.clear(); render(); return true; } return false; } });
})();
