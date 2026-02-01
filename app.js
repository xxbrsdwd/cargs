const $ = (id)=>document.getElementById(id);

function setStatus(type, text){
  const dot = $("dot");
  dot.classList.remove("ok","bad");
  if(type==="ok") dot.classList.add("ok");
  if(type==="bad") dot.classList.add("bad");
  $("statusText").textContent = text;
}

function nowStamp(){
  const d = new Date();
  const pad = (n)=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function digitsOnly(s){ return String(s||"").replace(/\D/g,""); }

function openWhatsAppText(text){
  // sin popups, siempre hace algo
  const encoded = encodeURIComponent(text);
  const webUrl = `https://wa.me/?text=${encoded}`;
  location.href = webUrl;
}

async function dataUrlToFile(dataUrl, filename){
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, {type: blob.type || "image/jpeg"});
}

/* ===== Storage ===== */
const STORAGE_KEY = "registro_cargas_roi_v1";
function loadStore(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"history":[]}'); }
  catch{ return {history:[]}; }
}
function saveStore(store){ localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }

let store = loadStore();
let current = { id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()), date: nowStamp(), tracking:"", items:[] };

function persist(){
  if(!current.tracking && current.items.length===0) return;
  const idx = store.history.findIndex(x=>x.id===current.id);
  const copy = JSON.parse(JSON.stringify(current));
  if(idx>=0) store.history[idx]=copy;
  else store.history.unshift(copy);
  store.history = store.history.slice(0,150);
  saveStore(store);
  renderHistory();
}

