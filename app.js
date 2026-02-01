/* ========= Helpers ========= */
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

function sanitizeDigitsOnly(s){
  return String(s||"").replace(/\D/g,"").trim();
}

function openWhatsAppText(text){
  // 100% sin popup: cambia la ubicación
  // Intenta abrir app (en móvil), si no, usa wa.me
  const encoded = encodeURIComponent(text);
  const appUrl = `whatsapp://send?text=${encoded}`;
  const webUrl = `https://wa.me/?text=${encoded}`;

  // Intento app primero (si está en móvil)
  // En algunos Android no pasa nada, entonces fallback con timer a web
  let done = false;
  try{
    location.href = appUrl;
    done = true;
  }catch(e){}

  setTimeout(()=>{
    // fallback seguro
    if(!done){
      location.href = webUrl;
    }else{
      // incluso si "done", igual lanzamos fallback por si no abrió
      // (no afecta si ya abrió WhatsApp)
      location.href = webUrl;
    }
  }, 600);
}

async function dataUrlToFile(dataUrl, filename){
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, {type: blob.type || "image/jpeg"});
}

/* ========= Store ========= */
const STORAGE_KEY = "registro_cargas_simple_v1";

function loadStore(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"history":[]}'); }
  catch{ return {history:[]}; }
}
function saveStore(store){ localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }

let store = loadStore();
let current = {
  id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()),
  date: nowStamp(),
  tracking: "",
  items: []
};

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

/* ========= OCR (Tesseract) ========= */
let worker = null;
let trackPhotoFile = null;
let trackPhotoDataUrl = "";
const MIN_TRACK = 8;

function showTrackPreview(show){
  const box = $("trackPreview");
  if(show){
    box.classList.add("show");
    $("trackImg").src = trackPhotoDataUrl;
  }else{
    box.classList.remove("show");
    $("trackImg").src = "";
  }
}

