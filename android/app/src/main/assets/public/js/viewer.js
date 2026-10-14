/* Built-in viewer: images, video, audio, PDF, text, Word, spreadsheets and zip contents. No other app needed. */
(function(){
'use strict';
const DV=window.DV, $=DV.$, esc=DV.esc;
const loaded={};
function loadScript(src){
  if(loaded[src]) return loaded[src];
  return loaded[src]=new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=()=>{ delete loaded[src]; rej(new Error('Could not load the viewer component.')); }; document.head.appendChild(s); });
}
const VID=new Set(['mp4','webm','m4v','mov','3gp','mkv','ogv']);
const AUD=new Set(['mp3','m4a','wav','ogg','oga','flac','aac','opus','amr','weba']);
const IMG=new Set(['jpg','jpeg','png','gif','webp','bmp','svg','avif','ico']);
const SHEET=new Set(['xlsx','xls','ods','csv','tsv']);
const ZIPS=new Set(['zip','apk','xapk','jar','docx_']);
function typeOf(it){
  const e=DV.extOf(it.name);
  if(IMG.has(e)) return 'img'; if(VID.has(e)) return 'vid'; if(AUD.has(e)) return 'aud';
  if(e==='pdf') return 'pdf'; if(e==='docx') return 'docx'; if(e==='pptx') return 'pptx'; if(e==='ppt'||e==='doc'||e==='odp'||e==='odt') return 'legacy';
  if(SHEET.has(e)) return e==='csv'||e==='tsv'?'csv':'sheet';
  if(ZIPS.has(e)) return 'zip';
  if(DV.TEXTEXT.has(e)||e==='svg') return 'text';
  return 'unknown';
}

let root=null, cur=null, list=[], idx=0, opts={}, tok=0, cleanup=null, secure=false;
const isOpen=()=>!!root;

function setSecure(on){ if(DV.P) DV.P.setSecure({on}).catch(()=>{}); }
function ensure(){
  if(root) return;
  root=document.createElement('div'); root.id='viewer'; root.className='viewer'; root.setAttribute('role','dialog'); root.setAttribute('aria-modal','true');
  root.innerHTML='<div class="vbar"><button class="btn" type="button" data-v="close" aria-label="Close viewer">&larr; Back</button><div class="vt"><b id="v-name"></b><small id="v-sub"></small></div><div class="vact"><button class="btn" type="button" data-v="ext" id="v-ext">Open with…</button><button class="btn" type="button" data-v="share" id="v-share">Share</button></div></div><div class="vstage" id="v-stage"></div><button class="vnav prev" type="button" data-v="prev" aria-label="Previous file" hidden>&lsaquo;</button><button class="vnav next" type="button" data-v="next" aria-label="Next file" hidden>&rsaquo;</button>';
  root.addEventListener('click',e=>{
    const b=e.target.closest('[data-v]'); if(!b) return;
    const k=b.dataset.v;
    if(k==='close') close(); else if(k==='prev') step(-1); else if(k==='next') step(1);
    else if(k==='ext') DV.nat('openFile',{path:cur.path}).catch(x=>DV.toast(x.message));
    else if(k==='share') DV.nat('share',{paths:[cur.path]}).catch(x=>DV.toast(x.message));
  });
  document.body.appendChild(root);
}
function close(){
  if(!root) return;
  tok++; if(cleanup){ try{ cleanup(); }catch(e){} cleanup=null; }
  root.remove(); root=null; cur=null;
  if(secure){ secure=false; setSecure(DV.S.pane==='locker'&&DV.locker&&DV.locker.isOpen()); }
}
function open(it,siblings,o){
  if(!it||it.dir) return;
  opts=o||{};
  const t=typeOf(it);
  list=(siblings&&siblings.length?siblings:[it]).filter(x=>!x.dir);
  /* swipe through files of the same family only (images with images, and so on) */
  list=list.filter(x=>x.path===it.path||typeOf(x)===t&&(t==='img'||t==='vid'||t==='aud'));
  idx=Math.max(0,list.findIndex(x=>x.path===it.path)); if(!list.length){ list=[it]; idx=0; }
  ensure();
  if(opts.secure&&!secure){ secure=true; setSecure(true); }
  show(list[idx]);
}
function step(d){ const n=idx+d; if(n<0||n>=list.length) return; idx=n; show(list[idx]); }
function show(it){
  const my=++tok; if(cleanup){ try{ cleanup(); }catch(e){} cleanup=null; }
  cur=it; const st=$('#v-stage',root); st.innerHTML=''; st.className='vstage';
  $('#v-name',root).textContent=it.name;
  $('#v-sub',root).textContent=DV.fmtSize(it.size)+(list.length>1?' · '+(idx+1)+' of '+list.length:'');
  $('.prev',root).hidden=idx<=0; $('.next',root).hidden=idx>=list.length-1;
  const t=typeOf(it);
  const R={img:viewImage,vid:viewMedia,aud:viewMedia,pdf:viewPdf,text:viewText,docx:viewDocx,sheet:viewSheet,csv:viewSheet,zip:viewZip,pptx:viewPptx,legacy:viewLegacy,unknown:viewUnknown}[t];
  Promise.resolve().then(()=>R(it,st,()=>my===tok,t)).catch(e=>{ if(my===tok) fail(st,e&&e.message); });
}
function fail(st,msg,hint){
  st.className='vstage center';
  st.innerHTML='<div class="vmsg"><h3>Cannot show this file here</h3><p>'+esc(msg||'This file could not be displayed.')+'</p><button class="btn pri" type="button" data-v="ext">Open with another app</button></div>';
}
async function bytes(it){
  const r=await fetch(DV.fileUrl(it.path)); if(!r.ok) throw new Error('Could not read the file.');
  return r.arrayBuffer();
}
const big=(it,max)=>it.size>max;