/* ===== Canvas + ROI ===== */
const scanCanvas = $("scanCanvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently:true });

let srcImg = null;        // Image()
let workCanvas = document.createElement("canvas"); // imagen ya escalada + rotada
let workCtx = workCanvas.getContext("2d", { willReadFrequently:true });
let rotation = 0;         // 0,90,180,270

let roi = null;           // {x,y,w,h} en coords del scanCanvas (display)
let drawing = false;
let startPt = null;

function fitCanvasToImage(){
  if(!workCanvas.width || !workCanvas.height) return;

  // canvas interno (pixeles reales) se adapta al contenedor por ancho
  const wrapWidth = scanCanvas.parentElement.clientWidth;
  const ratio = workCanvas.height / workCanvas.width;

  // tamaño real del canvas (para que se vea nítido)
  const realW = Math.min(1200, Math.max(360, Math.floor(wrapWidth * devicePixelRatio)));
  const realH = Math.floor(realW * ratio);

  scanCanvas.width = realW;
  scanCanvas.height = realH;

  drawScene();
}

function drawScene(){
  // dibuja workCanvas escalado a scanCanvas
  scanCtx.clearRect(0,0,scanCanvas.width, scanCanvas.height);
  if(workCanvas.width && workCanvas.height){
    scanCtx.drawImage(workCanvas, 0,0, workCanvas.width,workCanvas.height, 0,0, scanCanvas.width, scanCanvas.height);
  } else {
    scanCtx.fillStyle="#000"; scanCtx.fillRect(0,0,scanCanvas.width, scanCanvas.height);
  }

  // recuadro ROI
  if(roi && roi.w>5 && roi.h>5){
    scanCtx.save();
    scanCtx.strokeStyle = "rgba(35,197,94,0.95)";
    scanCtx.lineWidth = Math.max(2, 3*devicePixelRatio);
    scanCtx.setLineDash([10*devicePixelRatio, 8*devicePixelRatio]);
    scanCtx.strokeRect(roi.x, roi.y, roi.w, roi.h);
    scanCtx.fillStyle = "rgba(35,197,94,0.12)";
    scanCtx.fillRect(roi.x, roi.y, roi.w, roi.h);
    scanCtx.restore();
  }
}

function canvasPointFromEvent(e){
  const rect = scanCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (scanCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (scanCanvas.height / rect.height);
  return {x,y};
}

scanCanvas.addEventListener("pointerdown",(e)=>{
  if(!workCanvas.width) return;
  drawing = true;
  scanCanvas.setPointerCapture(e.pointerId);
  startPt = canvasPointFromEvent(e);
  roi = { x:startPt.x, y:startPt.y, w:1, h:1 };
  drawScene();
});
scanCanvas.addEventListener("pointermove",(e)=>{
  if(!drawing || !startPt) return;
  const p = canvasPointFromEvent(e);
  const x = Math.min(startPt.x, p.x);
  const y = Math.min(startPt.y, p.y);
  const w = Math.abs(p.x - startPt.x);
  const h = Math.abs(p.y - startPt.y);
  roi = {x,y,w,h};
  drawScene();
});
scanCanvas.addEventListener("pointerup",()=>{
  drawing = false;
  startPt = null;
  if(roi && (roi.w<15 || roi.h<15)){
    roi = null; // muy pequeño
    drawScene();
  }
});

/* ===== Load image + rotate ===== */
let trackPhotoFile = null;

async function loadImageFromFile(file){
  trackPhotoFile = file;
  const url = await fileToDataURL(file);
  srcImg = await dataURLToImage(url);
  rotation = 0;
  renderWorkCanvas();
  enableTrackButtons(true);
  setStatus("ok","Foto cargada. Dibuja el recuadro sobre el tracking y usa OCR del recuadro.");
}

function fileToDataURL(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function dataURLToImage(dataUrl){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.onload = ()=>resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function renderWorkCanvas(){
  if(!srcImg) return;

  // Escalar a tamaño manejable para OCR
  const maxW = 1800;
  const scale = Math.min(1, maxW / srcImg.width);
  const baseW = Math.floor(srcImg.width * scale);
  const baseH = Math.floor(srcImg.height * scale);

  // canvas base
  const base = document.createElement("canvas");
  base.width = baseW; base.height = baseH;
  const bctx = base.getContext("2d", {willReadFrequently:true});
  bctx.drawImage(srcImg, 0,0, srcImg.width,srcImg.height, 0,0, baseW,baseH);

  // aplicar rotación al workCanvas
  const rot = ((rotation%360)+360)%360;
  const swap = rot===90 || rot===270;
  workCanvas.width = swap ? baseH : baseW;
  workCanvas.height = swap ? baseW : baseH;

  workCtx.save();
  workCtx.clearRect(0,0,workCanvas.width, workCanvas.height);

  if(rot===0){
    workCtx.drawImage(base,0,0);
  }else if(rot===90){
    workCtx.translate(workCanvas.width,0);
    workCtx.rotate(Math.PI/2);
    workCtx.drawImage(base,0,0);
  }else if(rot===180){
    workCtx.translate(workCanvas.width, workCanvas.height);
    workCtx.rotate(Math.PI);
    workCtx.drawImage(base,0,0);
  }else if(rot===270){
    workCtx.translate(0, workCanvas.height);
    workCtx.rotate(-Math.PI/2);
    workCtx.drawImage(base,0,0);
  }
  workCtx.restore();

  roi = null;
  fitCanvasToImage();

  $("ocrProgress").textContent = "Dibuja el recuadro sobre el tracking.";
  $("ocrDebug").textContent = window.Tesseract ? "OCR: Tesseract cargado ✅" : "OCR: ❌ no cargó (abre en Chrome + internet)";
}

function enableTrackButtons(on){
  $("btnRotate").disabled = !on;
  $("btnRemoveTrackPhoto").disabled = !on;
  $("btnOcrBox").disabled = !on;
  $("btnOcrAuto").disabled = !on;
}

window.addEventListener("resize", ()=>{
  if(workCanvas.width) fitCanvasToImage();
});

/* ===== OCR ===== */
let worker = null;
const MIN_TRACK = 8;

async function ensureWorker(){
  if(!window.Tesseract){
    $("ocrDebug").textContent = "OCR: ❌ Tesseract no cargó (Chrome + internet)";
    throw new Error("No Tesseract");
  }
  if(worker) return worker;

  $("ocrDebug").textContent = "OCR: creando worker…";
  worker = await Tesseract.createWorker({
    logger:(m)=>{
      if(m.status==="recognizing text"){
        $("ocrProgress").textContent = `OCR leyendo… ${Math.round((m.progress||0)*100)}%`;
      }
    }
  });

  await worker.loadLanguage("eng");
  await worker.initialize("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    preserve_interword_spaces: "1"
  });

  $("ocrDebug").textContent = "OCR: ✅ listo";
  return worker;
}

function preprocessBW(canvas){
  // B/N fuerte en un canvas (in-place)
  const ctx = canvas.getContext("2d", {willReadFrequently:true});
  const img = ctx.getImageData(0,0,canvas.width, canvas.height);
  const d = img.data;

  let sum=0;
  for(let i=0;i<d.length;i+=4){
    const g = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    sum += g;
  }
  const avg = sum/(d.length/4);
  const thr = avg*0.88;

  for(let i=0;i<d.length;i+=4){
    let g = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    g = (g-avg)*1.7 + avg;
    const v = (g < thr) ? 0 : 255;
    d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
}

function extractDigitRuns(text){
  const runs = (String(text||"").match(/\d+/g) || [])
    .map(x=>digitsOnly(x))
    .filter(x=>x.length>=MIN_TRACK);

  const seen=new Set();
  const uniq=[];
  for(const r of runs){
    if(!seen.has(r)){ seen.add(r); uniq.push(r); }
  }
  uniq.sort((a,b)=>b.length - a.length);
  return uniq.slice(0,10);
}

function setCandidates(list){
  const wrap = $("candWrap");
  const chips = $("candChips");
  chips.innerHTML = "";
  if(!list.length){ wrap.classList.remove("show"); return; }
  wrap.classList.add("show");

  list.forEach((v,i)=>{
    const el = document.createElement("div");
    el.className = "chip" + (i===0 ? " best":"");
    el.textContent = v;
    el.onclick = ()=>{
      $("tracking").value = v;
      current.tracking = v;
      persist();
      renderItems();
      setStatus("ok","Tracking seleccionado ✅");
    };
    chips.appendChild(el);
  });
}

function cropFromROI(){
  if(!roi) return null;

  // map display ROI -> workCanvas ROI
  const rx = workCanvas.width / scanCanvas.width;
  const ry = workCanvas.height / scanCanvas.height;

  const x = Math.max(0, Math.floor(roi.x * rx));
  const y = Math.max(0, Math.floor(roi.y * ry));
  const w = Math.min(workCanvas.width - x, Math.floor(roi.w * rx));
  const h = Math.min(workCanvas.height - y, Math.floor(roi.h * ry));

  if(w < 40 || h < 20) return null;

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(workCanvas, x,y,w,h, 0,0,w,h);
  preprocessBW(c);
  return c;
}

function makeAutoBand(){
  // recorte automático “banda” (zona media-baja)
  const w = workCanvas.width;
  const h = workCanvas.height;
  const x = 0;
  const y = Math.floor(h*0.30);
  const cw = w;
  const ch = Math.floor(h*0.55);

  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");
  ctx.drawImage(workCanvas, x,y,cw,ch, 0,0,cw,ch);
  preprocessBW(c);
  return c;
}

async function ocrCanvas(canvas, psm){
  const w = await ensureWorker();
  await w.setParameters({ tessedit_pageseg_mode: String(psm) });
  const res = await w.recognize(canvas.toDataURL("image/png"));
  return res?.data?.text || "";
}

async function runOcrBox(){
  if(!trackPhotoFile || !workCanvas.width){
    setStatus("bad","Primero sube/toma la foto del tracking.");
    return;
  }
  if(!roi){
    setStatus("bad","Dibuja el recuadro sobre el tracking primero.");
    return;
  }

  setStatus("ok","OCR del recuadro…");
  setCandidates([]);

  try{
    const c = cropFromROI();
    if(!c){
      setStatus("bad","Recuadro muy pequeño. Hazlo más grande sobre el número.");
      return;
    }

    $("ocrProgress").textContent = "OCR (recuadro / línea)…";
    const t1 = await ocrCanvas(c, 7);
    let cands = extractDigitRuns(t1);

    if(!cands.length){
      $("ocrProgress").textContent = "OCR (recuadro / bloque)…";
      const t2 = await ocrCanvas(c, 6);
      cands = extractDigitRuns(t2);
    }

    if(!cands.length){
      $("ocrProgress").textContent = "No detectado.";
      setStatus("bad","No detecté tracking. Ajusta el recuadro solo al número (sin textos extra).");
      return;
    }

    setCandidates(cands);
    const best = cands[0];
    $("tracking").value = best;
    current.tracking = best;
    persist();
    renderItems();

    $("ocrProgress").textContent = `Detectado: ${best} (${best.length} dígitos)`;
    setStatus("ok","✅ Tracking capturado.");
  }catch(e){
    console.error(e);
    $("ocrProgress").textContent = "Error OCR.";
    setStatus("bad","OCR falló. Abre en Chrome normal y prueba de nuevo.");
  }
}

async function runOcrAuto(){
  if(!trackPhotoFile || !workCanvas.width){
    setStatus("bad","Primero sube/toma la foto del tracking.");
    return;
  }

  setStatus("ok","OCR automático…");
  setCandidates([]);

  try{
    const band = makeAutoBand();

    $("ocrProgress").textContent = "OCR (banda / línea)…";
    const t1 = await ocrCanvas(band, 7);
    let cands = extractDigitRuns(t1);

    if(!cands.length){
      $("ocrProgress").textContent = "OCR (banda / bloque)…";
      const t2 = await ocrCanvas(band, 6);
      cands = extractDigitRuns(t2);
    }

    if(!cands.length){
      $("ocrProgress").textContent = "No detectado.";
      setStatus("bad","No detecté tracking. Mejor usa el recuadro (manual) sobre el número.");
      return;
    }

    setCandidates(cands);
    const best = cands[0];
    $("tracking").value = best;
    current.tracking = best;
    persist();
    renderItems();

    $("ocrProgress").textContent = `Detectado: ${best} (${best.length} dígitos)`;
    setStatus("ok","✅ Tracking capturado.");
  }catch(e){
    console.error(e);
    $("ocrProgress").textContent = "Error OCR.";
    setStatus("bad","OCR falló. Abre en Chrome normal y prueba de nuevo.");
  }
}

/* ===== Productos + fotos ===== */
let pendingPhoto = null;

function renderPending(){
  const wrap = $("pendingWrap");
  if(pendingPhoto){
    wrap.classList.add("show");
    $("pendingImg").src = pendingPhoto;
    $("btnRemovePending").disabled = false;
  }else{
    wrap.classList.remove("show");
    $("pendingImg").src = "";
    $("btnRemovePending").disabled = true;
  }
}

function renderItems(){
  const list = $("itemsList");
  list.innerHTML = "";

  if(current.items.length===0){
    const div=document.createElement("div");
    div.className="hint";
    div.textContent="Aún no hay productos.";
    list.appendChild(div);
  }else{
    current.items.forEach((it, idx)=>{
      const row=document.createElement("div");
      row.className="item";

      const th=document.createElement("div");
      th.className="thumb";
      if(it.photo){
        const img=document.createElement("img");
        img.src=it.photo;
        th.appendChild(img);
      }else{
        const p=document.createElement("div");
        p.className="noimg";
        p.textContent="Sin foto";
        th.appendChild(p);
      }

      const meta=document.createElement("div");
      meta.className="meta";

      const top=document.createElement("div");
      top.className="metaTop";

      const info=document.createElement("div");
      const st=document.createElement("strong");
      st.textContent = `${idx+1}) ${it.qty} / ${it.product}`;
      const sm=document.createElement("small");
      sm.textContent = `Tracking: ${current.tracking || "(vacío)"}`;
      info.appendChild(st);
      info.appendChild(sm);

      const right=document.createElement("div");
      const del=document.createElement("button");
      del.className="btn danger";
      del.textContent="Eliminar";
      del.onclick=()=>{
        current.items.splice(idx,1);
        persist();
        renderItems();
      };
      right.appendChild(del);

      top.appendChild(info);
      top.appendChild(right);

      meta.appendChild(top);

      row.appendChild(th);
      row.appendChild(meta);
      list.appendChild(row);
    });
  }

  const totalUnits = current.items.reduce((a,b)=>a+(Number(b.qty)||0),0);
  $("totalUnits").textContent = String(totalUnits);
  $("totalItems").textContent = String(current.items.length);
}

function renderHistory(){
  const wrap = $("historyList");
  wrap.innerHTML = "";
  if(store.history.length===0){
    const div=document.createElement("div");
    div.className="hint";
    div.textContent="Sin historial aún.";
    wrap.appendChild(div);
    return;
  }

  store.history.forEach((h)=>{
    const item=document.createElement("div");
    item.className="historyItem";

    const top=document.createElement("div");
    top.className="historyTop";

    const left=document.createElement("div");
    const st=document.createElement("strong");
    st.textContent = `Tracking: ${h.tracking || "(sin tracking)"}`;
    const units=h.items.reduce((a,b)=>a+(Number(b.qty)||0),0);
    const sm=document.createElement("small");
    sm.textContent = `${h.date} · ${h.items.length} productos · ${units} unidades`;
    left.appendChild(st);
    left.appendChild(sm);

    const act=document.createElement("div");
    act.className="historyActions";

    const open=document.createElement("button");
    open.className="btn secondary";
    open.textContent="Abrir";
    open.onclick=()=>{
      current = JSON.parse(JSON.stringify(h));
      $("tracking").value = current.tracking || "";
      $("date").value = current.date || nowStamp();
      pendingPhoto = null;
      renderPending();

      // reset foto tracking
      trackPhotoFile=null; srcImg=null; workCanvas.width=0; workCanvas.height=0;
      roi=null; drawScene();
      enableTrackButtons(false);
      setCandidates([]);
      $("ocrProgress").textContent="Sube una foto para empezar.";

      renderItems();
      setStatus("ok","Carga cargada del historial.");
    };

    const del=document.createElement("button");
    del.className="btn danger";
    del.textContent="Eliminar";
    del.onclick=()=>{
      store.history = store.history.filter(x=>x.id!==h.id);
      saveStore(store);
      renderHistory();
      setStatus("ok","Carga eliminada.");
    };

    act.appendChild(open);
    act.appendChild(del);

    top.appendChild(left);
    top.appendChild(act);
    item.appendChild(top);
    wrap.appendChild(item);
  });
}

/* ===== WhatsApp ===== */
function buildText(){
  const lines=[];
  lines.push("📦 Carga registrada");
  lines.push(`Tracking: ${current.tracking || "(sin tracking)"}`);
  lines.push(`Fecha: ${current.date}`);
  lines.push("");
  current.items.forEach((it,i)=> lines.push(`${i+1}) ${it.qty} / ${it.product}`));
  const totalUnits = current.items.reduce((a,b)=>a+(Number(b.qty)||0),0);
  lines.push("");
  lines.push(`✅ Total unidades: ${totalUnits}`);
  lines.push(`🧾 Total productos: ${current.items.length}`);
  return lines.join("\n");
}

async function sendAllPhotos(){
  if(!current.items.length){
    setStatus("bad","No hay productos.");
    return;
  }
  if(!navigator.share || !navigator.canShare){
    setStatus("bad","Tu navegador no soporta compartir. Usa Chrome actualizado.");
    return;
  }

  // armar lista de archivos
  const files=[];
  for(let i=0;i<current.items.length;i++){
    const it=current.items[i];
    if(!it.photo) continue;
    const f = await dataUrlToFile(it.photo, `foto_${i+1}.jpg`);
    files.push(f);
  }
  if(!files.length){
    setStatus("bad","No hay fotos para enviar.");
    return;
  }

  // intenta TODAS juntas
  try{
    if(navigator.canShare({files})){
      setStatus("ok","Compartiendo TODAS las fotos…");
      await navigator.share({ files });
      setStatus("ok","✅ Fotos compartidas. Ahora envía el texto.");
      return;
    }
  }catch(e){
    // sigue al fallback
  }

  // fallback: 1 por 1
  setStatus("ok","Tu teléfono no permite todas juntas. Enviando 1 por 1…");
  for(const file of files){
    try{
      await navigator.share({ files:[file] });
    }catch(e){
      setStatus("bad","Compartir cancelado.");
      return;
    }
  }
  setStatus("ok","✅ Fotos compartidas. Ahora envía el texto.");
}

/* ===== UI init ===== */
function reset(){
  current = { id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()), date: nowStamp(), tracking:"", items:[] };
  $("tracking").value="";
  $("date").value=current.date;

  pendingPhoto=null; renderPending();

  // reset tracking photo + canvas
  trackPhotoFile=null; srcImg=null; workCanvas.width=0; workCanvas.height=0;
  roi=null; drawScene();
  enableTrackButtons(false);
  setCandidates([]);
  $("ocrProgress").textContent="Sube una foto para empezar.";
  $("ocrDebug").textContent = window.Tesseract ? "OCR: Tesseract cargado ✅" : "OCR: ❌ no cargó (Chrome + internet)";

  renderItems();
  setStatus("ok","Nueva carga lista.");
}

function enableTrackButtons(on){
  $("btnRotate").disabled = !on;
  $("btnRemoveTrackPhoto").disabled = !on;
  $("btnOcrBox").disabled = !on;
  $("btnOcrAuto").disabled = !on;
}

function init(){
  $("date").value = current.date;

  $("tracking").addEventListener("input",(e)=>{
    const v = digitsOnly(e.target.value);
    e.target.value = v;
    current.tracking = v;
    persist();
    renderItems();
  });

  $("btnNew").addEventListener("click", ()=>{ persist(); reset(); });
  $("btnClear").addEventListener("click", ()=>{
    if(!confirm("¿Borrar TODO el historial?")) return;
    store={history:[]}; saveStore(store);
    reset();
    renderHistory();
    setStatus("ok","Historial borrado.");
  });

  $("btnTrackCam").addEventListener("click", ()=> $("trackCamInput").click());
  $("btnTrackPick").addEventListener("click", ()=> $("trackPickInput").click());

  function handleTrack(file){
    if(!file) return;
    loadImageFromFile(file).catch(()=> setStatus("bad","No pude cargar esa foto."));
  }

  $("trackCamInput").addEventListener("change",(e)=>{
    const f=e.target.files?.[0];
    e.target.value="";
    handleTrack(f);
  });
  $("trackPickInput").addEventListener("change",(e)=>{
    const f=e.target.files?.[0];
    e.target.value="";
    handleTrack(f);
  });

  $("btnRotate").addEventListener("click", ()=>{
    if(!srcImg) return;
    rotation = (rotation + 90) % 360;
    renderWorkCanvas();
    setStatus("ok","Imagen girada. Vuelve a dibujar el recuadro.");
  });

  $("btnRemoveTrackPhoto").addEventListener("click", ()=>{
    trackPhotoFile=null; srcImg=null; workCanvas.width=0; workCanvas.height=0;
    roi=null; drawScene();
    enableTrackButtons(false);
    setCandidates([]);
    $("ocrProgress").textContent="Sube una foto para empezar.";
    setStatus("ok","Foto removida.");
  });

  $("btnOcrBox").addEventListener("click", runOcrBox);
  $("btnOcrAuto").addEventListener("click", runOcrAuto);

  // Product photo
  $("btnProdCam").addEventListener("click", ()=> $("prodCamInput").click());
  $("btnProdPick").addEventListener("click", ()=> $("prodPickInput").click());

  function handleProd(file){
    if(!file) return;
    const r=new FileReader();
    r.onload=()=>{
      pendingPhoto=r.result;
      renderPending();
      setStatus("ok","Foto de producto lista ✅");
    };
    r.readAsDataURL(file);
  }
  $("prodCamInput").addEventListener("change",(e)=>{
    const f=e.target.files?.[0]; e.target.value="";
    handleProd(f);
  });
  $("prodPickInput").addEventListener("change",(e)=>{
    const f=e.target.files?.[0]; e.target.value="";
    handleProd(f);
  });

  $("btnRemovePending").addEventListener("click", ()=>{
    pendingPhoto=null;
    renderPending();
    setStatus("ok","Foto pendiente removida.");
  });

  $("btnAdd").addEventListener("click", ()=>{
    const product = $("product").value.trim();
    const qty = Number($("qty").value);

    if(!current.tracking){ setStatus("bad","Falta tracking."); return; }
    if(!product){ setStatus("bad","Falta producto."); return; }
    if(!qty || qty<1){ setStatus("bad","Unidades inválidas."); return; }
    if(!pendingPhoto){ setStatus("bad","Falta foto del producto."); return; }

    current.items.push({product, qty: Math.floor(qty), photo: pendingPhoto});
    $("product").value="";
    $("qty").value="";
    pendingPhoto=null;
    renderPending();

    persist();
    renderItems();
    setStatus("ok","Producto agregado ✅");
  });

  $("btnWAImages").addEventListener("click", sendAllPhotos);
  $("btnWAText").addEventListener("click", ()=>{
    if(!current.tracking || !current.items.length){
      setStatus("bad","Falta tracking o productos.");
      return;
    }
    persist();
    openWhatsAppText(buildText());
  });

  $("btnExport").addEventListener("click", ()=>{
    const blob=new Blob([JSON.stringify(store,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download="historial_cargas.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),800);
    setStatus("ok","Exportado JSON.");
  });

  // initial render
  enableTrackButtons(false);
  renderPending();
  renderItems();
  renderHistory();
  fitCanvasToImage();
  $("ocrDebug").textContent = window.Tesseract ? "OCR: Tesseract cargado ✅" : "OCR: ❌ no cargó (Chrome + internet)";
  setStatus("ok","Listo.");
}

init();