function setCandidates(cands){
  const wrap = $("candWrap");
  const chips = $("candChips");
  chips.innerHTML = "";
  if(!cands.length){ wrap.classList.remove("show"); return; }
  wrap.classList.add("show");

  cands.forEach((v, i)=>{
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

async function ensureWorker(){
  if(!window.Tesseract){
    $("ocrDebug").textContent = "OCR: ❌ Tesseract no cargó (abre en Chrome + internet)";
    throw new Error("No Tesseract");
  }
  if(worker) return worker;

  $("ocrDebug").textContent = "OCR: creando worker…";
  worker = await Tesseract.createWorker({
    logger: (m)=>{
      if(m.status==="recognizing text"){
        $("ocrProgress").textContent = `OCR leyendo… ${Math.round((m.progress||0)*100)}%`;
      }
    }
  });

  await worker.loadLanguage("eng");
  await worker.initialize("eng");

  $("ocrDebug").textContent = "OCR: ✅ listo";
  return worker;
}

async function createBitmap(file){
  try{ return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch{ return await createImageBitmap(file); }
}

function preprocess(bitmap, mode){
  // recorte + B/N fuerte para números
  const srcW = bitmap.width, srcH = bitmap.height;

  let cropX=0, cropY=0, cropW=srcW, cropH=srcH;
  if(mode==="band"){
    cropY = Math.floor(srcH*0.30);
    cropH = Math.floor(srcH*0.55);
  }

  const maxW = 1700;
  const scale = Math.min(1, maxW / cropW);
  const outW = Math.max(900, Math.floor(cropW*scale));
  const outH = Math.max(520, Math.floor(cropH*scale));

  const c = document.createElement("canvas");
  c.width = outW; c.height = outH;
  const ctx = c.getContext("2d", {willReadFrequently:true});
  ctx.fillStyle = "#fff";
  ctx.fillRect(0,0,outW,outH);
  ctx.drawImage(bitmap, cropX,cropY,cropW,cropH, 0,0,outW,outH);

  const img = ctx.getImageData(0,0,outW,outH);
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
    g = (g-avg)*1.65 + avg; // contraste
    const v = (g < thr) ? 0 : 255;
    d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);

  return c.toDataURL("image/png");
}

function extractDigitRuns(text){
  const s = String(text||"");
  const runs = (s.match(/\d+/g) || []).map(x=>x.trim()).filter(x=>x.length>=MIN_TRACK);
  const uniq = [];
  const seen = new Set();
  for(const r of runs){
    const v = sanitizeDigitsOnly(r);
    if(v.length>=MIN_TRACK && !seen.has(v)){
      seen.add(v); uniq.push(v);
    }
  }
  // prioriza largos
  uniq.sort((a,b)=>b.length - a.length);
  return uniq.slice(0,10);
}

async function runOcr(){
  if(!trackPhotoFile){
    setStatus("bad","Primero toma o elige una foto del tracking.");
    return;
  }

  try{
    const w = await ensureWorker();
    setStatus("ok","OCR corriendo…");

    // Solo dígitos
    await w.setParameters({
      tessedit_char_whitelist: "0123456789",
      preserve_interword_spaces: "1"
    });

    const bm = await createBitmap(trackPhotoFile);

    // Mejor para líneas: PSM 7 y recorte band
    const band = preprocess(bm, "band");
    $("ocrProgress").textContent = "OCR (banda)…";
    await w.setParameters({ tessedit_pageseg_mode: "7" });
    const r1 = await w.recognize(band);
    let cands = extractDigitRuns(r1?.data?.text);

    // fallback: full + PSM 6
    if(!cands.length){
      const full = preprocess(bm, "full");
      $("ocrProgress").textContent = "OCR (full)…";
      await w.setParameters({ tessedit_pageseg_mode: "6" });
      const r2 = await w.recognize(full);
      cands = extractDigitRuns(r2?.data?.text);
    }

    // fallback extra: sparse text PSM 11
    if(!cands.length){
      const full = preprocess(bm, "full");
      $("ocrProgress").textContent = "OCR (extra)…";
      await w.setParameters({ tessedit_pageseg_mode: "11" });
      const r3 = await w.recognize(full);
      cands = extractDigitRuns(r3?.data?.text);
    }

    if(!cands.length){
      setCandidates([]);
      $("ocrProgress").textContent = "No detectado.";
      setStatus("bad","No detecté tracking. Toma foto más cerca y con buena luz.");
      return;
    }

    setCandidates(cands);
    const best = cands[0];
    $("tracking").value = best;
    current.tracking = best;
    persist();
    renderItems();
    $("ocrProgress").textContent = `Detectado: ${best} (${best.length} dígitos)`;
    setStatus("ok","✅ Tracking capturado automáticamente.");
  }catch(e){
    console.error(e);
    $("ocrProgress").textContent = "Error OCR.";
    setStatus("bad","OCR falló. Abre en Chrome normal y prueba otra foto.");
  }
}

/* ========= Productos + Fotos ========= */
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
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "Aún no hay productos.";
    list.appendChild(div);
  }else{
    current.items.forEach((it, idx)=>{
      const row = document.createElement("div");
      row.className = "item";

      const th = document.createElement("div");
      th.className = "thumb";
      if(it.photo){
        const img = document.createElement("img");
        img.src = it.photo;
        th.appendChild(img);
      }else{
        const p = document.createElement("div");
        p.className = "noimg";
        p.textContent = "Sin foto";
        th.appendChild(p);
      }

      const meta = document.createElement("div");
      meta.className = "meta";

      const top = document.createElement("div");
      top.className = "metaTop";

      const info = document.createElement("div");
      const st = document.createElement("strong");
      st.textContent = `${idx+1}) ${it.qty} / ${it.product}`;
      const sm = document.createElement("small");
      sm.textContent = `Tracking: ${current.tracking || "(vacío)"}`;
      info.appendChild(st);
      info.appendChild(sm);

      const btns = document.createElement("div");
      btns.className = "miniBtns";
      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "Eliminar";
      del.onclick = ()=>{
        current.items.splice(idx,1);
        persist();
        renderItems();
      };
      btns.appendChild(del);

      top.appendChild(info);
      top.appendChild(btns);
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
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "Sin historial aún.";
    wrap.appendChild(div);
    return;
  }

  store.history.forEach((h)=>{
    const item = document.createElement("div");
    item.className = "historyItem";

    const top = document.createElement("div");
    top.className = "historyTop";

    const left = document.createElement("div");
    const st = document.createElement("strong");
    st.textContent = `Tracking: ${h.tracking || "(sin tracking)"}`;
    const units = h.items.reduce((a,b)=>a+(Number(b.qty)||0),0);
    const sm = document.createElement("small");
    sm.textContent = `${h.date} · ${h.items.length} productos · ${units} unidades`;
    left.appendChild(st);
    left.appendChild(sm);

    const act = document.createElement("div");
    act.className = "historyActions";

    const open = document.createElement("button");
    open.className = "btn secondary";
    open.textContent = "Abrir";
    open.onclick = ()=>{
      current = JSON.parse(JSON.stringify(h));
      $("tracking").value = current.tracking || "";
      $("date").value = current.date || nowStamp();
      pendingPhoto = null;
      renderPending();
      trackPhotoFile = null;
      trackPhotoDataUrl = "";
      showTrackPreview(false);
      setCandidates([]);
      $("btnOcr").disabled = true;
      $("btnRemoveTrackPhoto").disabled = true;
      renderItems();
      setStatus("ok","Carga cargada del historial.");
    };

    const del = document.createElement("button");
    del.className = "btn danger";
    del.textContent = "Eliminar";
    del.onclick = ()=>{
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

/* ========= WhatsApp flow ========= */
function buildText(){
  const lines = [];
  lines.push("📦 Carga registrada");
  lines.push(`Tracking: ${current.tracking || "(sin tracking)"}`);
  lines.push(`Fecha: ${current.date}`);
  lines.push("");
  current.items.forEach((it, i)=>{
    lines.push(`${i+1}) ${it.qty} / ${it.product}`);
  });
  const totalUnits = current.items.reduce((a,b)=>a+(Number(b.qty)||0),0);
  lines.push("");
  lines.push(`✅ Total unidades: ${totalUnits}`);
  lines.push(`🧾 Total productos: ${current.items.length}`);
  return lines.join("\n");
}

async function sendImagesThenText(){
  if(!current.items.length){
    setStatus("bad","No hay productos.");
    return;
  }
  // comparte una por una (más compatible que tratar múltiples)
  if(!navigator.share){
    setStatus("bad","Tu navegador no soporta compartir fotos. Usa Chrome actualizado.");
    return;
  }

  setStatus("ok","Compartiendo fotos… (una por una)");
  for(let i=0;i<current.items.length;i++){
    const it = current.items[i];
    if(!it.photo) continue;

    try{
      const file = await dataUrlToFile(it.photo, `foto_${i+1}.jpg`);
      // compartir SOLO archivo (WhatsApp decide)
      await navigator.share({ files:[file] });
    }catch(e){
      // si el usuario cancela, paramos para no molestar
      setStatus("bad","Compartir cancelado. Puedes continuar cuando quieras.");
      return;
    }
  }
  setStatus("ok","Fotos compartidas. Ahora envía el texto por WhatsApp.");
}

function sendText(){
  if(!current.tracking || !current.items.length){
    setStatus("bad","Falta tracking o productos.");
    return;
  }
  persist();
  openWhatsAppText(buildText());
}

/* ========= Events ========= */
function reset(){
  current = {
    id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()),
    date: nowStamp(),
    tracking: "",
    items: []
  };
  $("tracking").value = "";
  $("date").value = current.date;
  pendingPhoto = null;
  renderPending();
  trackPhotoFile = null;
  trackPhotoDataUrl = "";
  showTrackPreview(false);
  setCandidates([]);
  $("btnOcr").disabled = true;
  $("btnRemoveTrackPhoto").disabled = true;
  renderItems();
  setStatus("ok","Nueva carga lista.");
}

function init(){
  $("date").value = current.date;

  $("tracking").addEventListener("input", (e)=>{
    current.tracking = sanitizeDigitsOnly(e.target.value);
    e.target.value = current.tracking;
    persist();
    renderItems();
  });

  $("btnNew").addEventListener("click", ()=>{ persist(); reset(); });
  $("btnClear").addEventListener("click", ()=>{
    if(!confirm("¿Borrar TODO el historial?")) return;
    store = {history:[]};
    saveStore(store);
    reset();
    renderHistory();
    setStatus("ok","Historial borrado.");
  });

  // Tracking photo input
  $("btnTrackCam").addEventListener("click", ()=> $("trackCamInput").click());
  $("btnTrackPick").addEventListener("click", ()=> $("trackPickInput").click());

  function handleTrackFile(file){
    if(!file) return;
    trackPhotoFile = file;

    const r = new FileReader();
    r.onload = ()=>{
      trackPhotoDataUrl = r.result;
      showTrackPreview(true);
      $("ocrProgress").textContent = "Foto cargada. Iniciando OCR…";
      $("btnOcr").disabled = false;
      $("btnRemoveTrackPhoto").disabled = false;

      // OCR automático
      setTimeout(runOcr, 120);
    };
    r.readAsDataURL(file);
  }

  $("trackCamInput").addEventListener("change",(e)=>{
    const f = e.target.files?.[0];
    e.target.value="";
    handleTrackFile(f);
  });
  $("trackPickInput").addEventListener("change",(e)=>{
    const f = e.target.files?.[0];
    e.target.value="";
    handleTrackFile(f);
  });

  $("btnOcr").addEventListener("click", runOcr);

  $("btnRemoveTrackPhoto").addEventListener("click", ()=>{
    trackPhotoFile = null;
    trackPhotoDataUrl = "";
    showTrackPreview(false);
    setCandidates([]);
    $("btnOcr").disabled = true;
    $("btnRemoveTrackPhoto").disabled = true;
    $("ocrProgress").textContent = "Lista para OCR.";
    setStatus("ok","Foto de tracking removida.");
  });

  // Product photo
  $("btnProdCam").addEventListener("click", ()=> $("prodCamInput").click());
  $("btnProdPick").addEventListener("click", ()=> $("prodPickInput").click());

  function handleProdFile(file){
    if(!file) return;
    const r = new FileReader();
    r.onload = ()=>{
      pendingPhoto = r.result;
      renderPending();
      setStatus("ok","Foto de producto lista ✅");
    };
    r.readAsDataURL(file);
  }

  $("prodCamInput").addEventListener("change",(e)=>{
    const f = e.target.files?.[0];
    e.target.value="";
    handleProdFile(f);
  });
  $("prodPickInput").addEventListener("change",(e)=>{
    const f = e.target.files?.[0];
    e.target.value="";
    handleProdFile(f);
  });

  $("btnRemovePending").addEventListener("click", ()=>{
    pendingPhoto = null;
    renderPending();
    setStatus("ok","Foto pendiente removida.");
  });

  $("btnAdd").addEventListener("click", ()=>{
    const product = $("product").value.trim();
    const qty = Number($("qty").value);

    if(!current.tracking){
      setStatus("bad","No hay tracking. Toma foto del tracking y espera el OCR (o escribe).");
      return;
    }
    if(!product){ setStatus("bad","Escribe el producto."); return; }
    if(!qty || qty<1){ setStatus("bad","Unidades inválidas."); return; }
    if(!pendingPhoto){ setStatus("bad","Falta la foto del producto."); return; }

    current.items.push({product, qty: Math.floor(qty), photo: pendingPhoto});
    $("product").value="";
    $("qty").value="";
    pendingPhoto = null;
    renderPending();

    persist();
    renderItems();
    setStatus("ok","Producto agregado ✅");
  });

  $("btnWAImages").addEventListener("click", sendImagesThenText);
  $("btnWAText").addEventListener("click", sendText);

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

  renderPending();
  renderItems();
  renderHistory();

  // debug OCR
  if(window.Tesseract){
    $("ocrDebug").textContent = "OCR: Tesseract cargado ✅";
  }else{
    $("ocrDebug").textContent = "OCR: ❌ No cargó. Abre en Chrome + internet.";
  }

  setStatus("ok","Listo.");
}

init();