/* ---------- image with pinch / double-tap zoom, drag, swipe ---------- */
function viewImage(it,st,alive){
  st.classList.add('imgs');
  const img=document.createElement('img'); img.className='vimg'; img.alt=it.name; img.draggable=false; img.decoding='async';
  st.appendChild(img);
  let s=1,x=0,y=0; const P=new Map(); let startDist=0,startS=1,sx=0,sy=0,ox=0,oy=0,swipeX=0,moved=false,lastTap=0;
  const apply=()=>{ img.style.transform='translate('+x+'px,'+y+'px) scale('+s+')'; };
  const clamp=()=>{ const r=st.getBoundingClientRect(); const mx=Math.max(0,(img.clientWidth*s-r.width)/2), my=Math.max(0,(img.clientHeight*s-r.height)/2); x=Math.max(-mx,Math.min(mx,x)); y=Math.max(-my,Math.min(my,y)); if(s<=1){ x=0; y=0; } };
  const zoomTo=(ns,cx,cy)=>{ const r=st.getBoundingClientRect(); const px=cx-r.left-r.width/2, py=cy-r.top-r.height/2; const k=ns/s; x=px-(px-x)*k; y=py-(py-y)*k; s=ns; clamp(); apply(); };
  img.onerror=()=>{ if(alive()) fail(st,'This image format is not supported by the built-in viewer.'); };
  img.src=DV.fileUrl(it.path);
  const d=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const down=e=>{ st.setPointerCapture&&st.setPointerCapture(e.pointerId); P.set(e.pointerId,{x:e.clientX,y:e.clientY}); moved=false;
    if(P.size===2){ const [a,b]=[...P.values()]; startDist=d(a,b); startS=s; }
    else{ sx=e.clientX; sy=e.clientY; ox=x; oy=y; swipeX=0; } };
  const move=e=>{ if(!P.has(e.pointerId)) return; P.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(P.size===2){ const [a,b]=[...P.values()]; const ns=Math.max(1,Math.min(8,startS*d(a,b)/startDist)); zoomTo(ns,(a.x+b.x)/2,(a.y+b.y)/2); moved=true; return; }
    const dx=e.clientX-sx, dy=e.clientY-sy; if(Math.abs(dx)+Math.abs(dy)>6) moved=true;
    if(s>1){ x=ox+dx; y=oy+dy; clamp(); apply(); } else swipeX=dx; };
  const up=e=>{ const had=P.delete(e.pointerId);
    if(!had) return;
    if(P.size===1){ const [a]=[...P.values()]; sx=a.x; sy=a.y; ox=x; oy=y; return; }
    if(P.size>0) return;
    if(s<=1.02){ s=1; x=0; y=0; apply(); }
    if(s===1&&Math.abs(swipeX)>70){ step(swipeX<0?1:-1); return; }
    if(!moved){ const now=Date.now(); if(now-lastTap<320){ lastTap=0; if(s>1){ s=1;x=0;y=0;apply(); } else zoomTo(2.5,e.clientX,e.clientY); } else lastTap=now; } };
  const wheel=e=>{ e.preventDefault(); const ns=Math.max(1,Math.min(8,s*(e.deltaY<0?1.15:1/1.15))); zoomTo(ns,e.clientX,e.clientY); };
  st.addEventListener('pointerdown',down); st.addEventListener('pointermove',move); st.addEventListener('pointerup',up); st.addEventListener('pointercancel',up); st.addEventListener('wheel',wheel,{passive:false});
  const key=e=>{ if(e.key==='ArrowLeft') step(-1); else if(e.key==='ArrowRight') step(1); };
  document.addEventListener('keydown',key);
  cleanup=()=>document.removeEventListener('keydown',key);
}

