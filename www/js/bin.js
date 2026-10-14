/* Recycle bin. */
(function(){
'use strict';
const DV=window.DV, $=DV.$, esc=DV.esc;
const DAY=86400000, MAX=30*DAY;
let entries=[], sel=new Set(), loaded=false, err='';

function badge(){
  const b=$('#bin-badge'); const n=entries.length;
  b.hidden=!n; b.textContent=n>99?'99+':String(n);
}
async function refresh(){
  if(!DV.P) { entries=[]; badge(); render(); return; }
  try{
    const r=await DV.nat('trashList');
    entries=(r.entries||[]).slice().sort((a,b)=>b.deleted-a.deleted); err=''; loaded=true;
    sel=new Set([...sel].filter(id=>entries.some(e=>e.id===id)));
    if(r.purged) DV.toast(DV.plural(r.purged,'old item')+' removed from the bin.');
  }catch(e){ err=e.message||'Could not read the bin.'; }
  badge(); render();
}
function daysLeft(e){ return Math.max(0,Math.ceil((e.deleted+MAX-Date.now())/DAY)); }
function render(){
  const body=$('#bn-body'); if(!body) return;
  $('#bn-empty').disabled=!entries.length; $('#bn-all').disabled=!entries.length;
  $('#bn-all').textContent=entries.length&&sel.size===entries.length?'Clear':'Select all';
  if(err){ body.innerHTML='<div class="card bad"><h3>Bin unavailable</h3><p>'+esc(err)+'</p></div>'; return; }
  if(!entries.length){ body.innerHTML=DV.emptyBox('Bin is empty','Files you delete from Delta Vault wait here for 30 days before they are removed for good.'); return; }
  const total=entries.reduce((a,b)=>a+b.size,0);
  let h='<div class="stat"><span><b>'+DV.plural(entries.length,'item')+'</b> · '+DV.fmtSize(total)+'</span></div><div role="listbox" aria-multiselectable="true" aria-label="Deleted items">'+
    entries.map(e=>DV.rowHTML({id:e.id,sel:sel.has(e.id),k:e.dir?'folder':DV.kindOf({name:e.name}),name:e.name,sub:e.origin,meta:'<strong>'+(e.dir?'Folder · ':'')+DV.fmtSize(e.size)+'</strong>'+DV.fmtShort(e.deleted)+' · '+daysLeft(e)+'d left'})).join('')+'</div>';
  if(sel.size) h+='<div class="abar"><span class="info">'+DV.plural(sel.size,'item')+' selected</span><button class="btn pri" type="button" data-bn="restore">Restore</button><button class="btn dng" type="button" data-bn="del">Delete forever</button></div>';
  body.innerHTML=h;
}
const ids=()=>[...sel];
async function restore(){
  const r=await DV.busy('Restoring',()=>DV.nat('trashRestore',{ids:ids()}));
  if(!r) return;
  DV.logOp('Restored '+DV.plural(r.done!=null?r.done:sel.size,'item'));
  DV.toast(r.failed?('Restored. '+r.failed+' could not be restored.'):'Restored to original place.');
  sel.clear(); await refresh();
}
async function delForever(){
  const n=sel.size;
  const ok=await DV.confirm({title:'Delete forever',ok:'Delete forever',danger:true,body:'<p>Permanently delete '+DV.plural(n,'item')+'? This cannot be undone.</p>'});
  if(!ok) return;
  const r=await DV.busy('Deleting',()=>DV.nat('trashDelete',{ids:ids()}));
  if(!r) return;
  DV.logOp('Deleted '+DV.plural(n,'item')+' for good'); sel.clear(); await refresh();
}
async function empty(){
  const ok=await DV.confirm({title:'Empty bin',ok:'Empty bin',danger:true,body:'<p>Permanently delete everything in the bin ('+DV.plural(entries.length,'item')+')? This cannot be undone.</p>'});
  if(!ok) return;
  const r=await DV.busy('Emptying bin',()=>DV.nat('trashEmpty'));
  if(!r) return;
  DV.logOp('Emptied the bin'); sel.clear(); await refresh();
}
document.addEventListener('click',e=>{
  if(DV.S.pane!=='bin') return;
  const a=e.target.closest('[data-bn]');
  if(a){ if(a.dataset.bn==='restore') restore(); else delForever(); return; }
  const row=e.target.closest('.lrow'); if(!row) return;
  const id=row.dataset.id; if(sel.has(id)) sel.delete(id); else sel.add(id);
  render();
});
$('#bn-all').addEventListener('click',()=>{ if(sel.size===entries.length) sel.clear(); else sel=new Set(entries.map(x=>x.id)); render(); });
$('#bn-empty').addEventListener('click',empty);
DV.bin={ refresh, count:()=>entries.length };
DV.registerPane('bin',{ show(){ refresh(); }, hide(){}, onBack(){ if(sel.size){ sel.clear(); render(); return true; } return false; } });
})();
