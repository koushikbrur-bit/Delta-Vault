/* Big files: the largest files from the latest scan of the main storage. */
(function(){
'use strict';
const DV=window.DV, $=DV.$, esc=DV.esc;
let sel=new Set(), list=[], minSize=0;

function rootPath(){ const v=DV.S.vols.find(x=>x.primary)||DV.S.vols[0]; return v?v.path:''; }
function render(){
  const body=$('#bg-body'); if(!body) return;
  const root=rootPath();
  $('#bg-scan').disabled=DV.scan.running();
  if(!root){ body.innerHTML=DV.emptyBox('No storage','Grant access first, then come back here.'); return; }
  if(DV.scan.running()){
    const p=DV.scan.progress()||{};
    body.innerHTML='<div class="card"><h3>Scanning</h3><div class="prog"><i></i></div><div class="stat"><span><b id="bg-prog-files">'+(p.files||0).toLocaleString()+'</b> files checked</span></div></div>';
    return;
  }
  const res=DV.scan.latest(root);
  if(!res){
    body.innerHTML=DV.emptyBox('No scan yet','Scan your storage once to rank every file by size.','<button class="btn pri" type="button" id="bg-first">Scan now</button>');
    return;
  }
  list=(res.biggest||[]).filter(f=>f.size>=minSize);
  sel=new Set([...sel].filter(p=>list.some(f=>f.path===p)));
  let h='';
  if(!list.length) h+=DV.emptyBox('Nothing that big','No files above this size were found. Try a smaller limit.');
  else{
    h+='<div class="stat"><span><b>'+DV.plural(list.length,'file')+'</b> · '+DV.fmtSize(list.reduce((a,b)=>a+b.size,0))+'</span></div><div role="listbox" aria-multiselectable="true" aria-label="Big files">'+
      list.map(f=>DV.rowHTML({id:f.path,sel:sel.has(f.path),k:DV.kindOf(f),thumb:DV.thumbFor(f),name:f.name,sub:DV.parentOf(f.path),meta:'<strong>'+DV.fmtSize(f.size)+'</strong>'+DV.fmtShort(f.modified)})).join('')+'</div>';
  }
  if(sel.size){
    const bytes=list.filter(f=>sel.has(f.path)).reduce((a,b)=>a+b.size,0);
    h+='<div class="abar"><span class="info">'+DV.plural(sel.size,'file')+' · '+DV.fmtSize(bytes)+'</span>'+
      (sel.size===1?'<button class="btn" type="button" data-bg="show">Show in Files</button><button class="btn" type="button" data-bg="open">Open</button>':'')+
      '<button class="btn dng" type="button" data-bg="del">Move to bin</button><button class="btn" type="button" data-bg="clear">Clear</button></div>';
  }
  body.innerHTML=h;
}
async function del(){
  const paths=[...sel];
  const ok=await DV.confirm({title:'Move to bin',ok:'Move to bin',danger:true,body:'<p>Move '+DV.plural(paths.length,'file')+' to the recycle bin? You can restore them for 30 days.</p>'});
  if(!ok) return;
  const r=await DV.busy('Moving to bin',()=>DV.nat('trashMove',{paths}));
  if(!r) return;
  DV.logOp('Binned '+DV.plural(r.done!=null?r.done:paths.length,'file'));
  DV.toast('Moved to the recycle bin.');
  const root=rootPath(), res=DV.scan.latest(root);
  if(res){ const gone=new Set(paths); res.biggest=res.biggest.filter(f=>!gone.has(f.path)); }
  sel.clear(); render(); if(DV.bin) DV.bin.refresh();
}
document.addEventListener('click',e=>{
  if(DV.S.pane!=='big') return;
  if(e.target.closest('#bg-first')){ DV.scan.start(rootPath()); return; }
  const a=e.target.closest('[data-bg]');
  if(a){
    const k=a.dataset.bg;
    if(k==='del') del(); else if(k==='clear'){ sel.clear(); render(); }
    else if(k==='show'){ const p=[...sel][0]; DV.openFolder(DV.parentOf(p)); }
    else if(k==='open'){ { const f=list.find(x=>x.path===[...sel][0]); if(f) DV.viewer.open(f,[f]); } }
    return;
  }
  const row=e.target.closest('.lrow'); if(!row) return;
  const id=row.dataset.id; if(sel.has(id)) sel.delete(id); else sel.add(id);
  render();
});
$('#bg-min').addEventListener('change',e=>{ minSize=Number(e.target.value)||0; render(); });
$('#bg-scan').addEventListener('click',()=>{ const r=rootPath(); if(r) DV.scan.start(r); });
DV.scan.onChange(()=>{ if(DV.S.pane==='big') render(); });
DV.registerPane('big',{ show(){ render(); }, hide(){}, onBack(){ if(sel.size){ sel.clear(); render(); return true; } return false; } });
})();