/* ---------- video and audio ---------- */
function viewMedia(it,st,alive,t){
  st.classList.add('center');
  const el=document.createElement(t==='vid'?'video':'audio'); el.controls=true; el.autoplay=true; el.playsInline=true; el.preload='metadata';
  el.className=t==='vid'?'vvid':'vaud'; el.src=DV.fileUrl(it.path);
  if(t==='aud'){ const w=document.createElement('div'); w.className='vaudw'; w.innerHTML='<div class="vaic">'+DV.icon('aud')+'</div><b>'+esc(it.name)+'</b>'; w.appendChild(el); st.appendChild(w); }
  else st.appendChild(el);
  el.addEventListener('error',()=>{ if(alive()) fail(st,'Android cannot play this '+(DV.extOf(it.name)||'media')+' format directly (the codec is not supported on this phone).'); });
  el.addEventListener('ended',()=>{ if(idx<list.length-1&&list.length>1&&t==='aud') step(1); });
  cleanup=()=>{ try{ el.pause(); el.removeAttribute('src'); el.load(); }catch(e){} };
}

/* ---------- PDF ---------- */
async function viewPdf(it,st,alive){
  st.classList.add('pdf'); st.innerHTML='<div class="vload">Opening PDF</div>';
  await loadScript('vendor/pdf.min.js');
  const lib=window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc='vendor/pdf.worker.min.js';
  const task=lib.getDocument({url:DV.fileUrl(it.path),disableAutoFetch:false});
  let doc; try{ doc=await task.promise; }catch(e){ if(!alive()) return; throw new Error(e&&e.name==='PasswordException'?'This PDF is password protected.':'This PDF could not be read.'); }
  if(!alive()){ doc.destroy(); return; }
  st.innerHTML='<div class="pdfbar"><button class="btn" type="button" id="pz-out" aria-label="Zoom out">&minus;</button><span id="pz-pg" class="mono"></span><button class="btn" type="button" id="pz-in" aria-label="Zoom in">+</button></div><div class="pdfpages" id="pdfp"></div>';
  const wrap=$('#pdfp',st); let zoom=1; const pages=[]; let obs=null;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const first=await doc.getPage(1);
  const baseW=()=>Math.max(200,wrap.clientWidth-16||320);
  async function build(){
    if(obs) obs.disconnect(); wrap.innerHTML=''; pages.length=0;
    obs=new IntersectionObserver(es=>es.forEach(en=>{ if(en.isIntersecting) draw(en.target); }),{root:wrap,rootMargin:'600px 0px'});
    const v1=first.getViewport({scale:1}); const sc=baseW()*zoom/v1.width;
    for(let n=1;n<=doc.numPages;n++){
      const box=document.createElement('div'); box.className='pdfpg'; box.dataset.n=n;
      const h=n===1?v1.height*sc:v1.height*sc; box.style.width=(v1.width*sc)+'px'; box.style.height=h+'px';
      wrap.appendChild(box); obs.observe(box); pages.push(box);
    }
  }
  async function draw(box){
    if(box.dataset.done||!alive()) return; box.dataset.done='1';
    try{
      const p=await doc.getPage(+box.dataset.n); const v0=p.getViewport({scale:1}); const sc=parseFloat(box.style.width)/v0.width;
      const vp=p.getViewport({scale:sc*dpr}); const c=document.createElement('canvas'); c.width=Math.floor(vp.width); c.height=Math.floor(vp.height);
      c.style.width=parseFloat(box.style.width)+'px'; c.style.height=(vp.height/dpr)+'px'; box.style.height=c.style.height;
      await p.render({canvasContext:c.getContext('2d'),viewport:vp,background:'#fff'}).promise;
      if(alive()) box.appendChild(c);
    }catch(e){ delete box.dataset.done; }
  }
  const upd=()=>{ const r=wrap.getBoundingClientRect(); let n=1; for(const b of pages){ if(b.getBoundingClientRect().top-r.top<r.height/2) n=+b.dataset.n; else break; } $('#pz-pg',st).textContent=n+' / '+doc.numPages; };
  wrap.addEventListener('scroll',upd,{passive:true});
  $('#pz-in',st).onclick=()=>{ zoom=Math.min(4,zoom*1.25); build().then(upd); };
  $('#pz-out',st).onclick=()=>{ zoom=Math.max(.5,zoom/1.25); build().then(upd); };
  await build(); upd();
  cleanup=()=>{ if(obs) obs.disconnect(); try{ doc.destroy(); }catch(e){} };
}

/* ---------- text ---------- */
async function viewText(it,st,alive){
  st.classList.add('textv');
  const r=await DV.nat('readText',{path:it.path,max:200000});
  if(!alive()) return;
  if(r.binary) throw new Error('This file is not plain text.');
  st.innerHTML='<pre class="vtext"></pre>'+(r.truncated?'<div class="vnote">Showing the first 200,000 characters.</div>':'');
  let t=r.text||'(empty file)';
  if(DV.extOf(it.name)==='json'&&!r.truncated){ try{ t=JSON.stringify(JSON.parse(t),null,2); }catch(e){} }
  $('pre',st).textContent=t;
}
async function viewUnknown(it,st,alive){
  if(it.size>0&&it.size<=2e6){
    try{
      const r=await DV.nat('readText',{path:it.path,max:200000});
      if(!alive()) return;
      if(!r.binary){ st.classList.add('textv'); st.innerHTML='<pre class="vtext"></pre>'; $('pre',st).textContent=r.text||'(empty file)'; return; }
    }catch(e){}
  }
  fail(st,'Delta Vault has no built-in viewer for .'+(DV.extOf(it.name)||'this')+' files yet.');
}

/* ---------- Word ---------- */
async function viewDocx(it,st,alive){
  if(big(it,25e6)) throw new Error('This document is too large to open here.');
  st.innerHTML='<div class="vload">Opening document</div>';
  await loadScript('vendor/mammoth.browser.min.js');
  const buf=await bytes(it); if(!alive()) return;
  const r=await window.mammoth.convertToHtml({arrayBuffer:buf});
  if(!alive()) return;
  st.className='vstage docv';
  const d=document.createElement('div'); d.className='vdoc'; d.innerHTML=r.value||'<p>(empty document)</p>';
  d.querySelectorAll('script,iframe,object,embed,link,style').forEach(n=>n.remove());
  d.querySelectorAll('a').forEach(a=>{ a.removeAttribute('href'); });
  st.innerHTML=''; st.appendChild(d);
}

/* ---------- PowerPoint ---------- */
async function viewPptx(it,st,alive){
  if(big(it,60e6)) throw new Error('This presentation is too large to open here.');
  st.innerHTML='<div class="vload">Opening presentation</div>';
  await Promise.all([loadScript('vendor/jszip.min.js'),loadScript('vendor/pptx-preview.umd.js')]);
  const buf=await bytes(it); if(!alive()) return;
  let ratio=9/16;
  try{
    const z=await window.JSZip.loadAsync(buf.slice(0)); const f=z.file('ppt/presentation.xml');
    if(f){ const m=/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(await f.async('string')); if(m&&+m[1]>0) ratio=+m[2]/+m[1]; }
  }catch(e){}
  if(!alive()) return;
  st.className='vstage deckv'; st.innerHTML='<div class="deckwrap" id="deckw"></div>';
  const wrap=$('#deckw',st);
  const W=Math.max(240,Math.min(1100,(st.clientWidth||360)-16)); const H=Math.round(W*ratio);
  const v=window.pptxPreview.init(wrap,{width:W,height:H,mode:'list'});
  try{ await v.preview(buf); }
  catch(e){ if(alive()) throw new Error('This presentation could not be read. It may be damaged or use features the viewer does not support.'); return; }
  if(!alive()){ try{ v.destroy(); }catch(e){} return; }
  cleanup=()=>{ try{ v.destroy(); }catch(e){} };
}
function viewLegacy(it,st){
  const e=DV.extOf(it.name);
  const nm={ppt:'PowerPoint 97-2003 (.ppt)',doc:'Word 97-2003 (.doc)',odp:'OpenDocument presentation (.odp)',odt:'OpenDocument text (.odt)'}[e]||'This format';
  throw new Error(nm+' is an old format that cannot be shown in the app. Save it as '+(e==='ppt'||e==='odp'?'.pptx':'.docx')+' in the app you made it with, then open it again.');
}

/* ---------- spreadsheets and CSV ---------- */
async function viewSheet(it,st,alive,t){
  if(big(it,20e6)) throw new Error('This spreadsheet is too large to open here.');
  st.innerHTML='<div class="vload">Opening spreadsheet</div>';
  await loadScript('vendor/xlsx.mini.min.js');
  const buf=await bytes(it); if(!alive()) return;
  const X=window.XLSX; const wb=X.read(buf,{type:'array',cellDates:true,raw:t==='csv'?true:false});
  if(!alive()) return;
  st.className='vstage sheetv';
  const names=wb.SheetNames; if(!names.length) throw new Error('This file has no sheets.');
  const MAXR=2000;
  const draw=i=>{
    const ws=wb.Sheets[names[i]]; const rows=X.utils.sheet_to_json(ws,{header:1,raw:false,defval:''});
    const shown=rows.slice(0,MAXR); const cols=Math.min(60,shown.reduce((m,r)=>Math.max(m,r.length),0));
    let h='<table class="vtab"><tbody>'+shown.map((r,ri)=>'<tr><th>'+(ri+1)+'</th>'+Array.from({length:cols},(_,c)=>'<td>'+esc(r[c]==null?'':r[c])+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
    if(rows.length>MAXR) h+='<div class="vnote">Showing the first '+MAXR+' of '+rows.length.toLocaleString()+' rows.</div>';
    $('#sh-body',st).innerHTML=h;
    st.querySelectorAll('[data-sh]').forEach(b=>b.classList.toggle('on',+b.dataset.sh===i));
  };
  st.innerHTML=(names.length>1?'<div class="shtabs">'+names.map((n,i)=>'<button type="button" class="btn" data-sh="'+i+'">'+esc(n)+'</button>').join('')+'</div>':'')+'<div class="shbody" id="sh-body"></div>';
  st.querySelectorAll('[data-sh]').forEach(b=>b.addEventListener('click',()=>draw(+b.dataset.sh)));
  draw(0);
}

/* ---------- zip / apk contents ---------- */
async function viewZip(it,st,alive){
  if(big(it,300e6)) throw new Error('This archive is too large to list here.');
  st.innerHTML='<div class="vload">Reading archive</div>';
  await loadScript('vendor/jszip.min.js');
  const buf=await bytes(it); if(!alive()) return;
  const z=await window.JSZip.loadAsync(buf); if(!alive()) return;
  const ents=Object.values(z.files).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  const files=ents.filter(e=>!e.dir);
  const total=files.reduce((a,e)=>a+((e._data&&e._data.uncompressedSize)||0),0);
  st.className='vstage zipv';
  st.innerHTML='<div class="vnote" style="padding:10px 14px">'+DV.plural(files.length,'file')+' · '+DV.fmtSize(total)+' unpacked. This is a read-only list.</div><ul class="ziplist">'+ents.slice(0,3000).map(e=>'<li class="'+(e.dir?'d':'')+'"><span>'+esc(e.name)+'</span><em>'+(e.dir?'':DV.fmtSize((e._data&&e._data.uncompressedSize)||0))+'</em></li>').join('')+'</ul>'+(ents.length>3000?'<div class="vnote">Showing the first 3,000 entries.</div>':'');
}

DV.viewer={ open, close, isOpen, closeIfSecure(){ if(secure) close(); }, typeOf };
})();
