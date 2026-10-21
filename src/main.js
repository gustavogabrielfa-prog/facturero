import "./style.css";
import { sb, configOk, fetchAll, errorMsg } from "./supabase.js";
import {
  esc, fmtMoney, fmtDate, todayISO, weekRange, monthRange, yearRange,
  IMPUESTOS, computeTotals, groupBy, groupByPeriod, periodLabel,
  periodKey, periodKeysBetween, periodShort, fmtCompact, parseMonto, formatMontoTexto, montoTexto, numeroNorm, signo,
} from "./format.js";
import { generarReportePDF, generarReporteExcel, generarInformeArca, generarInformeVentasPDF, generarInformeVentasExcel, generarComparativoPDF, generarComparativoExcel, generarResultadosPDF, generarResultadosExcel } from "./pdf.js";
import { leerArchivoArca, compararArca, rangoArca } from "./arca.js";
import { leerLibroVentas, puntosDeVenta, resumenVentas, filasParaGuardar, resumenGuardado, compararVentasCompras } from "./ventas.js";
import { descargarTodo } from "./exportar.js";
import { estadoResultados, mesesEntre, mesMas, mesLabel, finDeMes } from "./resultados.js";

/* ---------- STATE ---------- */
const state = {
  session: null,
  perfil: null,        // { id, email, nombre, rol, sucursal_id }
  sucursales: [],
  proveedores: [],
  tributos: [],        // otros tributos y tasas (lista editable por el admin)
  booting: true,
  bootError: "",
};
let route = location.hash.replace("#", "") || "subir";
let draft = null;
let editId = null;           // id del comprobante que el admin está corrigiendo (null = alta nueva)
let ultimoProveedorId = "";   // queda elegido hasta que lo cambien o se cierre la app
let ultimaFecha = "";         // ídem con la fecha: al cerrar o actualizar vuelve a la del día
let showNewProv = false;
let saving = false;
let loginError = "";

// Listado (solo admin)
let [desde, hasta] = monthRange();
let comprobantes = [];
let listLoaded = false;
let listLoading = false;
let sucursalFilter = "todas";
let listFilter = "todos";
let periodGranularity = "mes";

// Historial del día (Subir): lo que cargó este usuario hoy
let hoy = [];
let hoyLoaded = false;
let hoyDia = todayISO();   // si cambia (pasó la medianoche), se vacía
let provFilter = "todos";
let busqueda = "";          // N° de comprobante, proveedor o importe a buscar (en todas las fechas)
let busqResultados = null;  // null = buscando
let busqSeq = 0, busqTimer = null;
let dupSeq = 0, dupTimer = null;
let dupGrupos = null;       // revisión de duplicados ya cargados (admin): null = sin revisar
let dupBuscando = false;

// Compara ARCA (admin): filas del archivo, resultado y comprobantes usados en la comparación
let arcaFilas = null, arcaArchivo = "", arcaRes = null, arcaComps = [], arcaCargando = false, arcaError = "";
// Ventas: libro de IVA ventas leído en el navegador (no se guarda) y qué punto de venta es blanco o negro
let ventasLibro = null, ventasArchivo = "", ventasCargando = false, ventasError = "", ventasSucursal = "";
let ventasPV = {};   // { "0006": "blanco", "0099": "negro" }, se vuelve a preguntar con cada PDF
let ventasGuardando = false;
// Sucursal detectada por los puntos de venta ya guardados: { id, pv } | { varias: [ids] } | null
let ventasDetectada = null;
let ventasManual = { sucursal: "", fecha: todayISO(), blanco: "", negro: "", iva: "", guardando: false };
let ventasHist = { desde: monthRange()[0], hasta: monthRange()[1], suc: "todas", rows: null, cargando: false, error: "" };
// Estado de resultados (admin): período en meses y sucursal; grilla de gastos operativos de un año
const mesActual = () => todayISO().slice(0, 7);
let er = { desde: mesActual().slice(0, 4) + "-01", hasta: mesActual(), suc: "todas", sinIva: false, datos: null, cargando: false, error: "" };
let gx = { vista: "mes", mes: mesActual(), año: new Date().getFullYear(), suc: null, conceptos: null, rows: null, cargando: false, error: "", editarLista: false };
let provNuevoPendiente = null;   // { nombre, cuit } para precargar "+ Nuevo" al cargar desde ARCA
let chartGran = null;   // null = automático según el rango de fechas
let chartData = null;   // columnas del gráfico, para el tooltip
let chartVer = "tipo";  // "tipo" = Facturado / No facturado; "sucursal" = aporte de cada sucursal (admin, todas)

const esAdmin = () => state.perfil?.rol === "admin";
const esGerente = () => state.perfil?.rol === "gerente";
const veListado = () => esAdmin() || esGerente();   // gerente: solo su sucursal (lo aplica RLS)
const puedeCorregir = () => esAdmin() || esGerente();   // corregir / eliminar (gerente: solo su sucursal, lo aplica RLS)
const sucursalNombre = (id) => state.sucursales.find((s) => s.id === id)?.nombre || "Sin sucursal";
/** Etiqueta de sucursal con un color fijo por sucursal (según su orden), para distinguirlas de un vistazo. */
const sucColor = (id) => `suc-c${Math.max(0, state.sucursales.findIndex((s) => s.id === id)) % 6}`;
const sucursalTag = (id) => `<span class="suc-tag ${sucColor(id)}">${esc(sucursalNombre(id))}</span>`;
const proveedorNombre = (id) => state.proveedores.find((p) => p.id === id)?.nombre || "Proveedor sin datos";
const tributoNombre = (id) => state.tributos.find((t) => t.id === id)?.nombre || "Tributo eliminado";
const tributosActivos = () => state.tributos.filter((t) => t.activo);
const sumTributos = (c) => Object.values(c.tributos || {}).reduce((a, v) => a + (Number(v) || 0), 0);

/* ---------- DATA ---------- */
async function loadBase() {
  const [perfil, sucursales, proveedores] = await Promise.all([
    sb.from("perfiles").select("*").eq("id", state.session.user.id).maybeSingle(),
    sb.from("sucursales").select("*").order("nombre"),
    fetchAll(() => sb.from("proveedores").select("*").order("nombre")),
  ]);
  if (perfil.error) throw perfil.error;
  if (sucursales.error) throw sucursales.error;
  state.perfil = perfil.data;
  state.sucursales = sucursales.data;
  state.proveedores = proveedores;
  await loadTributos();
}

/** Si la tabla todavía no existe (falta correr el SQL 004), la app sigue funcionando sin tributos. */
async function loadTributos() {
  const { data, error } = await sb.from("tributos").select("*").order("orden").order("nombre");
  state.tributos = error ? [] : data;
}

let loadSeq = 0;
async function loadComprobantes({ silent = false } = {}) {
  const seq = ++loadSeq;           // solo se aplica la respuesta del último pedido
  listLoaded = true;               // evita reintentos en bucle si falla
  if (!silent) { listLoading = true; render(); }
  try {
    const rows = await fetchAll(() =>
      sb.from("comprobantes").select("*")
        .gte("fecha", desde).lte("fecha", hasta)
        .order("fecha", { ascending: false }).order("created_at", { ascending: false })
    );
    if (seq === loadSeq) comprobantes = rows;
  } catch (e) {
    if (seq === loadSeq) toast(errorMsg(e));
  } finally {
    if (seq === loadSeq) {
      listLoading = false;
      if (route === "listado") render();
    }
  }
}

/** Importe escrito como "120.500,00", "$ 120500" o "120500.5"; null si no parece un importe. */
function importeBuscado(s) {
  const t = s.replace(/[$\s]/g, "");
  if (!/^\d[\d.,]*$/.test(t)) return null;
  let n;
  if (t.includes(",")) n = Number(t.replace(/\./g, "").replace(",", "."));
  else if (/\.\d{3}(\.|$)/.test(t)) n = Number(t.replace(/\./g, ""));   // puntos de miles
  else n = Number(t);
  if (!isFinite(n) || n <= 0) return null;
  return { n, conDecimales: /[.,]\d{1,2}$/.test(t) && !/\.\d{3}$/.test(t) };
}
const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Busca en todas las fechas por N° de comprobante, nombre de proveedor o importe total. */
async function buscarNumero() {
  // "nota de crédito", "nota", "crédito" o "nc" filtran notas de crédito; lo que quede se busca normal ("nc monroe")
  const NC = /\b(notas?\s+de\s+cr[eé]ditos?|notas?|cr[eé]ditos?|n\.?\s?c\.?)(?=\s|$)/gi;
  const soloNC = NC.test(busqueda); NC.lastIndex = 0;
  const texto = busqueda.replace(NC, " ").replace(/\s+/g, " ").trim();
  const t = texto.replace(/[^\w-]/g, "");
  const seq = ++busqSeq;
  busqResultados = null; renderBusq();
  if (!busqueda.trim()) return;
  if (soloNC && !texto) {
    const { data, error } = await sb.from("comprobantes").select("*")
      .eq("tipo", "NOTA_CREDITO").order("fecha", { ascending: false }).limit(50);
    if (seq !== busqSeq) return;
    if (error) toast(errorMsg(error));
    busqResultados = error ? [] : data;
    renderBusq(); return;
  }
  const cond = [];
  if (t) cond.push(`numero.ilike.*${t}*`);
  const q = sinAcentos(texto);
  if (q.length >= 3) {
    const ids = state.proveedores.filter((p) => sinAcentos(p.nombre).includes(q)).map((p) => p.id);
    if (ids.length) cond.push(`proveedor_id.in.(${ids.join(",")})`);
  }
  const imp = importeBuscado(texto);
  // sin decimales: cualquier importe de ese entero (120500 encuentra 120.500,75)
  if (imp) cond.push(imp.conDecimales ? `monto.eq.${imp.n}` : `and(monto.gte.${Math.floor(imp.n)},monto.lt.${Math.floor(imp.n) + 1})`);
  if (!cond.length) { busqResultados = []; renderBusq(); return; }
  let consulta = sb.from("comprobantes").select("*").or(cond.join(","));
  if (soloNC) consulta = consulta.eq("tipo", "NOTA_CREDITO");
  const { data, error } = await consulta.order("fecha", { ascending: false }).limit(50);
  if (seq !== busqSeq) return;
  if (error) toast(errorMsg(error));
  busqResultados = error ? [] : data;
  renderBusq();
}

function busqHtml() {
  if (!busqueda.trim()) return "";
  if (busqResultados === null) return `<div class="busq-info">Buscando…</div>`;
  const n = busqResultados.length;
  return `<div class="busq-info">${n}${n === 50 ? "+" : ""} resultado${n === 1 ? "" : "s"} en todas las fechas · <button type="button" class="linkbtn" data-limpiar>Limpiar búsqueda</button></div>
  ${n ? tablaComprobantes(busqResultados, { delAttr: "data-delbusq" })
    : `<div class="empty-state panel"><span class="serif">Sin resultados</span>No hay comprobantes que coincidan con la búsqueda.</div>`}`;
}

/** Pinta resultados y oculta el historial normal mientras hay búsqueda. */
function renderBusq() {
  const el = document.getElementById("busqRes");
  if (!el) return;
  el.innerHTML = busqHtml();
  const normal = document.getElementById("histNormal");
  if (normal) normal.hidden = !!busqueda.trim();
  el.querySelectorAll("[data-limpiar]").forEach((b) => b.addEventListener("click", () => {
    busqueda = ""; busqResultados = null; arcaFilas = null; arcaRes = null; arcaComps = []; busqSeq++;
    const inp = document.getElementById("fBusq"); if (inp) inp.value = "";
    renderBusq();
    on("btnDuplicados", "click", buscarDuplicados);
  }));
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => corregirComprobante(b.dataset.edit)));
  el.querySelectorAll("[data-delbusq]").forEach((b) => b.addEventListener("click", async () => {
    if (await eliminarComprobante(b.dataset.delbusq)) render();
  }));
}

/** Comprobantes cargados hoy: admin ve todas las sucursales; gerente y carga, solo la suya (RLS además los limita al día, hora Argentina). */
async function loadHoy() {
  const d = new Date();
  const medianoche = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const seq = hoyDia = todayISO();
  try {
    const rows = await fetchAll(() => {
      let q = sb.from("comprobantes").select("*").gte("created_at", medianoche);
      if (!esAdmin()) q = q.eq("sucursal_id", state.perfil.sucursal_id);
      return q.order("created_at", { ascending: false });
    });
    if (seq !== hoyDia) return;
    hoy = rows; hoyLoaded = true;
    renderHoy();
  } catch (e) { toast(errorMsg(e)); }
}

/** A las 00:00 el historial del día queda vacío. */
let medianocheTimer = null;
function programarMedianoche() {
  clearTimeout(medianocheTimer);
  const d = new Date();
  const proxima = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 5);
  medianocheTimer = setTimeout(() => {
    hoy = []; hoyDia = todayISO(); renderHoy();
    programarMedianoche();
  }, proxima - d);
}

async function loadProveedores() {
  try {
    state.proveedores = await fetchAll(() => sb.from("proveedores").select("*").order("nombre"));
    if (route !== "subir") render(); // en Subir no se re-renderiza para no pisar lo que se está tipeando
  } catch (e) { toast(errorMsg(e)); }
}

/* ---------- TIEMPO REAL ---------- */
let channel = null;
let refreshTimer = null;
function refrescarListado() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (route === "listado") loadComprobantes({ silent: true });
    else listLoaded = false;
    if (route === "subir") loadHoy();
  }, 400);
}
function subscribeRealtime() {
  if (channel) return;
  // Los eventos de comprobantes llegan al admin y a los usuarios de esa sucursal (Realtime respeta RLS)
  channel = sb.channel("facturero-cambios")
    .on("postgres_changes", { event: "*", schema: "public", table: "comprobantes" }, refrescarListado)
    .on("postgres_changes", { event: "*", schema: "public", table: "proveedores" }, loadProveedores)
    .subscribe();
}
function unsubscribeRealtime() {
  if (channel) { sb.removeChannel(channel); channel = null; }
}

async function onSession(session) {
  const prevUser = state.session?.user?.id;
  state.session = session;
  if (!session) {
    bloqueado = false; bloqueoError = "";
    unsubscribeRealtime();
    Object.assign(state, { perfil: null, sucursales: [], proveedores: [], booting: false, bootError: "" });
    comprobantes = []; listLoaded = false; draft = null; editId = null; ultimoProveedorId = ""; ultimaFecha = ""; ventasLibro = null; ventasPV = {}; ventasDetectada = null; ventasSucursal = "";
    ventasHist = { ...ventasHist, rows: null, todas: null, compras: null, error: "" }; ventasManual = { ...ventasManual, sucursal: "", blanco: "", negro: "", iva: "" };
    busqueda = ""; busqResultados = null; arcaFilas = null; arcaRes = null; arcaComps = [];
    hoy = []; hoyLoaded = false; clearTimeout(medianocheTimer);
    render(); return;
  }
  if (prevUser === session.user.id && state.perfil) return; // refresh de token
  state.booting = true; state.bootError = ""; render();
  try { await loadBase(); subscribeRealtime(); programarMedianoche(); }
  catch (e) { state.bootError = errorMsg(e); }
  state.booting = false;
  // recién logueado: arranca a contar; sesión recuperada (recarga): se respeta lo que pasó
  if (prevUser === undefined && leerActividad()) { ultimaActividad = 0; revisarInactividad(); }
  actividadLista = true;
  if (!bloqueado) { ultimaGrabada = 0; marcarActividad(); }
  render();
}

/* ---------- RENDER ---------- */
function render() {
  const app = document.getElementById("app");
  document.body.dataset.mode = "";

  if (!configOk) { app.innerHTML = shell(pageNoConfig(), false); return; }
  if (state.booting) { app.innerHTML = shell(`<div class="loading">Cargando…</div>`, false); return; }
  if (!state.session) { app.innerHTML = shell(pageLogin(), false); wireLogin(); return; }
  if (state.bootError) { app.innerHTML = shell(pageError(state.bootError), true); wireShell(); return; }
  if (!state.perfil || (!esAdmin() && !state.perfil.sucursal_id)) {
    app.innerHTML = shell(pageSinSucursal(), true); wireShell(); return;
  }
  if (bloqueado) {
    if (!document.getElementById("bloqueoForm")) { app.innerHTML = shell(pageBloqueo(), false); wireBloqueo(); }
    return;
  }

  if (route === "listado" && !veListado()) route = "subir";
  if (route === "arca" && !esAdmin()) route = "subir";
  if (route === "ventas" && !veListado()) route = "subir";
  if (route === "resultados" && !veListado()) route = "subir";
  let body;
  if (route === "listado") body = pageListado();
  else if (route === "arca") body = pageArca();
  else if (route === "ventas") body = pageVentas();
  else if (route === "resultados") body = pageResultados();
  else if (route === "proveedores") body = pageProveedores();
  else { route = "subir"; body = pageSubir(); }

  document.body.dataset.mode = route === "subir" && draft ? (draft.tipo === "NOTA_CREDITO" ? "NOTA_CREDITO" : draft.grupo) : "";
  app.innerHTML = shell(body, true, true);
  const piv = app.querySelector(".pivote");
  if (piv) document.documentElement.style.setProperty("--piv-h", piv.offsetHeight + "px");
  wireShell();
  wirePage();

  if (route === "listado" && !listLoaded && !listLoading) loadComprobantes();
  if (route === "subir") { if (hoyLoaded) renderHoy(); else loadHoy(); }
  if (route === "ventas" && ventasHist.rows === null && !ventasHist.cargando && !ventasHist.error) cargarHistVentas();
  if (route === "resultados") {
    if (er.datos === null && !er.cargando && !er.error) cargarResultados();
    if (gx.rows === null && !gx.cargando && !gx.error) cargarGastos();
  }
}

function shell(bodyHtml, logged, tabs = false) {
  const badge = logged && state.perfil
    ? esAdmin() ? "Administrador"
      : esGerente() ? "Gerente · " + sucursalNombre(state.perfil.sucursal_id)
      : sucursalNombre(state.perfil.sucursal_id)
    : "";
  return `
  <div class="wrap${logged && (route === "listado" || route === "subir" || route === "proveedores" || route === "arca" || route === "ventas" || route === "resultados") ? " ancho ruta-" + route : ""}">
    <div class="pivote">
    <header class="top">
      <div class="brand"><div class="brand-mark">F</div><div class="brand-name">Facturero</div></div>
      ${logged ? `<div class="top-right">
        ${badge ? `<div class="suc-badge">${esc(badge)}</div>` : ""}
        <button class="linkbtn" id="btnLogout">Salir</button>
      </div>` : ""}
    </header>
    ${tabs ? `<div class="tabs">
      <button data-route="subir" class="${route === "subir" ? "active" : ""}">＋ Subir</button>
      <button data-route="proveedores" class="${route === "proveedores" ? "active" : ""}">🏷 Proveedores</button>
      ${veListado() ? `<button data-route="listado" class="${route === "listado" ? "active" : ""}">🗂 Listado</button>` : ""}
      ${esAdmin() ? `<button data-route="arca" class="${route === "arca" ? "active" : ""}">🧾 Compara ARCA</button>` : ""}
      ${veListado() ? `<button data-route="ventas" class="${route === "ventas" ? "active" : ""}">💵 Ventas</button>` : ""}
      ${veListado() ? `<button data-route="resultados" class="${route === "resultados" ? "active" : ""}">📈 Resultados</button>` : ""}
    </div>` : ""}
    </div>
    ${bodyHtml}
    <footer class="app-footer">Los datos se guardan en la nube (Supabase) y se comparten entre sucursales.</footer>
  </div>`;
}

let toastTimer = null;
function toast(msg) {
  clearTimeout(toastTimer);
  let t = document.getElementById("toastEl");
  if (!t) { t = document.createElement("div"); t.id = "toastEl"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = "block";
  toastTimer = setTimeout(() => { t.style.display = "none"; }, 2800);
}

/** Confirmación propia (los confirm/prompt del navegador no se muestran en algunos navegadores integrados).
 *  Sin `valor`: resuelve true/false. Con `valor`: muestra un campo y resuelve el texto, o null si se cancela. */
function dialogo(mensaje, { aceptar = "Aceptar", peligro = false, valor } = {}) {
  return new Promise((resolve) => {
    const conInput = valor !== undefined;
    const fondo = document.createElement("div");
    fondo.className = "dlg-fondo";
    fondo.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">
      <p>${esc(mensaje)}</p>
      ${conInput ? `<input type="text" class="dlg-input" value="${esc(valor)}">` : ""}
      <div class="dlg-acc">
        <button class="btn secondary small" data-r="no">Cancelar</button>
        <button class="btn small${peligro ? " danger" : ""}" data-r="si">${esc(aceptar)}</button>
      </div></div>`;
    document.body.appendChild(fondo);
    const inp = fondo.querySelector(".dlg-input");
    const cerrar = (ok) => {
      fondo.remove(); document.removeEventListener("keydown", tecla);
      resolve(conInput ? (ok ? inp.value : null) : ok);
    };
    const tecla = (e) => { if (e.key === "Escape") cerrar(false); if (e.key === "Enter") cerrar(true); };
    document.addEventListener("keydown", tecla);
    fondo.addEventListener("click", (e) => { if (e.target === fondo) cerrar(false); });
    fondo.querySelector("[data-r=no]").addEventListener("click", () => cerrar(false));
    fondo.querySelector("[data-r=si]").addEventListener("click", () => cerrar(true));
    (inp || fondo.querySelector("[data-r=si]")).focus();
    inp?.select();
  });
}

/* ---------- SECCIONES PLEGABLES: arrancan cerradas y se acuerdan de cuáles dejaste abiertas (en esta computadora) ---------- */
const CLAVE_ABIERTOS = "facturero_secciones_abiertas";
let abiertos = (() => { try { return JSON.parse(localStorage.getItem(CLAVE_ABIERTOS)) || {}; } catch { return {}; } })();

/** Bloque que se despliega al tocar el título. `resumen` se ve aun cerrado (ej.: el total). */
function plegable(id, titulo, contenido, { resumen = "", abierto = false, clase = "" } = {}) {
  if (!contenido || !String(contenido).trim()) return "";
  return `<details class="pleg ${clase}" data-pleg="${id}"${abierto || abiertos[id] ? " open" : ""}>
    <summary><span class="pleg-t">${titulo}</span>${resumen ? `<span class="pleg-r">${resumen}</span>` : ""}</summary>
    <div class="pleg-body">${contenido}</div>
  </details>`;
}
/** Explicación plegada ("ⓘ Cómo funciona"). */
const info = (id, html, titulo = "ⓘ Cómo funciona") => plegable(id, titulo, `<div class="hint" style="margin:0;">${html}</div>`, { clase: "pleg-info" });

function wirePlegables(root = document) {
  root.querySelectorAll("details[data-pleg]").forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) abiertos[d.dataset.pleg] = true; else delete abiertos[d.dataset.pleg];
    try { localStorage.setItem(CLAVE_ABIERTOS, JSON.stringify(abiertos)); } catch { /* sin almacenamiento: solo no se recuerda */ }
  }));
}

/* ---------- PÁGINAS SIMPLES ---------- */
function pageNoConfig() {
  return `<div class="lock-wrap">
    <div class="brand-mark">⚙️</div>
    <h1 class="serif">Falta configurar Supabase</h1>
    <p>Completá <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code> en el archivo <code>.env</code> y reiniciá <code>npm run dev</code>.</p>
  </div>`;
}

function pageLogin() {
  return `<div class="lock-wrap">
    <div class="brand-mark">🔒</div>
    <h1 class="serif">Ingresar</h1>
    <p>Usá el usuario de tu sucursal o el de administrador.</p>
    <form id="loginForm">
      <div class="field" style="text-align:left;"><label>Email</label><input type="email" id="loginEmail" autocomplete="username" required></div>
      <div class="field" style="text-align:left;"><label>Contraseña</label><input type="password" id="loginPass" autocomplete="current-password" required></div>
      <div class="lock-error ${loginError ? "show" : ""}">${esc(loginError)}</div>
      <button class="btn" type="submit" id="btnLogin">Entrar</button>
    </form>
  </div>`;
}

/* ---------- BLOQUEO POR INACTIVIDAD (administrador y gerentes) ---------- */
const MINUTOS_INACTIVIDAD = 10;
const CLAVE_ACTIVIDAD = "facturero_ultima_actividad";   // compartida entre pestañas: cerrar / recargar no saltea el bloqueo
let bloqueado = false, bloqueoError = "";
let ultimaActividad = Date.now(), ultimaGrabada = 0;
let actividadLista = false;   // hasta revisar la sesión recuperada, mover el mouse no cuenta (no se saltea el bloqueo recargando)
const usaBloqueo = () => esAdmin() || esGerente();
const leerActividad = () => { try { return Number(localStorage.getItem(CLAVE_ACTIVIDAD)) || 0; } catch { return 0; } };

function marcarActividad() {
  if (bloqueado || !actividadLista) return;
  ultimaActividad = Date.now();
  if (ultimaActividad - ultimaGrabada > 15000) {   // no escribir en cada movimiento del mouse
    ultimaGrabada = ultimaActividad;
    try { localStorage.setItem(CLAVE_ACTIVIDAD, String(ultimaActividad)); } catch { /* sin almacenamiento: vale solo esta pestaña */ }
  }
}

/** Bloquea si pasó el tiempo sin uso (en esta pestaña o en otra del mismo navegador). */
function revisarInactividad() {
  if (bloqueado || !state.session || !state.perfil || !usaBloqueo()) return;
  const ultima = Math.max(ultimaActividad, leerActividad());
  if (Date.now() - ultima >= MINUTOS_INACTIVIDAD * 60000) bloquear();
}

function bloquear() {
  syncDraft();   // lo que se estaba cargando queda guardado en memoria
  bloqueado = true; bloqueoError = "";
  document.querySelectorAll(".dlg-fondo").forEach((d) => d.remove());
  render();
}

function pageBloqueo() {
  return `<div class="lock-wrap">
    <div class="brand-mark">🔒</div>
    <h1 class="serif">Sesión bloqueada</h1>
    <p>Por seguridad se bloqueó después de ${MINUTOS_INACTIVIDAD} minutos sin uso. Ingresá tu contraseña para seguir.</p>
    <form id="bloqueoForm">
      <div class="field" style="text-align:left;"><label>Usuario</label><input type="email" value="${esc(state.session.user.email)}" autocomplete="username" readonly></div>
      <div class="field" style="text-align:left;"><label>Contraseña</label><input type="password" id="bloqueoPass" autocomplete="current-password" required autofocus></div>
      <div class="lock-error ${bloqueoError ? "show" : ""}">${esc(bloqueoError)}</div>
      <button class="btn" type="submit" id="btnDesbloquear">Desbloquear</button>
    </form>
    <button class="linkbtn" id="btnBloqueoSalir" style="margin-top:14px;">Salir y entrar con otro usuario</button>
  </div>`;
}

function wireBloqueo() {
  document.getElementById("bloqueoPass")?.focus();
  on("bloqueoForm", "submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("btnDesbloquear"); btn.disabled = true; btn.textContent = "Verificando…";
    const { error } = await sb.auth.signInWithPassword({ email: state.session.user.email, password: document.getElementById("bloqueoPass").value });
    if (error) {
      const el = document.querySelector("#bloqueoForm .lock-error");
      if (el) { el.textContent = error.message === "Invalid login credentials" ? "Contraseña incorrecta." : errorMsg(error); el.classList.add("show"); }
      btn.disabled = false; btn.textContent = "Desbloquear";
      const pass = document.getElementById("bloqueoPass"); pass.value = ""; pass.focus();
      return;
    }
    bloqueado = false; bloqueoError = ""; ultimaGrabada = 0; marcarActividad();
    render();
  });
  on("btnBloqueoSalir", "click", async () => { bloqueado = false; await sb.auth.signOut(); location.hash = ""; });
}

for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"]) window.addEventListener(ev, marcarActividad, { passive: true });
setInterval(revisarInactividad, 20000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") revisarInactividad(); });

function pageSinSucursal() {
  return `<div class="lock-wrap">
    <div class="brand-mark">🏢</div>
    <h1 class="serif">Usuario sin sucursal</h1>
    <p>Tu usuario (${esc(state.session.user.email)}) todavía no tiene una sucursal asignada. Pedile al administrador que te la asigne en Supabase.</p>
  </div>`;
}

function pageError(msg) {
  return `<div class="lock-wrap">
    <div class="brand-mark">⚠️</div>
    <h1 class="serif">No se pudieron cargar los datos</h1>
    <p>${esc(msg)}</p>
    <button class="btn" id="btnRetry">Reintentar</button>
  </div>`;
}

/* ---------- SUBIR ---------- */
function newDraft() {
  return {
    grupo: "FACTURADO",
    sucursalId: state.perfil.sucursal_id || state.sucursales[0]?.id || "",
    proveedorId: state.proveedores.some((p) => p.id === ultimoProveedorId) ? ultimoProveedorId : state.proveedores[0]?.id || "",
    tipo: "FACTURA", facturaRef: "",
    fecha: ultimaFecha || todayISO(), numero: "", monto: "",
    iva21: "", iva105: "", iva27: "", iva5: "", iva25: "", iibb: "", notas: "", tributos: {},
  };
}

function pageSubir() {
  if (!draft) draft = newDraft();
  const d = draft;
  const ivaField = (k, label) => `<div class="field"><label>${label}</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" id="f_${k}" value="${esc(d[k])}" placeholder="0"></div>`;
  return `
  <div class="pagehead">${editId
    ? `<h1 class="serif">Corregir comprobante</h1><p>Cambiá lo que haga falta y guardá. El comprobante se actualiza, no se duplica.</p>`
    : `<h1 class="serif">Subir comprobante</h1><p>Cargá los datos del comprobante — sin adjuntar archivos.</p>`}</div>

  <div class="trip trip3">
  <section class="trip-col fija">
  <div class="trip-h">1 · Comprobante</div>
  <div class="badge-group" id="grupoToggle">
    <button data-grupo="FACTURADO" class="${d.grupo === "FACTURADO" ? "active fact" : ""}">Facturado</button>
    <button data-grupo="NO_FACTURADO" class="${d.grupo === "NO_FACTURADO" ? "active nofact" : ""}">No facturado</button>
  </div>


  ${esAdmin() ? `<div class="field"><label>Sucursal</label>
    <select id="f_sucursal">${state.sucursales.map((s) => `<option value="${s.id}" ${d.sucursalId === s.id ? "selected" : ""}>${esc(s.nombre)}</option>`).join("")}</select>
  </div>` : ""}

  <div class="field">
    <label>Proveedor</label>
    <div class="provrow">
      <select id="f_proveedor">
        ${state.proveedores.length
          ? state.proveedores.map((p) => `<option value="${p.id}" ${d.proveedorId === p.id ? "selected" : ""}>${esc(p.nombre)}</option>`).join("")
          : `<option value="">Sin proveedores todavía</option>`}
      </select>
      <button id="btnNuevoProv" type="button">+ Nuevo</button>
    </div>
    ${showNewProv ? `
    <div class="newprov">
      <div class="row2">
        <div class="field" style="margin-bottom:0;"><label>Nombre del proveedor</label><input type="text" id="np_nombre" placeholder="Ej: Droguería..."></div>
        <div class="field" style="margin-bottom:0;"><label>CUIT</label><input type="text" id="np_cuit" class="cuit" inputmode="numeric" autocomplete="off" maxlength="13" placeholder="30-12345678-9"></div>
      </div>
      <div class="newprov-actions">
        <button class="btn small" id="btnGuardarProv">Guardar proveedor</button>
        <button class="btn secondary small" id="btnCancelarProv">Cancelar</button>
      </div>
    </div>` : ""}
  </div>

  <label class="nc-check${d.tipo === "NOTA_CREDITO" ? " on" : ""}"><input type="checkbox" id="f_nc" ${d.tipo === "NOTA_CREDITO" ? "checked" : ""}> Es nota de crédito de este proveedor</label>
  ${d.tipo === "NOTA_CREDITO" ? `<div class="nc-aviso">Cargá los importes en positivo: la app los <b>resta</b> de los totales.</div>` : ""}

  <div class="row2">
    <div class="field"><label>Fecha</label><input type="date" id="f_fecha" value="${esc(d.fecha)}" max="${todayISO()}"></div>
    <div class="field"><label>Número de comprobante *</label><input type="text" id="f_numero" value="${esc(d.numero)}" placeholder="0001-00012345"><div id="dupAviso"></div></div>
  </div>
  ${d.tipo === "NOTA_CREDITO" ? `<div class="field"><label>Factura que afecta (opcional)</label><input type="text" id="f_facturaRef" value="${esc(d.facturaRef)}" placeholder="0001-00012345"></div>` : ""}
  <div class="field"><label>Monto total *</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" id="f_monto" value="${esc(d.monto)}" placeholder="0"></div>
  </section>

  <section class="trip-col fija">
  <div class="trip-h">2 · Impuestos y guardar</div>
  <div class="section-label primera">IVA por alícuota — dejá en 0 la que no aplique (ej. medicamento exento)</div>
  <div class="grid-campos">${ivaField("iva21", "IVA 21%")}${ivaField("iva105", "IVA 10,5%")}${ivaField("iva27", "IVA 27%")}${ivaField("iva5", "IVA 5%")}${ivaField("iva25", "IVA 2,5%")}</div>

  <div class="section-label">Otros impuestos</div>
  <div class="grid-campos">${ivaField("iibb", "IIBB (Misiones)")}${tributosActivos().map((t) => `<div class="field"><label>${esc(t.nombre)}</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" data-trib="${t.id}" value="${esc(d.tributos?.[t.id] ?? "")}" placeholder="0"></div>`).join("")}</div>

  <div class="field"><label>Notas (opcional)</label><textarea id="f_notas" rows="2">${esc(d.notas)}</textarea></div>

  <button class="btn" id="btnGuardar" ${saving ? "disabled" : ""}>${saving ? "Guardando…" : editId ? "Guardar cambios" : "Guardar comprobante"}</button>
  ${editId ? `<button class="btn secondary" id="btnCancelarEdit" style="margin-top:10px;">Cancelar corrección</button>` : ""}
  </section>

  <section class="trip-col">
  <div class="trip-h">3 · Cargados hoy</div>
  <div id="hoyList"><div class="loading">Cargando…</div></div>
  </section>
  </div>
  `;
}

/** Lista simple de comprobantes (total, IVA, IIBB) para revisar de un vistazo; admin y gerente con Corregir / Eliminar. */
function tablaComprobantes(list, { conHora = false, delAttr = "data-del", iconos = false } = {}) {
  const hora = (ts) => new Date(ts).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const iva = (c) => IMPUESTOS.reduce((a, [k]) => a + (Number(c[k]) || 0), 0);
  const $ = (c, v) => fmtMoney(signo(c) * (Number(v) || 0));
  return `<div class="hoy-wrap"><table class="data-table hoy-table">
    <thead><tr><th>Comprobante</th><th>Total</th><th>IVA</th><th>IIBB</th>${puedeCorregir() ? "<th></th>" : ""}</tr></thead>
    <tbody>${list.map((c) => {
      const trib = sumTributos(c);
      const nc = c.tipo === "NOTA_CREDITO";
      const extra = [nc && c.factura_ref ? "Afecta a N° " + esc(c.factura_ref) : "", trib > 0 ? "Otros tributos " + $(c, trib) : "", c.notas ? esc(c.notas) : ""].filter(Boolean).join(" · ");
      return `<tr${nc ? ` class="nc-row"` : ""}>
      <td><span class="${c.grupo === "FACTURADO" ? "fact" : "nofact"}" title="${c.grupo === "FACTURADO" ? "Facturado" : "No facturado"}">●</span> <span class="prov-nom">${esc(proveedorNombre(c.proveedor_id))}</span>${esAdmin() ? " " + sucursalTag(c.sucursal_id) : ""}${nc ? ` <span class="nc-tag">Nota de crédito</span>` : ""}
        <small>${conHora ? hora(c.created_at) + " hs · " : ""}N° ${esc(c.numero)} · ${fmtDate(c.fecha)}${c.cargado_por ? ` · <span class="quien" title="Cargado por">${esc(c.cargado_por)}</span>` : ""}</small>
        ${extra ? `<small>${extra}</small>` : ""}</td>
      <td class="tot">${$(c, c.monto)}</td>
      <td>${$(c, iva(c))}</td>
      <td>${$(c, c.iibb)}</td>
      ${puedeCorregir() ? `<td><div class="hoy-acc">${iconos
        ? `<button class="btn secondary small ico" data-edit="${c.id}" title="Corregir" aria-label="Corregir">✎</button><button class="btn secondary small ico" ${delAttr}="${c.id}" title="Eliminar" aria-label="Eliminar">🗑</button>`
        : `<button class="btn secondary small" data-edit="${c.id}">Corregir</button><button class="btn secondary small" ${delAttr}="${c.id}">Eliminar</button>`}</div></td>` : ""}
    </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

/** Pinta solo la lista del día, sin re-renderizar el formulario (no pisa lo que se está tipeando). */
function renderHoy() {
  const el = document.getElementById("hoyList");
  if (!el) return;
  if (!hoy.length) {
    el.innerHTML = `<div class="empty-state panel" style="padding:26px 20px;">Todavía no se cargaron comprobantes hoy${esAdmin() ? "" : " en esta sucursal"}.<br>Se reinicia todos los días a las 00:00.</div>`;
    return;
  }
  el.innerHTML = tablaComprobantes(hoy, { conHora: true, delAttr: "data-delhoy", iconos: true });   // sin suma del día
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => corregirComprobante(b.dataset.edit)));
  el.querySelectorAll("[data-delhoy]").forEach((b) => b.addEventListener("click", async () => {
    if (await eliminarComprobante(b.dataset.delhoy)) { listLoaded = false; render(); }
  }));
}

function syncDraft() {
  if (route !== "subir" || !draft) return;
  const val = (id) => document.getElementById(id)?.value;
  const map = { sucursalId: "f_sucursal", proveedorId: "f_proveedor", fecha: "f_fecha", numero: "f_numero", monto: "f_monto", notas: "f_notas", facturaRef: "f_facturaRef" };
  for (const [k, id] of Object.entries(map)) { const v = val(id); if (v !== undefined) draft[k] = v; }
  for (const k of ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"]) { const v = val("f_" + k); if (v !== undefined) draft[k] = v; }
  document.querySelectorAll("[data-trib]").forEach((el) => { draft.tributos[el.dataset.trib] = el.value; });
}

/** CUIT con guiones mientras se escribe: 30-12345678-9 */
function cuitTexto(v) {
  const d = String(v).replace(/\D/g, "").slice(0, 11);
  return d.length > 10 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d;
}
function wireCuit(el) {
  el.addEventListener("input", () => { el.value = cuitTexto(el.value); });
}

async function crearProveedor(nombre, cuit) {
  cuit = cuitTexto(cuit || "");
  if (cuit && !/^\d{2}-\d{8}-\d$/.test(cuit)) { toast("El CUIT tiene que tener 11 números (ej: 30-12345678-9)."); return null; }
  const { data, error } = await sb.from("proveedores").insert({ nombre, cuit: cuit || null }).select().single();
  if (error) { toast(errorMsg(error, "proveedor")); return null; }
  state.proveedores.push(data);
  state.proveedores.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return data;
}

/** Comprobantes del mismo proveedor con el mismo número (ignora guiones y ceros). [] si no hay o si falla. */
async function mismosNumero(proveedorId, numero) {
  if (!proveedorId || !numero.trim()) return [];
  const { data, error } = await sb.rpc("comprobantes_mismo_numero", { p_proveedor: proveedorId, p_numero: numero.trim(), p_excluir: editId });
  return error ? [] : data;   // si falta la función en la base, queda la regla única de la tabla
}

/** Muestra debajo del N° si ese comprobante ya está cargado (mismo tipo = no deja guardar). */
async function verificarDuplicado() {
  const el = document.getElementById("dupAviso");
  if (!el || !draft) return;
  const seq = ++dupSeq;
  const rows = await mismosNumero(draft.proveedorId, draft.numero);
  if (seq !== dupSeq || !document.getElementById("dupAviso")) return;
  const fila = (c) => `${fmtDate(c.fecha)} · N° ${esc(c.numero)} · ${fmtMoney(c.monto)} · ${esc(c.sucursal || "")} · ${c.grupo === "FACTURADO" ? "Facturado" : "No facturado"}`;
  const delTipo = rows.filter((c) => (c.tipo || "FACTURA") === (draft.tipo || "FACTURA"));
  const mismo = delTipo.filter((c) => c.grupo === draft.grupo), otro = delTipo.filter((c) => c.grupo !== draft.grupo);
  document.getElementById("dupAviso").innerHTML =
    (mismo.length ? `<div class="dup-aviso err"><b>Ya está cargado</b> — no se puede guardar otra vez:${mismo.map((c) => `<div>${fila(c)}</div>`).join("")}</div>` : "")
    + (otro.length ? `<div class="dup-aviso warn"><b>Ojo:</b> ese número ya existe como ${otro[0].grupo === "FACTURADO" ? "Facturado" : "No facturado"}. Revisá que no sea el mismo:${otro.map((c) => `<div>${fila(c)}</div>`).join("")}</div>` : "");
}

/** Revisión única: grupos de comprobantes ya cargados con el mismo proveedor y número (admin). */
async function buscarDuplicados() {
  dupBuscando = true; render();
  try {
    const rows = await fetchAll(() => sb.from("comprobantes").select("*").order("fecha", { ascending: false }));
    const g = {};
    for (const c of rows) (g[c.proveedor_id + "|" + (c.tipo || "FACTURA") + "|" + numeroNorm(c.numero)] ||= []).push(c);
    dupGrupos = Object.values(g).filter((x) => x.length > 1);
  } catch (e) { toast(errorMsg(e)); }
  dupBuscando = false;
  if (route === "listado") render();
}

function seccionDuplicados() {
  return `<div class="section-label">Posibles duplicados</div>
  <p class="muted-p">Busca en todas las fechas comprobantes del mismo proveedor con el mismo número (aunque estén escritos distinto). Revisalos y eliminá el que sobre.</p>
  <button class="btn secondary small mb16" id="btnDuplicados" ${dupBuscando ? "disabled" : ""}>${dupBuscando ? "Buscando…" : dupGrupos ? "Volver a revisar" : "Revisar duplicados"}</button>
  ${dupGrupos === null ? "" : dupGrupos.length
    ? dupGrupos.map((grp) => tablaComprobantes(grp)).join(`<div style="height:10px"></div>`)
    : `<div class="empty-state panel mb26">No hay comprobantes duplicados.</div>`}`;
}

/** Abre el formulario con los datos de un comprobante para corregirlo (admin o gerente). */
function corregirComprobante(id) {
  const c = comprobantes.find((x) => x.id === id) || hoy.find((x) => x.id === id) || busqResultados?.find((x) => x.id === id)
    || dupGrupos?.flat().find((x) => x.id === id)
    || arcaComps.find((x) => x.id === id);
  if (!c) return;
  draft = {
    grupo: c.grupo, tipo: c.tipo || "FACTURA", facturaRef: c.factura_ref || "", sucursalId: c.sucursal_id, proveedorId: c.proveedor_id, fecha: c.fecha, numero: c.numero,
    monto: montoTexto(c.monto) || "0", notas: c.notas || "",
    tributos: Object.fromEntries(Object.entries(c.tributos || {}).map(([k, v]) => [k, montoTexto(v)])),
  };
  for (const k of ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"]) draft[k] = montoTexto(c[k]);
  editId = id; showNewProv = false;
  if (route !== "subir") location.hash = "subir"; else render();
  window.scrollTo(0, 0);
}

async function eliminarComprobante(id) {
  if (!(await dialogo("¿Eliminar este comprobante? No se puede deshacer.", { aceptar: "Eliminar", peligro: true }))) return false;
  const { error } = await sb.from("comprobantes").delete().eq("id", id);
  if (error) { toast(errorMsg(error)); return false; }
  comprobantes = comprobantes.filter((c) => c.id !== id);
  hoy = hoy.filter((c) => c.id !== id);
  if (busqResultados) busqResultados = busqResultados.filter((c) => c.id !== id);
  if (dupGrupos) dupGrupos = dupGrupos.map((g) => g.filter((c) => c.id !== id)).filter((g) => g.length > 1);
  if (editId === id) { editId = null; draft = null; }
  toast("Comprobante eliminado.");
  return true;
}

async function guardarComprobante() {
  syncDraft();
  const d = draft;
  const sucursalId = esAdmin() ? d.sucursalId : state.perfil.sucursal_id;
  if (!sucursalId) { toast("Elegí una sucursal."); return; }
  if (!d.proveedorId) { toast("Elegí o agregá un proveedor."); return; }
  if (!d.fecha) { toast("Ingresá la fecha del comprobante."); document.getElementById("f_fecha")?.focus(); return; }
  if (d.fecha > todayISO()) { toast("La fecha no puede ser posterior a hoy."); document.getElementById("f_fecha")?.focus(); return; }
  if (!d.numero.trim()) { toast("El número de comprobante es obligatorio."); document.getElementById("f_numero")?.focus(); return; }
  if ((await mismosNumero(d.proveedorId, d.numero)).some((c) => c.grupo === d.grupo && (c.tipo || "FACTURA") === (d.tipo || "FACTURA"))) {
    toast("Ese comprobante ya está cargado (mismo proveedor y número)."); verificarDuplicado(); return;
  }
  if (!d.monto.trim() || isNaN(parseMonto(d.monto))) { toast("Ingresá el monto total."); return; }
  for (const k of ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"]) {
    if (isNaN(parseMonto(d[k]))) { toast("Revisá los montos de IVA e impuestos."); return; }
  }

  const row = {
    sucursal_id: sucursalId, proveedor_id: d.proveedorId, grupo: d.grupo, fecha: d.fecha,
    numero: d.numero.trim(), monto: parseMonto(d.monto), notas: d.notas.trim() || null,
    tipo: d.tipo || "FACTURA", factura_ref: d.tipo === "NOTA_CREDITO" ? (d.facturaRef || "").trim() || null : null,
  };
  for (const k of ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"]) row[k] = parseMonto(d[k]);
  const trib = {};
  for (const [id, v] of Object.entries(d.tributos || {})) {
    const n = parseMonto(v);
    if (isNaN(n)) { toast("Revisá los montos de tributos y tasas."); return; }
    if (n > 0) trib[id] = n;
  }
  if (Object.keys(trib).length || editId) row.tributos = trib;   // al corregir se pisa siempre (permite borrar montos)

  saving = true; render();
  // Sin .select(): no depende de poder leer la fila
  const { error } = editId
    ? await sb.from("comprobantes").update(row).eq("id", editId)
    : await sb.from("comprobantes").insert(row);
  saving = false;
  if (error) { toast(errorMsg(error)); render(); return; }
  hoyLoaded = false;   // render() vuelve a traer el historial del día
  ultimoProveedorId = d.proveedorId;
  if (!editId) ultimaFecha = d.fecha;   // corregir uno viejo no cambia la fecha predeterminada

  toast(editId ? "Comprobante corregido." : "Comprobante guardado.");
  draft = null; editId = null; showNewProv = false; listLoaded = false;
  render();
}

/* ---------- LISTADO (admin) ---------- */
function tablaResumen(rows, labelFn) {
  return `<table class="data-table">
    <thead><tr><th>${labelFn ? "Período" : "Sucursal"}</th><th>Blanco</th><th>Negro</th><th>Total</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(labelFn ? labelFn(r.key) : r.key)}</td>
      <td class="fact">${fmtMoney(r.fact)}</td>
      <td class="nofact">${fmtMoney(r.noFact)}</td>
      <td class="tot">${fmtMoney(r.fact + r.noFact)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

/** Rangos de los botones rápidos del Listado. */
function rangoRapido(r) {
  return r === "hoy" ? [todayISO(), todayISO()] : r === "semana" ? weekRange() : r === "mes" ? monthRange() : yearRange();
}

function listaFiltrada() {
  if (esGerente()) return comprobantes.filter((c) => c.sucursal_id === state.perfil.sucursal_id);
  return sucursalFilter === "todas" ? comprobantes : comprobantes.filter((c) => c.sucursal_id === sucursalFilter);
}

/** Proveedores presentes en la lista (+ el elegido aunque no tenga comprobantes), con cantidad. */
function proveedoresEn(list) {
  const count = {};
  for (const c of list) count[c.proveedor_id] = (count[c.proveedor_id] || 0) + 1;
  if (provFilter !== "todos" && !count[provFilter]) count[provFilter] = 0;
  return Object.entries(count)
    .map(([id, n]) => ({ id, n, nombre: proveedorNombre(id) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function autoGran() {
  const dias = (new Date(hasta) - new Date(desde)) / 864e5 + 1;
  return dias <= 31 ? "dia" : dias <= 120 ? "semana" : dias <= 731 ? "mes" : "año";
}

function niceStep(max, ticks = 4) {
  const raw = max / ticks, mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
}

/** Columnas apiladas Facturado / No facturado por período, con períodos vacíos incluidos. */
function chartCompras(list) {
  const gran = chartGran || autoGran();
  const keys = periodKeysBetween(desde, hasta, gran);
  const byKey = Object.fromEntries(groupBy(list, (c) => periodKey(c.fecha, gran)).map((r) => [r.key, r]));
  // las notas de crédito restan; un período con más crédito que compras queda en 0 en el gráfico
  const cols = keys.map((k) => ({ key: k, fact: Math.max(0, byKey[k]?.fact || 0), noFact: Math.max(0, byKey[k]?.noFact || 0) }));
  // Por sucursal: solo el admin mirando todas, y si hay más de una sucursal en el período
  const sucIds = state.sucursales.map((s) => s.id).filter((id) => list.some((c) => c.sucursal_id === id));
  const verSuc = esAdmin() && sucursalFilter === "todas" && sucIds.length > 1;
  const porSuc = verSuc && chartVer === "sucursal";
  if (porSuc) {
    const porPeriodo = sucIds.map((id) => Object.fromEntries(groupBy(list.filter((c) => c.sucursal_id === id), (c) => periodKey(c.fecha, gran)).map((r) => [r.key, Math.max(0, r.fact + r.noFact)])));
    for (const c of cols) c.sucs = sucIds.map((id, j) => ({ id, v: porPeriodo[j][c.key] || 0 }));
  }
  for (const c of cols) c.tot = c.sucs ? c.sucs.reduce((a, s) => a + s.v, 0) : c.fact + c.noFact;
  chartData = { cols, gran };

  const max = Math.max(0, ...cols.map((c) => c.tot));
  const step = max > 0 ? niceStep(max) : 1;
  const top = max > 0 ? Math.ceil(max / step) * step : 4;
  const ticks = []; for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const pct = (v) => (v / top) * 100;
  const multiYear = desde.slice(0, 4) !== hasta.slice(0, 4);
  const every = Math.max(1, Math.ceil(cols.length / 7));
  const pico = cols.reduce((a, c, i) => (c.tot > cols[a].tot ? i : a), 0);
  const granBtns = [["dia", "Día"], ["semana", "Semana"], ["mes", "Mes"], ["año", "Año"]];

  return `
  <div class="panel chart-panel mb26" id="chartPanel">
    <div class="chart-head">
      <div class="chart-legend">${porSuc
        ? sucIds.map((id) => `<span><i class="sw ${sucColor(id)}"></i>${esc(sucursalNombre(id))}</span>`).join("")
        : `<span><i class="sw fact"></i>Facturado</span><span><i class="sw nofact"></i>No facturado</span>`}</div>
      ${verSuc ? `<div class="filters chart-gran"><button data-cver="tipo" class="${porSuc ? "" : "active"}">Por tipo</button><button data-cver="sucursal" class="${porSuc ? "active" : ""}">Por sucursal</button></div>` : ""}
      <div class="filters chart-gran">${granBtns.map(([g, l]) => `<button data-cgran="${g}" class="${gran === g ? "active" : ""}">${l}</button>`).join("")}</div>
    </div>
    <div class="chart">
      <div class="chart-y">${ticks.map((v) => `<span style="bottom:${pct(v)}%">${v ? fmtCompact(v) : "0"}</span>`).join("")}</div>
      <div class="chart-scroll">
        <div class="chart-plot" style="min-width:${cols.length * 10}px">
          <div class="chart-cols">
            ${ticks.map((v) => `<div class="chart-grid" style="bottom:${pct(v)}%"></div>`).join("")}
            ${cols.map((c, i) => {
              const tot = c.tot;
              return `<div class="chart-col" data-ci="${i}" tabindex="0" aria-label="${esc(periodLabel(c.key, gran))}: ${fmtMoney(tot)}">
                <div class="chart-bar" style="height:${pct(tot)}%">
                  ${c.sucs
                    ? c.sucs.filter((s) => s.v > 0).reverse().map((s) => `<div class="seg ${sucColor(s.id)}" style="flex:${s.v}"></div>`).join("")
                    : `${c.noFact > 0 ? `<div class="seg nofact" style="flex:${c.noFact}"></div>` : ""}
                  ${c.fact > 0 ? `<div class="seg fact" style="flex:${c.fact}"></div>` : ""}`}
                </div>
                ${i === pico && tot > 0 && cols.length <= 31 ? `<div class="chart-peak" style="bottom:${pct(tot)}%">${fmtCompact(tot)}</div>` : ""}
                ${i % every === 0 ? `<div class="chart-x">${periodShort(c.key, gran, multiYear)}</div>` : ""}
              </div>`;
            }).join("")}
          </div>
        </div>
      </div>
    </div>
    <div class="chart-tip" id="chartTip" hidden></div>
    <details class="chart-table">
      <summary>Ver como tabla</summary>
      ${tablaResumen(cols.filter((c) => c.fact + c.noFact > 0).reverse(), (k) => periodLabel(k, gran))}
    </details>
  </div>`;
}

/** Aporte de cada proveedor / sucursal al total (barras horizontales); los más chicos van a "Otros". */
function chartAporte(list, { titulo, campo, nombre, attr, colorSuc = false }) {
  const TOP = 6;
  const rows = groupBy(list, (c) => c[campo]).map((g) => ({ ...g, fact: Math.max(0, g.fact), noFact: Math.max(0, g.noFact) })).map((g) => ({ ...g, tot: g.fact + g.noFact })).sort((a, b) => b.tot - a.tot);
  const total = rows.reduce((a, g) => a + g.tot, 0);
  if (!total) return "";
  let shown = rows;
  if (rows.length > TOP + 1) {
    const resto = rows.slice(TOP);
    shown = [...rows.slice(0, TOP), resto.reduce((o, g) => ({ ...o, fact: o.fact + g.fact, noFact: o.noFact + g.noFact, tot: o.tot + g.tot }),
      { key: null, nombre: `Otros (${resto.length})`, fact: 0, noFact: 0, tot: 0 })];
  }
  const max = Math.max(...shown.map((g) => g.tot));
  const pct = (v) => (v / max) * 100;
  return `<div class="panel chart-panel mb26">
    <div class="chart-head">
      <div class="prov-title">${titulo}</div>
      <div class="chart-legend">${colorSuc
        ? `<span><i class="sw muestra"></i>Facturado</span><span><i class="sw muestra rayado"></i>No facturado</span>`
        : `<span><i class="sw fact"></i>Facturado</span><span><i class="sw nofact"></i>No facturado</span>`}</div>
    </div>
    ${shown.map((g) => {
      const n = g.key ? nombre(g.key) : g.nombre;
      // por sucursal: color de la sucursal, lleno = facturado y rayado = no facturado
      const [cf, cn] = colorSuc && g.key ? [sucColor(g.key), sucColor(g.key) + " rayado"] : ["fact", "nofact"];
      return `<${g.key ? `button type="button" ${attr}="${g.key}" title="Ver solo ${esc(n)}"` : "div"} class="prov-row">
        <span class="prov-name">${colorSuc && g.key ? `<i class="sw ${sucColor(g.key)}"></i>` : ""}${esc(n)}</span>
        <span class="prov-bar"><i class="seg ${cf}" style="width:${pct(g.fact)}%"></i><i class="seg ${cn}" style="width:${pct(g.noFact)}%"></i></span>
        <span class="prov-amt"><b>${fmtMoney(g.tot)}</b> · ${Math.round((g.tot / total) * 100)}%</span>
      </${g.key ? "button" : "div"}>`;
    }).join("")}
    <div class="prov-hint">Tocá una fila para ver solo esa.</div>
  </div>`;
}

function pageListado() {
  const base = listaFiltrada();
  const t = computeTotals(base);
  const bySuc = groupBy(comprobantes, (c) => sucursalNombre(c.sucursal_id)).sort((a, b) => (b.fact + b.noFact) - (a.fact + a.noFact));
  const periods = groupByPeriod(base, periodGranularity);
  let hist = base;
  if (listFilter === "facturado") hist = hist.filter((c) => c.grupo === "FACTURADO");
  if (listFilter === "nofacturado") hist = hist.filter((c) => c.grupo === "NO_FACTURADO");
  const provOpts = proveedoresEn(hist);
  if (provFilter !== "todos") hist = hist.filter((c) => c.proveedor_id === provFilter);
  const ht = computeTotals(hist);

  const cargando = `<div class="loading">Cargando comprobantes…</div>`;
  return `
  <div class="pagehead"><h1 class="serif">Listado</h1><p>${esAdmin() ? "Comprobantes de todas las sucursales." : "Comprobantes de " + esc(sucursalNombre(state.perfil.sucursal_id)) + "."}</p></div>

  <div class="trip trip2">
  <section class="trip-col">
  <div class="trip-h">1 · Período y totales</div>
  <div class="panel mb16" style="padding:16px;">
    <div class="filters">
      ${[["hoy", "Hoy"], ["semana", "Esta semana"], ["mes", "Este mes"], ["año", "Este año"]].map(([r, l]) => {
        const [d, h] = rangoRapido(r);
        return `<button data-range="${r}" class="${d === desde && h === hasta ? "active" : ""}">${l}</button>`;
      }).join("")}
    </div>
    <div class="row2">
      <div class="field" style="margin-bottom:12px;"><label>Desde</label><input type="date" id="fDesde" value="${desde}"></div>
      <div class="field" style="margin-bottom:12px;"><label>Hasta</label><input type="date" id="fHasta" value="${hasta}"></div>
    </div>
    ${esAdmin() ? `<div class="filters" style="margin-bottom:12px;">
      <button data-suc="todas" class="${sucursalFilter === "todas" ? "active" : ""}">Todas las sucursales</button>
      ${state.sucursales.map((s) => `<button data-suc="${s.id}" class="${sucursalFilter === s.id ? "active" : ""}">${esc(s.nombre)}</button>`).join("")}
    </div>` : ""}
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button class="btn small" id="btnAplicar">Actualizar</button>
      <button class="btn secondary small" id="btnGenPDF" ${listLoading ? "disabled" : ""}>📄 PDF del período</button>
      <button class="btn secondary small" id="btnGenXls" ${listLoading ? "disabled" : ""}>📊 Excel del período</button>
    </div>
    <div class="alcance-actual">Mostrando: <b>${desde === hasta ? fmtDate(desde) : `${fmtDate(desde)} al ${fmtDate(hasta)}`}</b> · <b>${esc(esGerente()
      ? sucursalNombre(state.perfil.sucursal_id) : sucursalFilter === "todas" ? "Todas las sucursales" : sucursalNombre(sucursalFilter))}</b></div>
  </div>

  ${listLoading ? cargando : `
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Facturado (blanco)</div><div class="kpi-value">${fmtMoney(t.fact)}</div></div>
    <div class="kpi"><div class="kpi-label">No facturado (negro)</div><div class="kpi-value">${fmtMoney(t.noFact)}</div></div>
    <div class="kpi"><div class="kpi-label">Total real</div><div class="kpi-value">${fmtMoney(t.total)}</div></div>
  </div>`}
  </section>

  <section class="trip-col">
  <div class="trip-h">2 · Más información</div>
  ${listLoading ? cargando : `
  ${plegable("lis-impuestos", "Impuestos del período", `
    <div class="hint" style="margin-top:0;">Para cotejar con tu contador o ARCA.</div>
    <table class="data-table">
      ${IMPUESTOS.map(([k, label]) => `<tr><td>${label}</td><td>${fmtMoney(t[k])}</td></tr>`).join("")}
      <tr class="tot"><td><b>Total IVA</b></td><td><b>${fmtMoney(t.ivaTotal)}</b></td></tr>
      <tr><td>Ingresos Brutos (Misiones)</td><td>${fmtMoney(t.iibb)}</td></tr>
      ${[...new Set([...tributosActivos().map((x) => x.id), ...Object.keys(t.tributos)])]
        .map((id) => `<tr><td>${esc(tributoNombre(id))}</td><td>${fmtMoney(t.tributos[id] || 0)}</td></tr>`).join("")}
      <tr class="ventas-tot"><td>Total impuestos</td><td>${fmtMoney(t.impuestosTotal)}</td></tr>
    </table>`, { resumen: fmtMoney(t.impuestosTotal) })}

  ${esAdmin() && sucursalFilter === "todas" && bySuc.length > 1 ? plegable("lis-sucursal", "Por sucursal", tablaResumen(bySuc), { resumen: `${bySuc.length} sucursales` }) : ""}

  ${plegable("lis-periodo", "Resumen por período", `
    <div class="filters" style="margin-top:4px;">
      ${[["dia", "Día"], ["semana", "Semana"], ["mes", "Mes"], ["año", "Año"]].map(([g, l]) => `<button data-gran="${g}" class="${periodGranularity === g ? "active" : ""}">${l}</button>`).join("")}
    </div>
    ${periods.length ? tablaResumen(periods, (k) => periodLabel(k, periodGranularity)) : `<div class="empty-state">No hay comprobantes en este período.</div>`}`)}

  ${plegable("lis-analisis", "Gráficos y proveedores", hist.length ? `
    ${listFilter === "todos" ? `<div class="total-split mb16" style="margin-top:4px;">
      <span><i class="sw fact"></i>Facturado <b>${fmtMoney(ht.fact)}</b></span>
      <span><i class="sw nofact"></i>No facturado <b>${fmtMoney(ht.noFact)}</b></span>
    </div>
    ${chartCompras(hist)}` : ""}
    ${esAdmin() && sucursalFilter === "todas" && provFilter === "todos" && new Set(hist.map((c) => c.sucursal_id)).size > 1
      ? chartAporte(hist, { titulo: "Aporte por sucursal", campo: "sucursal_id", nombre: sucursalNombre, attr: "data-sfil", colorSuc: true }) : ""}
    ${provFilter === "todos" ? chartAporte(hist, { titulo: "Aporte por proveedor", campo: "proveedor_id", nombre: proveedorNombre, attr: "data-pfil" }) : ""}`
    : `<div class="empty-state">No hay comprobantes para este filtro.</div>`)}`}
  </section>
  </div>

  <section class="comp-full">
  <div class="trip-h">3 · Comprobantes</div>
  ${listLoading ? "" : `<div class="lis-filtros">
    <div class="filters" style="margin:0;">
      <button data-filter="todos" class="${listFilter === "todos" ? "active" : ""}">Todos</button>
      <button data-filter="facturado" class="${listFilter === "facturado" ? "active" : ""}">Facturado</button>
      <button data-filter="nofacturado" class="${listFilter === "nofacturado" ? "active" : ""}">No facturado</button>
    </div>
    <select id="fProv" aria-label="Proveedor">
      <option value="todos">Todos los proveedores</option>
      ${provOpts.map((p) => `<option value="${p.id}" ${provFilter === p.id ? "selected" : ""}>${esc(p.nombre)} (${p.n})</option>`).join("")}
    </select>
  </div>
  ${hist.length && (listFilter !== "todos" || provFilter !== "todos") ? `<div class="total-box" style="margin-bottom:12px;">
    <span>Total${provFilter !== "todos" ? " · " + esc(proveedorNombre(provFilter)) : ""}<small class="total-sub">${hist.length} comprobante${hist.length === 1 ? "" : "s"}${ht.impuestosTotal > 0 ? " · Impuestos " + fmtMoney(ht.impuestosTotal) : ""}</small></span>
    <span>${fmtMoney(ht.total)}</span>
  </div>` : ""}`}
  <div class="field busq" style="margin-bottom:12px;">
    <label>Buscar por N° de comprobante, proveedor, importe o nota de crédito</label>
    <input type="search" id="fBusq" inputmode="search" autocomplete="off" placeholder="Ej: 031700020301 · Del Sud · 120.500,00 · nota de crédito" value="${esc(busqueda)}">
  </div>
  <div id="busqRes">${busqHtml()}</div>
  <div id="histNormal" ${busqueda.trim() ? "hidden" : ""}>
  ${listLoading ? cargando : hist.length
    ? tablaComprobantes(hist)
    : `<div class="empty-state panel"><span class="serif">Sin comprobantes</span>No hay comprobantes para este filtro.</div>`}
  </div>
  </section>

  ${esAdmin() ? plegable("lis-herramientas", "🛠 Herramientas del administrador", `
  <div class="hint" style="margin-top:0;">Copia completa, duplicados, otros tributos e importar.</div>
  <div class="section-label">Copia completa</div>
  <div class="filters"><button data-copiatodo>⬇ Descargar todo (Excel)</button></div>
  ${info("lis-copia-info", "Un Excel con todo: estado de resultados, comprobantes, ventas, gastos operativos, proveedores y listas. Sirve para trabajar en Excel, para el contador y como respaldo. Conviene bajarlo una vez por mes.", "ⓘ Qué trae la copia")}

  ${seccionDuplicados()}

  ${seccionTributos()}

  <div class="section-label">Migrar datos de la versión anterior</div>
  <div class="filters">
    <button id="btnImport">📤 Importar copia de seguridad (.json)</button>
    <input type="file" id="importFile" accept="application/json" style="display:none;">
  </div>
  <div class="hint">Subí las copias descargadas desde el Facturero anterior (una por sucursal). Los comprobantes repetidos se ignoran.</div>`,
  { abierto: dupGrupos !== null || dupBuscando }) : ""}
  `;
}

/* ---------- OTROS TRIBUTOS Y TASAS (admin) ---------- */
function seccionTributos() {
  const activos = tributosActivos(), quitados = state.tributos.filter((t) => !t.activo);
  return `
  <div class="section-label">Otros tributos y tasas</div>
  <div class="hint" style="margin-top:0;">Aparecen como campos al cargar un comprobante y se suman en los impuestos del período.</div>
  <div class="panel mb16" style="padding:6px 18px;">
    ${activos.length ? `<table class="data-table">${activos.map((t) => `<tr>
      <td>${esc(t.nombre)}</td>
      <td><button class="linkbtn" data-tribren="${t.id}">Renombrar</button> <button class="linkbtn" data-tribtoggle="${t.id}">Quitar</button></td>
    </tr>`).join("")}</table>` : `<div class="loading" style="padding:16px;">No hay tributos cargados.</div>`}
  </div>
  <div class="provrow mb16">
    <input type="text" id="tribNuevo" placeholder="Ej: Tasa de seguridad e higiene" style="flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:4px; background:var(--panel); color:var(--ink);">
    <button id="btnTribAdd" type="button">+ Agregar</button>
  </div>
  ${quitados.length ? `<div class="hint">Quitados (los comprobantes viejos los conservan): ${quitados.map((t) => `${esc(t.nombre)} <button class="linkbtn" data-tribtoggle="${t.id}">Reactivar</button>`).join(" · ")}</div>` : ""}`;
}

async function guardarTributo(op) {
  const { error } = await op;
  if (error) { toast(error.code === "23505" ? "Ya existe un tributo con ese nombre." : errorMsg(error)); return false; }
  await loadTributos(); render(); return true;
}

/* ---------- IMPORTAR BACKUP DEL ARTEFACTO ANTERIOR ---------- */
async function importarBackup(file) {
  let incoming;
  try {
    const parsed = JSON.parse(await file.text());
    incoming = parsed.data || parsed;
    if (!Array.isArray(incoming.proveedores) || !Array.isArray(incoming.comprobantes)) throw new Error();
  } catch { toast("El archivo no parece una copia de seguridad válida."); return; }

  if (!(await dialogo(`Se van a importar ${incoming.comprobantes.length} comprobantes y ${incoming.proveedores.length} proveedores. Los repetidos se ignoran. ¿Continuar?`, { aceptar: "Importar" }))) return;
  toast("Importando…");

  const norm = (s) => String(s || "").replace(/\D/g, "");
  // 1) Proveedores: id viejo -> id nuevo (match por CUIT o nombre)
  const provMap = {};
  for (const p of incoming.proveedores) {
    const found = state.proveedores.find((x) => (p.cuit && norm(x.cuit) === norm(p.cuit)) || x.nombre.trim().toLowerCase() === String(p.nombre).trim().toLowerCase());
    if (found) { provMap[p.id] = found.id; continue; }
    let { data, error } = await sb.from("proveedores").insert({ nombre: p.nombre, cuit: p.cuit || null }).select().single();
    if (error?.code === "23514") ({ data, error } = await sb.from("proveedores").insert({ nombre: p.nombre, cuit: null }).select().single());
    if (error) { toast(`Error con el proveedor "${p.nombre}": ${errorMsg(error, "proveedor")}`); return; }
    state.proveedores.push(data); provMap[p.id] = data.id;
  }
  state.proveedores.sort((a, b) => a.nombre.localeCompare(b.nombre));

  // 2) Sucursales: por nombre (se crean si no existen)
  const sucId = async (nombre) => {
    nombre = (nombre || "").trim(); if (!nombre) return null;
    let s = state.sucursales.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase());
    if (!s) {
      const { data, error } = await sb.from("sucursales").insert({ nombre }).select().single();
      if (error) throw error;
      state.sucursales.push(data); s = data;
    }
    return s.id;
  };

  // 3) Comprobantes
  const rows = []; let omitidos = 0;
  try {
    for (const c of incoming.comprobantes) {
      const sucursal_id = await sucId(c.sucursal);
      const proveedor_id = provMap[c.proveedorId];
      if (!sucursal_id || !proveedor_id || !c.numero) { omitidos++; continue; }
      rows.push({
        sucursal_id, proveedor_id, grupo: c.grupo === "NO_FACTURADO" ? "NO_FACTURADO" : "FACTURADO",
        fecha: c.fecha, numero: String(c.numero).trim(), monto: Math.max(0, Number(c.monto) || 0),
        iva21: Number(c.iva21) || 0, iva105: Number(c.iva105) || 0, iva27: Number(c.iva27) || 0,
        iva5: Number(c.iva5) || 0, iva25: Number(c.iva25) || 0, iibb: Number(c.iibb) || 0,
        notas: c.notas || null,
        ...(c.createdAt ? { created_at: new Date(c.createdAt).toISOString() } : {}),
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("comprobantes")
        .upsert(rows.slice(i, i + 500), { onConflict: "proveedor_id,grupo,numero", ignoreDuplicates: true });
      if (error) throw error;
    }
  } catch (e) { toast(errorMsg(e)); return; }

  toast(`Importación lista: ${rows.length} procesados${omitidos ? `, ${omitidos} omitidos (sin sucursal o proveedor)` : ""}.`);
  listLoaded = false; render();
}

/* ---------- PROVEEDORES ---------- */
/* ---------- ARCA (admin) ---------- */
async function compararConArca() {
  if (!arcaFilas) return;
  arcaCargando = true; arcaError = ""; render();
  try {
    const [d, h] = rangoArca(arcaFilas);
    const mas = (iso, n) => { const x = new Date(iso + "T00:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    // ±15 días: la fecha cargada puede ser la de recepción y no la de emisión
    arcaComps = await fetchAll(() => sb.from("comprobantes").select("*").gte("fecha", mas(d, -15)).lte("fecha", mas(h, 15)).order("fecha"));
    arcaRes = compararArca(arcaFilas, arcaComps, state.proveedores);
  } catch (e) { arcaError = errorMsg(e) || String(e.message || e); }
  arcaCargando = false;
  if (route === "arca") render();
}

/** Abre Subir con los datos de un comprobante de ARCA que falta cargar. */
function cargarDesdeArca(i) {
  const a = arcaRes?.falta[i]?.a;
  if (!a) return;
  const prov = state.proveedores.find((p) => (p.cuit || "").replace(/\D/g, "") === a.cuit);
  editId = null;
  draft = { ...newDraft(), grupo: "FACTURADO", tipo: a.nc ? "NOTA_CREDITO" : "FACTURA", fecha: a.fecha,
    numero: `${a.pv.padStart(5, "0")}-${a.num.padStart(8, "0")}`, monto: montoTexto(a.total) };
  if (prov) { draft.proveedorId = prov.id; showNewProv = false; provNuevoPendiente = null; }
  else { showNewProv = true; provNuevoPendiente = { nombre: a.nombre, cuit: a.cuit }; }
  location.hash = "subir";
  toast(prov ? "Completá el IVA y el IIBB y guardá." : "Primero guardá el proveedor nuevo, después completá el IVA y el IIBB.");
}

function descargarCsvArca() {
  const res = arcaRes; if (!res) return;
  const n = (v) => (v === null || v === undefined || v === "" ? "" : Number(v).toFixed(2).replace(".", ","));
  const filas = [["Resultado", "Fecha", "Tipo", "CUIT", "Proveedor", "Número ARCA", "Número Facturero", "Total ARCA", "Total Facturero", "Diferencia", "Sucursal", "Detalle"]];
  const nA = (a) => `${a.pv.padStart(5, "0")}-${a.num.padStart(8, "0")}`;
  for (const { a, c, detalle } of res.dif) filas.push(["Diferencia de importe", a.fecha, a.tipoTexto, a.cuit, a.nombre || proveedorNombre(c.proveedor_id), nA(a), c.numero, n(a.total), n(c.monto), n(Number(c.monto) - a.total), sucursalNombre(c.sucursal_id), detalle.join(" · ")]);
  for (const { a, c, detalle } of res.revisar) filas.push(["Número distinto", a.fecha, a.tipoTexto, a.cuit, a.nombre || proveedorNombre(c.proveedor_id), nA(a), c.numero, n(a.total), n(c.monto), n(Number(c.monto) - a.total), sucursalNombre(c.sucursal_id), detalle.join(" · ")]);
  for (const { a } of res.falta) filas.push(["Falta cargar", a.fecha, a.tipoTexto, a.cuit, a.nombre, nA(a), "", n(a.total), "", n(-a.total), "", ""]);
  for (const { c } of res.noArca) filas.push(["No está en ARCA", c.fecha, c.tipo === "NOTA_CREDITO" ? "Nota de crédito" : "Factura", (state.proveedores.find((p) => p.id === c.proveedor_id)?.cuit || ""), proveedorNombre(c.proveedor_id), "", c.numero, "", n(c.monto), n(c.monto), sucursalNombre(c.sucursal_id), ""]);
  for (const { a, c } of res.ok) filas.push(["Coincide", a.fecha, a.tipoTexto, a.cuit, a.nombre || proveedorNombre(c.proveedor_id), nA(a), c.numero, n(a.total), n(c.monto), "0,00", sucursalNombre(c.sucursal_id), ""]);
  const csv = "\ufeff" + filas.map((f) => f.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `facturero_control_arca_${res.desde}_a_${res.hasta}.csv` });
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function tablaArca(items, tipo) {
  const nA = (a) => `${a.pv.padStart(5, "0")}-${a.num.padStart(8, "0")}`;
  const tipoTxt = (nc) => (nc ? ` <span class="nc-tag">Nota de crédito</span>` : "");
  if (!items.length) return `<div class="arca-vacio">Sin casos.</div>`;
  return `<div class="hoy-wrap"><table class="data-table arca-tabla">
    <thead><tr><th>Proveedor</th><th>Fecha</th><th>N° ARCA</th><th>N° Facturero</th><th>Total ARCA</th><th>Total Facturero</th><th>Diferencia</th><th></th></tr></thead>
    <tbody>${items.map((it, i) => {
      const { a, c } = it;
      const prov = a ? (a.nombre || proveedorNombre(c?.proveedor_id)) : proveedorNombre(c.proveedor_id);
      const totA = a ? a.total : null, totF = c ? Number(c.monto) : null;
      const dif = totA !== null && totF !== null ? totF - totA : totA !== null ? -totA : totF;
      return `<tr>
        <td>${esc(prov)}${tipoTxt(a ? a.nc : c.tipo === "NOTA_CREDITO")}
          <small>${c ? esc(sucursalNombre(c.sucursal_id)) : "CUIT " + esc(a.cuit)}${it.detalle?.length ? " · " + esc(it.detalle.join(" · ")) : ""}</small></td>
        <td>${fmtDate(a ? a.fecha : c.fecha)}</td>
        <td>${a ? nA(a) : "—"}</td>
        <td>${c ? esc(c.numero) : "—"}</td>
        <td>${totA !== null ? fmtMoney(totA) : "—"}</td>
        <td>${totF !== null ? fmtMoney(totF) : "—"}</td>
        <td class="${Math.abs(dif) > 1 ? "arca-dif" : ""}">${fmtMoney(dif)}</td>
        <td>${tipo === "falta" ? `<button class="btn small" data-arcacargar="${i}">Cargar</button>`
          : tipo === "ok" ? "" : `<button class="btn secondary small" data-edit="${c.id}">Corregir</button>`}</td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

function pageArca() {
  const res = arcaRes;
  const tarjeta = (n, label, cls) => `<div class="arca-kpi ${cls}"><div class="arca-kpi-n">${n}</div><div class="arca-kpi-l">${label}</div></div>`;
  return `
  <div class="pagehead"><h1 class="serif">Compara ARCA</h1><p>Compará lo cargado en Facturero con las facturas que ARCA tiene registradas a nombre del negocio.</p></div>

  <div class="trip trip2">
  <section class="trip-col">
  <div class="trip-h">1 · Archivo de ARCA</div>
  <div class="panel mb16" style="padding:16px;">
    <ol class="arca-pasos">
      <li>Entrá a <b>ARCA</b> con la clave fiscal y abrí <b>Mis Comprobantes → Recibidos</b>.</li>
      <li>Elegí el período (por ejemplo, el mes) y tocá <b>Exportar</b> (CSV o Excel).</li>
      <li>Subí ese archivo acá. Se compara en tu navegador: el archivo no se guarda.</li>
    </ol>
    <input type="file" id="arcaFile" accept=".csv,.txt,.xlsx,.xls" style="display:none;">
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      <button class="btn small" id="btnArcaFile">📤 Subir archivo de ARCA</button>
      ${arcaFilas ? `<button class="btn secondary small" id="btnArcaRecomparar" ${arcaCargando ? "disabled" : ""}>↻ Volver a comparar</button>` : ""}
    </div>
    ${arcaArchivo ? `<div class="hint" style="margin-top:10px;">Archivo: <b>${esc(arcaArchivo)}</b> · ${arcaFilas.length} comprobantes${res ? ` · del ${fmtDate(res.desde)} al ${fmtDate(res.hasta)}` : ""}</div>` : ""}
    ${arcaError ? `<div class="dup-aviso err" style="margin-top:10px;">${esc(arcaError)}</div>` : ""}
  </div>
  <div class="hint">Se comparan solo los comprobantes <b>Facturados</b> (lo no facturado no figura en ARCA), de todas las sucursales, por CUIT del proveedor + punto de venta + número. Diferencias de hasta $ 1 se toman como redondeo.</div>
  </section>

  <section class="trip-col">
  <div class="trip-h">2 · Resultado</div>
  ${arcaCargando ? `<div class="loading">Comparando…</div>` : !res ? `<div class="empty-state panel">Subí el archivo de ARCA para ver la comparación.</div>` : `
  <div class="arca-kpis">
    ${tarjeta(res.ok.length, "Coinciden", "ok")}
    ${tarjeta(res.dif.length, "Diferencia de importe", "warn")}
    ${tarjeta(res.revisar.length, "Número distinto", "warn")}
    ${tarjeta(res.falta.length, "Faltan cargar", "err")}
    ${tarjeta(res.noArca.length, "No están en ARCA", "err")}
  </div>
  ${res.provSinCuit.length ? `<div class="dup-aviso warn">Estos proveedores no tienen CUIT y no se pueden comparar: ${res.provSinCuit.map((id) => esc(proveedorNombre(id))).join(", ")}. Cargales el CUIT en Proveedores.</div>` : ""}
  <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px;">
    <button class="btn small" id="btnArcaPdf">📄 Informe PDF de diferencias</button>
    <button class="btn secondary small" id="btnArcaCsv">📊 Descargar Excel (CSV)</button>
  </div>`}
  </section>
  </div>

  ${res && !arcaCargando ? `
  <section class="comp-full">
    <div class="trip-h">3 · Detalle</div>
    <div class="section-label primera">⚠️ Diferencia de importe (${res.dif.length})</div>${tablaArca(res.dif, "dif")}
    <div class="section-label">⚠️ Número cargado distinto (${res.revisar.length})</div>${tablaArca(res.revisar, "revisar")}
    <div class="section-label">❌ En ARCA y sin cargar en Facturero (${res.falta.length})</div>${tablaArca(res.falta, "falta")}
    <div class="section-label">❓ Cargados como facturados y no están en ARCA (${res.noArca.length})</div>${tablaArca(res.noArca, "noArca")}
    <details class="herramientas"><summary>✅ Coinciden (${res.ok.length})</summary>${tablaArca(res.ok, "ok")}</details>
  </section>` : ""}
  `;
}

/* ---------- VENTAS (admin): libro de IVA ventas, blanco / negro por punto de venta ---------- */
const pct = (n) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;

/** Barras por día: blanco (verde) abajo y negro (naranja) arriba, con el total al pasar el mouse. */
function chartVentas(dias) {
  const max = Math.max(0, ...dias.map((d) => Math.max(0, d.blanco) + Math.max(0, d.negro)));
  if (!max) return "";
  const step = niceStep(max), top = Math.ceil(max / step) * step;
  const ticks = []; for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const h = (v) => (Math.max(0, v) / top) * 100;
  const every = Math.max(1, Math.ceil(dias.length / 10));
  return `<div class="panel chart-panel mb16">
    <div class="chart-head"><div class="chart-legend"><span><i class="sw fact"></i>Blanco</span><span><i class="sw nofact"></i>Negro</span></div></div>
    <div class="chart">
      <div class="chart-y">${ticks.map((v) => `<span style="bottom:${h(v)}%">${v ? fmtCompact(v) : "0"}</span>`).join("")}</div>
      <div class="chart-scroll"><div class="chart-plot" style="min-width:${dias.length * 12}px"><div class="chart-cols">
        ${ticks.map((v) => `<div class="chart-grid" style="bottom:${h(v)}%"></div>`).join("")}
        ${dias.map((d, i) => `<div class="chart-col" title="${fmtDate(d.fecha)} · Blanco ${fmtMoney(d.blanco)} · Negro ${fmtMoney(d.negro)} · Total ${fmtMoney(d.blanco + d.negro)}">
          <div class="chart-bar" style="height:${h(d.blanco) + h(d.negro)}%">
            ${d.negro > 0 ? `<div class="seg nofact" style="flex:${d.negro}"></div>` : ""}
            ${d.blanco > 0 ? `<div class="seg fact" style="flex:${d.blanco}"></div>` : ""}
          </div>
          ${i % every === 0 ? `<div class="chart-x">${d.fecha.slice(8, 10)}/${d.fecha.slice(5, 7)}</div>` : ""}
        </div>`).join("")}
      </div></div></div>
    </div>
  </div>`;
}

function pageVentas() {
  const L = ventasLibro;
  const pvs = L ? puntosDeVenta(L.filas) : [];
  const faltan = pvs.filter((p) => ventasPV[p.pv] !== "blanco" && ventasPV[p.pv] !== "negro");
  const r = L && !faltan.length ? resumenVentas(L, ventasPV) : null;
  return `
  <div class="pagehead"><h1 class="serif">Ventas</h1><p>${esAdmin()
    ? "Subí el Libro de IVA Ventas del sistema de la farmacia o cargá las ventas del día a mano."
    : "Subí el Libro de IVA Ventas de " + esc(sucursalNombre(state.perfil.sucursal_id)) + " o cargá las ventas del día a mano, y compará con lo comprado."}</p></div>

  <div class="trip trip2">
  <section class="trip-col">
  <div class="trip-h">1 · Libro de IVA Ventas (PDF)</div>
  <div class="panel mb16" style="padding:16px;">
    ${info("ven-pdf-info", `<ol class="arca-pasos" style="margin:0;">
      <li>En el sistema de la farmacia sacá el <b>Libro de IVA Ventas</b> del período en <b>PDF</b>.</li>
      <li>Arrastralo al recuadro de abajo (o tocalo para elegirlo). Se lee en tu navegador: el archivo no se guarda.</li>
      <li>Elegí <b>Blanco</b> o <b>Negro</b> para cada punto de venta y tocá <b>Guardar</b>.</li>
    </ol>`, "ⓘ Cómo se sube el PDF")}
    <input type="file" id="ventasFile" accept=".pdf,application/pdf" style="display:none;">
    <button type="button" class="dropzone${ventasCargando ? " cargando" : ""}" id="ventasDrop" ${ventasCargando ? "disabled" : ""}>
      <span class="dropzone-ico">📄</span>
      <span class="dropzone-txt">${ventasCargando ? "Leyendo el PDF…" : "<b>Arrastrá el PDF acá</b><br>o tocá para elegirlo"}</span>
    </button>
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px;">
      ${esGerente() ? `<span class="hint" style="margin:0;">Sucursal: <b>${esc(sucursalNombre(state.perfil.sucursal_id))}</b></span>`
        : `<select id="ventasSuc" class="ventas-suc" title="Sucursal del libro">
        <option value="">Sucursal: sin indicar</option>
        ${state.sucursales.map((s) => `<option value="${s.id}" ${ventasSucursal === s.id ? "selected" : ""}>${esc(s.nombre)}</option>`).join("")}
      </select>`}
    </div>
    ${L ? `<div class="hint" style="margin-top:10px;">Archivo: <b>${esc(ventasArchivo)}</b> · ${esc(L.empresa)} · ${L.filas.length} comprobantes · del ${fmtDate(L.desde)} al ${fmtDate(L.hasta)}</div>
    ${L.cuadra === true ? `<div class="ventas-ok">✓ La suma de los comprobantes coincide con el total del PDF (${fmtMoney(L.totalPdf)}).</div>`
      : L.cuadra === false ? `<div class="dup-aviso warn" style="margin-top:8px;">La suma leída (${fmtMoney(L.suma)}) no coincide con el total del PDF (${fmtMoney(L.totalPdf)}). Revisá el archivo.</div>` : ""}
    ${L.avisos.length ? `<div class="dup-aviso warn" style="margin-top:8px;">${L.avisos.slice(0, 5).map(esc).join("<br>")}</div>` : ""}` : ""}
    ${L && ventasDetectada?.id ? `<div class="hint" style="margin:8px 0 0;">${ventasDetectada.id === ventasSucursal
      ? `✓ Sucursal detectada por el punto de venta <b>${esc(ventasDetectada.pv)}</b>: ${esc(sucursalNombre(ventasDetectada.id))}.`
      : `⚠️ Por el punto de venta <b>${esc(ventasDetectada.pv)}</b> este libro parece de <b>${esc(sucursalNombre(ventasDetectada.id))}</b>.`}</div>`
      : L && ventasDetectada?.varias ? `<div class="dup-aviso warn" style="margin-top:8px;">Los puntos de venta de este PDF ya figuran en más de una sucursal (${ventasDetectada.varias.map((id) => esc(sucursalNombre(id))).join(", ")}). Elegí la sucursal con cuidado.</div>`
      : L ? `<div class="hint" style="margin:8px 0 0;">Elegí la sucursal. La próxima vez se va a detectar sola por el punto de venta.</div>` : ""}
    ${ventasError ? `<div class="dup-aviso err" style="margin-top:10px;">${esc(ventasError)}</div>` : ""}
  </div>

  ${L ? `<div class="trip-h">2 · Puntos de venta</div>
  <div class="panel mb16" style="padding:12px 16px;">
    ${pvs.map((p) => `<div class="pv-row">
      <div class="pv-info"><b>Punto de venta ${esc(p.pv)}</b><small>${p.n} comprobantes${p.nc ? ` (${p.nc} N. crédito)` : ""} · ${fmtMoney(p.total)}</small></div>
      <div class="badge-group pv-sel">
        <button data-pv="${p.pv}" data-lado="blanco" class="${ventasPV[p.pv] === "blanco" ? "active fact" : ""}">Blanco</button>
        <button data-pv="${p.pv}" data-lado="negro" class="${ventasPV[p.pv] === "negro" ? "active nofact" : ""}">Negro</button>
      </div>
    </div>`).join("")}
    ${faltan.length ? `<div class="hint" style="margin:8px 0 0;">Elegí Blanco o Negro para ${faltan.length === 1 ? "el punto de venta " + esc(faltan[0].pv) : "cada punto de venta"} para ver el resultado.</div>` : ""}
  </div>` : ""}
  </section>

  <section class="trip-col">
  <div class="trip-h">3 · Resultado</div>
  ${!L ? `<div class="empty-state panel">Subí el PDF de ventas para ver blanco y negro.</div>`
    : !r ? `<div class="empty-state panel">Falta elegir Blanco o Negro en los puntos de venta.</div>` : `
  ${resultadoVentas(r, { pdf: "btnVentasPdf", xls: "btnVentasXls", extra: `<button class="btn small" id="btnVentasGuardar" ${ventasGuardando ? "disabled" : ""}>${ventasGuardando ? "Guardando…" : "💾 Guardar en Facturero"}</button>` })}
  <div class="hint" style="margin-top:0;">Al guardar se registran los totales por día y punto de venta (no el PDF)${ventasSucursal ? ` en <b>${esc(sucursalNombre(ventasSucursal))}</b>` : ". Elegí la sucursal arriba"}. Si ese período ya estaba guardado, se reemplaza.</div>`}
  </section>
  </div>

  <section class="comp-full">
  <div class="trip-h">4 · Carga manual</div>
  ${cargaManualHtml()}
  </section>

  <section class="comp-full">
  <div class="trip-h">5 · Historial guardado</div>
  ${historialVentasHtml()}
  </section>

  <section class="comp-full">
  <div class="trip-h">6 · Ventas en blanco vs compras facturadas</div>
  ${comparativoHtml()}
  </section>
  `;
}

/** Tarjetas, barra blanco / negro, IVA, gráfico, botones y tabla por día (sirve para el PDF leído y para el historial). */
function resultadoVentas(r, { pdf, xls, extra = "", id = "ven" }) {
  const kpi = (label, v, sub = "") => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${v}</div>${sub ? `<div class="total-sub">${sub}</div>` : ""}</div>`;
  return `
  <div class="kpi-row ventas-kpis">
    ${kpi("Ventas en blanco", fmtMoney(r.t.blanco), `${r.t.nBlanco} comprob. · ${pct(100 - r.t.pctNegro)}`)}
    ${kpi("Ventas en negro", fmtMoney(r.t.negro), `${r.t.nNegro} comprob. · ${pct(r.t.pctNegro)}`)}
    ${kpi("Total vendido", fmtMoney(r.t.total))}
  </div>
  <div class="ventas-barra" title="Blanco ${pct(100 - r.t.pctNegro)} · Negro ${pct(r.t.pctNegro)}">
    <i class="seg fact" style="width:${100 - r.t.pctNegro}%"></i><i class="seg nofact" style="width:${r.t.pctNegro}%"></i>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
    ${extra}
    <button class="btn ${extra ? "secondary " : ""}small" id="${pdf}">📄 Informe PDF</button>
    <button class="btn secondary small" id="${xls}">📊 Excel</button>
  </div>
  ${plegable(id + "-detalle", "IVA, gráfico y día por día", `
  <div class="ventas-iva">IVA débito (blanco): <b>${fmtMoney(r.t.ivaBlanco)}</b> · Neto gravado <b>${fmtMoney(r.t.netoBlanco)}</b> · Exento <b>${fmtMoney(r.t.exentoBlanco)}</b>${r.t.ncBlanco || r.t.ncNegro ? ` · Notas de crédito: blanco <b>${fmtMoney(r.t.ncBlanco)}</b>, negro <b>${fmtMoney(r.t.ncNegro)}</b> (ya restadas)` : ""}</div>
  ${chartVentas(r.dias)}
  <div class="hoy-wrap"><table class="data-table">
    <thead><tr><th>Día</th><th>Blanco</th><th>Negro</th><th>Total</th><th>% negro</th></tr></thead>
    <tbody>${r.dias.filter((d) => d.blanco || d.negro).map((d) => `<tr>
      <td>${fmtDate(d.fecha)}</td><td class="fact">${fmtMoney(d.blanco)}</td><td class="nofact">${fmtMoney(d.negro)}</td>
      <td class="tot">${fmtMoney(d.blanco + d.negro)}</td><td>${pct(d.blanco + d.negro ? (d.negro / (d.blanco + d.negro)) * 100 : 0)}</td>
    </tr>`).join("")}
    <tr class="ventas-tot"><td>Total</td><td class="fact">${fmtMoney(r.t.blanco)}</td><td class="nofact">${fmtMoney(r.t.negro)}</td><td class="tot">${fmtMoney(r.t.total)}</td><td>${pct(r.t.pctNegro)}</td></tr>
    </tbody>
  </table></div>`, { resumen: "IVA " + fmtMoney(r.t.ivaBlanco) })}`;
}

/** Historial: lo guardado en ventas_diarias, con filtro de fechas y sucursal. */
function historialVentasHtml() {
  const h = ventasHist;
  const r = h.rows ? resumenGuardado(h.rows, h.desde, h.hasta) : null;
  const porSuc = h.rows && h.suc === "todas" ? state.sucursales.map((s) => {
    const rows = h.rows.filter((x) => x.sucursal_id === s.id);
    return rows.length ? { s, ...resumenGuardado(rows, h.desde, h.hasta).t } : null;
  }).filter(Boolean) : [];
  return `<div class="panel mb16" style="padding:16px;">
    <div class="filters">${[["mes", "Este mes"], ["mesAnt", "Mes anterior"], ["año", "Este año"]].map(([k, l]) => `<button data-vrango="${k}">${l}</button>`).join("")}</div>
    <div class="row2">
      <div class="field" style="margin-bottom:12px;"><label>Desde</label><input type="date" id="vhDesde" value="${h.desde}"></div>
      <div class="field" style="margin-bottom:12px;"><label>Hasta</label><input type="date" id="vhHasta" value="${h.hasta}"></div>
    </div>
    ${esGerente() ? "" : `<div class="filters" style="margin-bottom:0;">
      <button data-vsuc="todas" class="${h.suc === "todas" ? "active" : ""}">Todas las sucursales</button>
      ${state.sucursales.map((s) => `<button data-vsuc="${s.id}" class="${h.suc === s.id ? "active" : ""}">${esc(s.nombre)}</button>`).join("")}
    </div>`}
  </div>
  ${h.cargando ? `<div class="loading">Cargando ventas guardadas…</div>`
    : h.error ? `<div class="dup-aviso err">${esc(h.error)}</div>`
    : !h.rows ? ""
    : !h.rows.length ? `<div class="empty-state panel">No hay ventas guardadas en ese período${h.suc !== "todas" ? " para " + esc(sucursalNombre(h.suc)) : ""}.</div>`
    : `${porSuc.length > 1 ? plegable("ven-hist-suc", "Por sucursal", `<div class="hoy-wrap"><table class="data-table">
        <thead><tr><th>Sucursal</th><th>Blanco</th><th>Negro</th><th>Total</th><th>% negro</th></tr></thead>
        <tbody>${porSuc.map((x) => `<tr><td>${sucursalTag(x.s.id)}</td><td class="fact">${fmtMoney(x.blanco)}</td><td class="nofact">${fmtMoney(x.negro)}</td><td class="tot">${fmtMoney(x.total)}</td><td>${pct(x.pctNegro)}</td></tr>`).join("")}</tbody>
      </table></div>`, { resumen: `${porSuc.length} sucursales` }) : ""}
      ${resultadoVentas(r, { pdf: "btnVhPdf", xls: "btnVhXls", id: "ven-hist" })}`}`;
}

/** Trae lo guardado en ventas_diarias para el período y sucursal del historial. */
async function cargarHistVentas() {
  const h = ventasHist;
  if (esGerente()) h.suc = state.perfil.sucursal_id;
  h.cargando = true; h.error = ""; if (route === "ventas") render();
  try {
    // Siempre se traen todas las sucursales: la comparación con compras muestra cada una y el general
    const [ventas, compras] = await Promise.all([
      fetchAll(() => sb.from("ventas_diarias").select("*").gte("fecha", h.desde).lte("fecha", h.hasta).order("fecha")),
      fetchAll(() => sb.from("comprobantes").select("fecha, sucursal_id, grupo, tipo, monto, iva21, iva105, iva27, iva5, iva25")
        .gte("fecha", h.desde).lte("fecha", h.hasta).order("fecha")),
    ]);
    h.todas = ventas; h.compras = compras;
    h.rows = h.suc === "todas" ? ventas : ventas.filter((r) => r.sucursal_id === h.suc);
  } catch (e) { h.rows = null; h.error = errorMsg(e); }
  h.cargando = false; if (route === "ventas") render();
}

/** Guarda los totales del PDF leído (por día y punto de venta); reemplaza ese período de esa sucursal. */
/**
 * Busca en lo ya guardado de qué sucursal es cada punto de venta del PDF. Los que figuran en una sola sucursal
 * (el de blanco, que es propio de cada una) la identifican; los compartidos (como el 0099 de negro) se ignoran.
 */
async function detectarSucursalVentas() {
  ventasDetectada = null;
  const pvs = puntosDeVenta(ventasLibro.filas).map((p) => p.pv);
  const conf = state.sucursales.filter((x) => x.pv_blanco && pvs.includes(x.pv_blanco));
  if (conf.length === 1) { ventasDetectada = { id: conf[0].id, pv: conf[0].pv_blanco }; ventasSucursal = conf[0].id; return; }
  if (conf.length > 1) { ventasDetectada = { varias: conf.map((x) => x.id) }; return; }
  const { data, error } = await sb.from("ventas_diarias").select("pv, sucursal_id").in("pv", pvs).limit(5000);
  if (error || !data?.length) return;
  const porPv = {};
  for (const r of data) (porPv[r.pv] ||= new Set()).add(r.sucursal_id);
  const propios = Object.entries(porPv).filter(([, set]) => set.size === 1).map(([pv, set]) => ({ pv, id: [...set][0] }));
  const ids = [...new Set(propios.map((x) => x.id))];
  if (ids.length === 1) { ventasDetectada = propios[0]; ventasSucursal = propios[0].id; }
  else if (ids.length > 1) ventasDetectada = { varias: ids };
}

async function guardarVentas() {
  const L = ventasLibro;
  if (esGerente()) {
    // el gerente guarda solo en su sucursal, y no un PDF que por el punto de venta es de otra
    const propia = state.perfil.sucursal_id;
    if (ventasDetectada?.id && ventasDetectada.id !== propia) {
      toast(`Este PDF es de ${sucursalNombre(ventasDetectada.id)} (punto de venta ${ventasDetectada.pv}). Solo podés guardar el de ${sucursalNombre(propia)}.`); return;
    }
    ventasSucursal = propia;
  }
  if (!ventasSucursal) { toast("Elegí de qué sucursal es el libro antes de guardar."); document.getElementById("ventasSuc")?.focus(); return; }
  if (ventasDetectada?.id && ventasDetectada.id !== ventasSucursal
    && !(await dialogo(`Por el punto de venta ${ventasDetectada.pv} este libro parece de ${sucursalNombre(ventasDetectada.id)}, pero elegiste ${sucursalNombre(ventasSucursal)}. ¿Guardarlo igual en ${sucursalNombre(ventasSucursal)}?`, { aceptar: "Guardar igual" }))) return;
  const { count, error: e1 } = await sb.from("ventas_diarias").select("id", { count: "exact", head: true })
    .eq("sucursal_id", ventasSucursal).gte("fecha", L.desde).lte("fecha", L.hasta);
  if (e1) { toast(errorMsg(e1)); return; }
  if (count && !(await dialogo(`${sucursalNombre(ventasSucursal)} ya tiene ventas guardadas entre el ${fmtDate(L.desde)} y el ${fmtDate(L.hasta)}. ¿Reemplazarlas con este PDF?`, { aceptar: "Reemplazar" }))) return;
  ventasGuardando = true; render();
  const { data, error } = await sb.rpc("guardar_ventas", { p_sucursal: ventasSucursal, p_desde: L.desde, p_hasta: L.hasta, p_filas: filasParaGuardar(L, ventasPV, ventasArchivo) });
  ventasGuardando = false;
  if (error) { toast(errorMsg(error)); render(); return; }
  toast(`Ventas guardadas: ${data} ${data === 1 ? "registro" : "registros"} de ${sucursalNombre(ventasSucursal)}.`);
  ventasHist = { ...ventasHist, desde: L.desde, hasta: L.hasta, suc: ventasSucursal, rows: null };
  cargarHistVentas();
}

function datosHistVentas() {
  const h = ventasHist;
  return {
    libro: { desde: h.desde, hasta: h.hasta, empresa: "" }, asignacion: {}, archivo: "Historial guardado",
    sucursal: h.suc === "todas" ? "Todas las sucursales" : sucursalNombre(h.suc),
    resumen: resumenGuardado(h.rows || [], h.desde, h.hasta),
  };
}

/** Línea acumulada día a día: compras facturadas vs ventas en blanco (SVG, se adapta al ancho). */
function chartAcumulado(dias) {
  const max = Math.max(1, ...dias.map((d) => Math.max(d.acumVentas, d.acumCompras)));
  const W = 600, H = 170, pad = 4;
  const x = (i) => (dias.length < 2 ? W / 2 : pad + (i / (dias.length - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - (Math.max(0, v) / max) * (H - 2 * pad);
  const linea = (campo) => dias.map((d, i) => `${x(i).toFixed(1)},${y(d[campo]).toFixed(1)}`).join(" ");
  const every = Math.max(1, Math.ceil(dias.length / 8));
  return `<div class="panel chart-panel mb16">
    <div class="chart-head">
      <div class="prov-title">Acumulado del período</div>
      <div class="chart-legend"><span><i class="sw fact"></i>Ventas en blanco</span><span><i class="sw comp"></i>Compras facturadas</span></div>
    </div>
    <div class="acum-wrap">
      <div class="acum-y"><span>${fmtCompact(max)}</span><span>${fmtCompact(max / 2)}</span><span>0</span></div>
      <div class="acum-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="acum-svg" role="img" aria-label="Acumulado de ventas en blanco y compras facturadas">
          <line x1="0" x2="${W}" y1="${y(max / 2)}" y2="${y(max / 2)}" class="acum-grid"/>
          <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="acum-grid base"/>
          <polyline points="${linea("acumCompras")}" class="acum-compras"/>
          <polyline points="${linea("acumVentas")}" class="acum-ventas"/>
        </svg>
        <div class="acum-x">${dias.map((d, i) => (i % every === 0 || (i === dias.length - 1 && i % every >= every / 2))
          ? `<span style="left:${(x(i) / W) * 100}%">${d.fecha.slice(8, 10)}/${d.fecha.slice(5, 7)}</span>` : "").join("")}</div>
      </div>
    </div>
  </div>`;
}

/** Ventas en blanco vs compras facturadas: general, por sucursal, equilibrio y acumulado por día. */
function comparativoHtml() {
  const h = ventasHist;
  if (h.cargando || h.error || !h.todas) return "";
  const ids = state.sucursales.map((s) => s.id);
  const cmp = compararVentasCompras(h.todas, h.compras || [], h.desde, h.hasta, ids);
  const G = cmp.grupos.general;
  if (!G.ventasBlanco && !G.comprasBlanco && !G.ventasNegro && !G.comprasNegro) return `<div class="empty-state panel">No hay ventas ni compras en ese período.</div>`;
  const sucs = state.sucursales.filter((s) => { const g = cmp.grupos[s.id]; return g && (g.ventasBlanco || g.comprasBlanco || g.ventasNegro || g.comprasNegro); });
  const cob = (g) => (g.cobertura == null ? "—" : `${g.cobertura.toLocaleString("es-AR", { maximumFractionDigits: 2 })}×`);
  const dif = (v) => `<span class="${v >= 0 ? "dif-pos" : "dif-neg"}">${v >= 0 ? "+" : ""}${fmtMoney(v)}</span>`;
  // foco: la sucursal elegida en el historial, o el general
  const foco = h.suc !== "todas" && cmp.grupos[h.suc] ? cmp.grupos[h.suc] : G;
  const focoNombre = h.suc !== "todas" ? sucursalNombre(h.suc) : "En general";
  // dias para el acumulado: de la sucursal elegida o de todas
  const dias = h.suc === "todas" ? cmp.dias
    : compararVentasCompras(h.todas.filter((r) => r.sucursal_id === h.suc), (h.compras || []).filter((c) => c.sucursal_id === h.suc), h.desde, h.hasta, [h.suc]).dias;
  // días sin ventas guardadas, contados por sucursal (un día cargado solo en una no cuenta para la otra)
  const faltantes = (h.suc === "todas" ? sucs : state.sucursales.filter((x) => x.id === h.suc)).map((x) => {
    const conVentas = new Set(h.todas.filter((r) => r.sucursal_id === x.id).map((r) => r.fecha));
    return [x.nombre, dias.filter((d) => !conVentas.has(d.fecha)).length];
  }).filter(([, k]) => k > 0);
  const arriba = sucs.filter((s) => cmp.grupos[s.id].dif > 0), abajo = sucs.filter((s) => cmp.grupos[s.id].dif < 0);
  // cómo vino el acumulado: siempre arriba, desde qué día pasó adelante, o si termina abajo
  const conMov = dias.filter((d) => d.acumCompras || d.acumVentas);
  const ultimo = conMov[conMov.length - 1];
  let marcha = "";
  if (ultimo && ultimo.acumCompras > 0) {
    if (ultimo.acumDif < 0) marcha = ` · Al cierre del período las ventas en blanco quedan <b>${fmtMoney(-ultimo.acumDif)}</b> por debajo de las compras`;
    else {
      let desde = null;
      conMov.forEach((d, i) => { if (d.acumDif >= 0 && (i === 0 || conMov[i - 1].acumDif < 0)) desde = d; });
      marcha = conMov.every((d) => d.acumDif >= 0) ? " · Las ventas en blanco estuvieron por encima de las compras todo el período"
        : ` · Las ventas en blanco pasaron a las compras el <b>${fmtDate(desde.fecha)}</b> y siguen arriba`;
    }
  }

  return `
  ${faltantes.length ? `<div class="dup-aviso warn mb16">Días del período sin ventas guardadas: ${faltantes.map(([n, k]) => `<b>${esc(n)}</b> ${k} ${k === 1 ? "día" : "días"}`).join(" · ")}. Si no estuvo cerrado esos días, faltan cargar y la comparación da ventas de menos.</div>` : ""}
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Compras facturadas</div><div class="kpi-value">${fmtMoney(foco.comprasBlanco)}</div><div class="total-sub">${esc(focoNombre)}</div></div>
    <div class="kpi"><div class="kpi-label">Ventas en blanco</div><div class="kpi-value">${fmtMoney(foco.ventasBlanco)}</div><div class="total-sub" title="Cuántas veces vendiste en blanco lo que compraste en blanco. 1× = vendiste lo mismo que compraste; más de 1× = vendiste más.">${foco.ventasBlanco ? `Cobertura ${cob(foco)}` : "Todavía sin ventas guardadas"}</div></div>
    <div class="kpi ${foco.dif >= 0 ? "kpi-pos" : "kpi-neg"}"><div class="kpi-label">${foco.dif >= 0 ? "Vendiste en blanco de más" : "Te falta vender en blanco"}</div><div class="kpi-value">${fmtMoney(Math.abs(foco.dif))}</div><div class="total-sub">ventas − compras</div></div>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
    <button class="btn small" id="btnCmpPdf">📄 PDF ventas vs compras</button>
    <button class="btn secondary small" id="btnCmpXls">📊 Excel</button>
  </div>
  ${plegable("cmp-iva", "IVA y compras en negro", `<div class="ventas-iva" style="margin-bottom:0;">Posición de IVA: débito (ventas) <b>${fmtMoney(foco.ivaDebito)}</b> − crédito (compras) <b>${fmtMoney(foco.ivaCredito)}</b> = <b>${fmtMoney(Math.abs(foco.saldoIva))}</b> ${foco.saldoIva >= 0 ? "a pagar" : "a favor"}
    · En negro: ventas <b>${fmtMoney(foco.ventasNegro)}</b>, compras <b>${fmtMoney(foco.comprasNegro)}</b>
    ${marcha}</div>`, { resumen: `IVA ${fmtMoney(Math.abs(foco.saldoIva))} ${foco.saldoIva >= 0 ? "a pagar" : "a favor"}` })}

  ${sucs.length > 1 ? `
  ${arriba.length && abajo.length ? `<div class="dup-aviso warn mb16"><b>Desequilibrio entre sucursales:</b> ${arriba.map((s) => `${esc(s.nombre)} vende en blanco ${fmtMoney(cmp.grupos[s.id].dif)} más de lo que compra`).join("; ")}, mientras que ${abajo.map((s) => `${esc(s.nombre)} vende ${fmtMoney(-cmp.grupos[s.id].dif)} menos`).join("; ")}. En general la diferencia es ${fmtMoney(G.dif)}.</div>` : ""}
  ${plegable("cmp-suc", "Por sucursal", `<div class="hoy-wrap"><table class="data-table comp-tabla">
    <thead><tr><th>Sucursal</th><th>Compras fact.</th><th>Ventas blanco</th><th>Diferencia</th><th>Cobertura</th><th>IVA débito</th><th>IVA crédito</th><th>Saldo IVA</th></tr></thead>
    <tbody>${sucs.map((s) => { const g = cmp.grupos[s.id]; return `<tr${h.suc === s.id ? ` class="fila-foco"` : ""}>
      <td>${sucursalTag(s.id)}</td><td>${fmtMoney(g.comprasBlanco)}</td><td class="fact">${fmtMoney(g.ventasBlanco)}</td><td>${dif(g.dif)}</td><td>${cob(g)}</td>
      <td>${fmtMoney(g.ivaDebito)}</td><td>${fmtMoney(g.ivaCredito)}</td><td>${fmtMoney(g.saldoIva)}</td></tr>`; }).join("")}
    <tr class="ventas-tot"><td>General</td><td>${fmtMoney(G.comprasBlanco)}</td><td class="fact">${fmtMoney(G.ventasBlanco)}</td><td>${dif(G.dif)}</td><td>${cob(G)}</td>
      <td>${fmtMoney(G.ivaDebito)}</td><td>${fmtMoney(G.ivaCredito)}</td><td>${fmtMoney(G.saldoIva)}</td></tr>
    </tbody>
  </table></div>`, { resumen: `${sucs.length} sucursales` })}` : ""}

  ${plegable("cmp-acum", "Gráfico acumulado del período", chartAcumulado(dias))}
  ${plegable("cmp-dias", "Día por día", `<div class="hoy-wrap"><table class="data-table">
    <thead><tr><th>Día</th><th>Compras fact.</th><th>Ventas blanco</th><th>Diferencia del día</th><th>Acumulado</th></tr></thead>
    <tbody>${dias.filter((d) => d.comprasBlanco || d.ventasBlanco || !d.hayVentas).map((d) => `<tr${d.hayVentas ? "" : ` class="sin-ventas" title="Sin ventas guardadas ese día"`}>
      <td>${fmtDate(d.fecha)}${d.hayVentas ? "" : " ⚠️"}</td><td>${fmtMoney(d.comprasBlanco)}</td><td class="fact">${fmtMoney(d.ventasBlanco)}</td>
      <td>${dif(d.ventasBlanco - d.comprasBlanco)}</td><td>${dif(d.acumDif)}</td></tr>`).join("")}</tbody>
  </table></div>`)}`;
}

/** Datos para el PDF / Excel del comparativo. */
function datosComparativo() {
  const h = ventasHist;
  const ids = state.sucursales.map((s) => s.id);
  const cmp = compararVentasCompras(h.todas || [], h.compras || [], h.desde, h.hasta, ids);
  const sucs = state.sucursales.filter((s) => { const g = cmp.grupos[s.id]; return g && (g.ventasBlanco || g.comprasBlanco || g.ventasNegro || g.comprasNegro); })
    .map((s) => ({ nombre: s.nombre, ...cmp.grupos[s.id] }));
  const dias = h.suc === "todas" ? cmp.dias
    : compararVentasCompras((h.todas || []).filter((r) => r.sucursal_id === h.suc), (h.compras || []).filter((c) => c.sucursal_id === h.suc), h.desde, h.hasta, [h.suc]).dias;
  return { desde: h.desde, hasta: h.hasta, foco: h.suc === "todas" ? "General" : sucursalNombre(h.suc), general: cmp.grupos.general,
    focoGrupo: h.suc !== "todas" ? cmp.grupos[h.suc] : cmp.grupos.general, sucs, dias };
}

/** Carga manual de un día (blanco / negro) + lista de lo cargado a mano en el período del historial. */
function cargaManualHtml() {
  const m = ventasManual;
  const suc = esGerente() ? state.perfil.sucursal_id : m.sucursal;
  const h = ventasHist;
  // lo manual del período del historial, agrupado por sucursal + día
  const manual = {};
  for (const r of (h.todas || []).filter((x) => x.origen === "manual")) {
    const g = (manual[r.sucursal_id + "|" + r.fecha] ||= { sucursal_id: r.sucursal_id, fecha: r.fecha, blanco: 0, negro: 0, iva: 0 });
    g[r.lado] += Number(r.total) || 0;
    if (r.lado === "blanco") g.iva += Number(r.iva21) || 0;
  }
  const lista = Object.values(manual).sort((a, b) => b.fecha.localeCompare(a.fecha));
  return `<div class="panel mb16" style="padding:16px;">
    <div class="manual-grid">
      <div class="field"><label>Sucursal</label>${esGerente()
        ? `<input type="text" value="${esc(sucursalNombre(suc))}" disabled>`
        : `<select id="vmSuc"><option value="">Elegí la sucursal</option>${state.sucursales.map((s) => `<option value="${s.id}" ${m.sucursal === s.id ? "selected" : ""}>${esc(s.nombre)}</option>`).join("")}</select>`}</div>
      <div class="field"><label>Fecha</label><input type="date" id="vmFecha" value="${esc(m.fecha)}" max="${todayISO()}"></div>
      <div class="field"><label>Ventas en blanco</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" id="vmBlanco" value="${esc(m.blanco)}" placeholder="0"></div>
      <div class="field"><label>Ventas en negro</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" id="vmNegro" value="${esc(m.negro)}" placeholder="0"></div>
      <div class="field"><label>IVA de lo blanco (opcional)</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" id="vmIva" value="${esc(m.iva)}" placeholder="0"></div>
    </div>
    <button class="btn small" id="btnVmGuardar" ${m.guardando ? "disabled" : ""}>${m.guardando ? "Guardando…" : "💾 Guardar ventas del día"}</button>
    <div style="margin-top:10px;">${info("ven-manual-info", "Si ese día ya estaba cargado a mano, se reemplaza. Los días que vinieron del PDF del sistema no se pueden pisar a mano.")}</div>
  </div>
  ${lista.length ? plegable("ven-manual-lista", "Días cargados a mano en el período", `<div class="hoy-wrap"><table class="data-table">
    <thead><tr><th>Día (cargado a mano)</th>${esGerente() ? "" : "<th>Sucursal</th>"}<th>Blanco</th><th>Negro</th><th>IVA</th><th></th></tr></thead>
    <tbody>${lista.map((g) => `<tr>
      <td>${fmtDate(g.fecha)} <span class="nc-tag manual-tag">manual</span></td>${esGerente() ? "" : `<td>${sucursalTag(g.sucursal_id)}</td>`}
      <td class="fact">${fmtMoney(g.blanco)}</td><td class="nofact">${fmtMoney(g.negro)}</td><td>${fmtMoney(g.iva)}</td>
      <td><div class="hoy-acc"><button class="btn secondary small ico" data-vmedit="${g.sucursal_id}|${g.fecha}" title="Corregir" aria-label="Corregir">✎</button><button class="btn secondary small ico" data-vmdel="${g.sucursal_id}|${g.fecha}" title="Eliminar" aria-label="Eliminar">🗑</button></div></td>
    </tr>`).join("")}</tbody>
  </table></div>`, { resumen: `${lista.length} ${lista.length === 1 ? "día" : "días"}` }) : ""}`;
}

async function guardarVentaManual() {
  const m = ventasManual;
  for (const [k, id] of [["fecha", "vmFecha"], ["blanco", "vmBlanco"], ["negro", "vmNegro"], ["iva", "vmIva"]]) m[k] = document.getElementById(id)?.value ?? m[k];
  if (!esGerente()) m.sucursal = document.getElementById("vmSuc")?.value || "";
  const suc = esGerente() ? state.perfil.sucursal_id : m.sucursal;
  if (!suc) { toast("Elegí la sucursal."); return; }
  if (!m.fecha) { toast("Ingresá la fecha."); return; }
  if (m.fecha > todayISO()) { toast("La fecha no puede ser posterior a hoy."); return; }
  const [b, n, iva] = [m.blanco, m.negro, m.iva].map(parseMonto);
  if ([b, n, iva].some((x) => isNaN(x))) { toast("Revisá los importes."); return; }
  if (!b && !n) { toast("Ingresá las ventas en blanco y/o en negro."); return; }
  m.guardando = true; render();
  const { error } = await sb.rpc("guardar_venta_manual", { p_sucursal: suc, p_fecha: m.fecha, p_blanco: b, p_negro: n, p_iva: iva });
  m.guardando = false;
  if (error) { toast(errorMsg(error)); render(); return; }
  toast(`Ventas del ${fmtDate(m.fecha)} guardadas.`);
  m.blanco = m.negro = m.iva = "";
  // que el historial incluya el día cargado
  const h = ventasHist;
  if (m.fecha < h.desde || m.fecha > h.hasta) ventasHist = { ...h, desde: m.fecha < h.desde ? m.fecha : h.desde, hasta: m.fecha > h.hasta ? m.fecha : h.hasta };
  ventasHist.rows = null;
  cargarHistVentas();
}

async function eliminarVentaManual(clave) {
  const [suc, fecha] = clave.split("|");
  if (!(await dialogo(`¿Eliminar las ventas cargadas a mano del ${fmtDate(fecha)}${esGerente() ? "" : " en " + sucursalNombre(suc)}?`, { aceptar: "Eliminar", peligro: true }))) return;
  const { error } = await sb.from("ventas_diarias").delete().eq("sucursal_id", suc).eq("fecha", fecha).eq("origen", "manual");
  if (error) { toast(errorMsg(error)); return; }
  toast("Carga manual eliminada.");
  ventasHist.rows = null;
  cargarHistVentas();
}

function corregirVentaManual(clave) {
  const [suc, fecha] = clave.split("|");
  const rows = (ventasHist.todas || []).filter((r) => r.origen === "manual" && r.sucursal_id === suc && r.fecha === fecha);
  const b = rows.find((r) => r.lado === "blanco"), n = rows.find((r) => r.lado === "negro");
  ventasManual = { ...ventasManual, sucursal: suc, fecha, blanco: montoTexto(b?.total) || "", negro: montoTexto(n?.total) || "", iva: montoTexto(b?.iva21) || "" };
  render();
  document.getElementById("vmBlanco")?.focus();
}

function datosVentas() {
  return {
    libro: ventasLibro, asignacion: ventasPV, archivo: ventasArchivo,
    sucursal: ventasSucursal ? sucursalNombre(ventasSucursal) : "",
    resumen: resumenVentas(ventasLibro, ventasPV),
  };
}

/* ---------- ESTADO DE RESULTADOS (admin): ventas − costo de ventas − gastos operativos ---------- */
const MES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** Encabezado de columna: el mes completo ("Enero"); con el año si el período abarca más de uno. */
const tituloMes = (m) => {
  const t = mesLabel(m), mayus = t[0].toUpperCase() + t.slice(1);
  return er.desde.slice(0, 4) === er.hasta.slice(0, 4) ? mayus.replace(/ \d{4}$/, "") : mayus;
};
/** Avisos cortos: hasta 3 meses se nombran; más, se resumen. */
const listaMeses = (l) => (l.length > 3 ? `${l.length} meses, entre ${l[0]} y ${l[l.length - 1]}` : l.join(", "));
const nombreGastoSuc = (id) => (id ? sucursalNombre(id) : "General (compartido)");

/** Trae ventas, compras, gastos y la lista de conceptos de los meses elegidos (siempre todas las sucursales: los generales se reparten). */
async function cargarResultados() {
  if (esGerente()) er.suc = state.perfil.sucursal_id;
  er.cargando = true; er.error = ""; pintarResultados();
  const desde = er.desde + "-01", hasta = finDeMes(er.hasta);
  try {
    const [ventas, compras, costos] = await Promise.all([
      fetchAll(() => sb.from("ventas_diarias").select("fecha, sucursal_id, lado, total, iva105, iva21, iva_otros, percep").gte("fecha", desde).lte("fecha", hasta).order("fecha")),
      fetchAll(() => sb.from("comprobantes").select("fecha, sucursal_id, grupo, tipo, monto, iva21, iva105, iva27, iva5, iva25").gte("fecha", desde).lte("fecha", hasta).order("fecha")),
      fetchAll(() => sb.from("costos_fijos").select("mes, sucursal_id, categoria, monto").gte("mes", desde).lte("mes", hasta).order("mes")),
    ]);
    let generalesDados = null;
    if (esGerente()) {
      const { data, error } = await sb.rpc("mis_gastos_generales", { p_desde: desde, p_hasta: hasta });
      if (error) throw error;
      generalesDados = Object.fromEntries((data || []).map((r) => [r.mes.slice(0, 7), Number(r.monto) || 0]));
    }
    er.datos = { ventas, compras, costos, generalesDados };
  } catch (e) { er.datos = null; er.error = errorMsg(e); }
  er.cargando = false; pintarResultados();
}

/** Dibuja solo el resultado (sin tocar la grilla de gastos, para no perder lo que se está tipeando). */
function pintarResultados() {
  if (route !== "resultados") return;
  const box = document.getElementById("erBox");
  if (!box) { render(); return; }
  box.innerHTML = resultadosHtml();
  wireResultados();
}

const ordenConceptos = () => (gx.conceptos || []).map((c) => c.nombre);

function calcularResultados(foco = er.suc) {
  return estadoResultados({ ...er.datos, meses: mesesEntre(er.desde, er.hasta), foco, sucursalIds: state.sucursales.map((s) => s.id), sinIva: er.sinIva, orden: ordenConceptos() });
}

function pageResultados() {
  return `
  ${esAdmin() ? `<div class="copia-top"><button class="btn secondary small" data-copiatodo>⬇ Descargar todo (Excel)</button></div>` : ""}
  <div class="pagehead"><h1 class="serif">Estado de resultados</h1><p>Ventas menos el costo de ventas (facturas en blanco y en negro) menos los gastos operativos, mes por mes${esGerente() ? " de " + esc(sucursalNombre(state.perfil.sucursal_id)) : " y por sucursal"}.</p></div>

  <section class="comp-full">
  <div class="trip-h">1 · Período y sucursal</div>
  <div class="panel mb16" style="padding:16px;">
    <div class="filters">${[["año", "Este año"], ["añoAnt", "Año anterior"], ["tres", "Últimos 3 meses"], ["mes", "Este mes"], ["mesAnt", "Mes anterior"]].map(([k, l]) => `<button data-errango="${k}">${l}</button>`).join("")}</div>
    <div class="row2">
      <div class="field" style="margin-bottom:12px;"><label>Desde (mes)</label><input type="month" id="erDesde" value="${er.desde}"></div>
      <div class="field" style="margin-bottom:12px;"><label>Hasta (mes)</label><input type="month" id="erHasta" value="${er.hasta}"></div>
    </div>
    ${esGerente() ? `<div class="hint" style="margin:0 0 10px;">Sucursal: <b>${esc(sucursalNombre(state.perfil.sucursal_id))}</b></div>` : `<div class="filters" style="margin-bottom:10px;">
      <button data-ersuc="todas" class="${er.suc === "todas" ? "active" : ""}">Todas las sucursales</button>
      ${state.sucursales.map((s) => `<button data-ersuc="${s.id}" class="${er.suc === s.id ? "active" : ""}">${esc(s.nombre)}</button>`).join("")}
    </div>`}
    <label class="er-check"><input type="checkbox" id="erSinIva" ${er.sinIva ? "checked" : ""}> Restar el IVA de lo blanco (el IVA no es ingreso ni costo: se le debe o se le cobra a ARCA)</label>
  </div>
  </section>

  <section class="comp-full">
  <div class="trip-h">2 · Resultado</div>
  <div id="erBox">${resultadosHtml()}</div>
  </section>

  <section class="comp-full">
  <div class="trip-h">3 · Gastos operativos</div>
  ${gastosHtml()}
  </section>`;
}

/** Bloque resumen con el formato de la planilla: ventas, costo, margen, gastos, utilidad. */
function bloqueResumen(R, titulo, clase) {
  const cols = R.cols, T = R.total, varios = cols.length > 1;
  const signed = (v) => `<span class="${v >= 0 ? "dif-pos" : "dif-neg"}">${fmtMoney(v)}</span>`;
  const pctOr = (v) => (v == null ? "—" : pct(v));
  const fila = (label, get, cls = "", fmt = fmtMoney) => `<tr class="${cls}"><td>${label}</td>${cols.map((c) => `<td>${fmt(get(c))}</td>`).join("")}${varios ? `<td class="tot">${fmt(get(T))}</td>` : ""}</tr>`;
  return `<div class="er-bloque ${clase}">
    <div class="er-bloque-h">${esc(titulo)}</div>
    <div class="er-bloque-scroll"><table class="data-table er-tabla">
      <thead><tr><th></th>${cols.map((c) => `<th class="er-mes">${esc(tituloMes(c.mes))}</th>`).join("")}${varios ? "<th>Total</th>" : ""}</tr></thead>
      <tbody>
        ${fila("Ventas totales", (c) => c.ingresos)}
        ${fila("Costo de ventas", (c) => c.variables)}
        ${fila("Margen bruto", (c) => c.margen, "er-sub", signed)}
        ${fila("% Margen bruto", (c) => c.margenPct, "er-pct", pctOr)}
        ${fila("Total de gastos operativos", (c) => c.fijos)}
        ${fila("Utilidad operativa (ganancia)", (c) => c.resultado, "er-final", signed)}
        ${fila("% Utilidad operativa", (c) => c.resultadoPct, "er-pct", pctOr)}
      </tbody>
    </table></div>
  </div>`;
}

function resultadosHtml() {
  if (er.cargando && !er.datos) return `<div class="loading">Calculando el estado de resultados…</div>`;
  if (er.error) return `<div class="dup-aviso err">${esc(er.error)}${/costos_fijos|gastos_conceptos/.test(er.error) ? "<br>Falta ejecutar en Supabase las migraciones <b>014_costos_fijos.sql</b> y <b>015_gastos_operativos.sql</b>." : ""}</div>`;
  if (!er.datos) return "";
  const R = calcularResultados(), T = R.total, cols = R.cols;
  const varios = cols.length > 1;
  const todas = er.suc === "todas";
  const ivaTxt = R.sinIva ? " (sin IVA)" : "";
  const sinVentas = cols.filter((c) => !c.hayVentas && c.mes <= mesActual()).map((c) => mesLabel(c.mes));
  const sinGastos = cols.filter((c) => !c.fijos && c.mes <= mesActual()).map((c) => mesLabel(c.mes));
  const signed = (v) => `<span class="${v >= 0 ? "dif-pos" : "dif-neg"}">${fmtMoney(v)}</span>`;
  const pctOr = (v) => (v == null ? "—" : pct(v));
  const fila = (label, get, cls = "", fmt = fmtMoney) => `<tr class="${cls}"><td>${label}</td>${cols.map((c) => `<td>${fmt(get(c))}</td>`).join("")}${varios ? `<td class="tot">${fmt(get(T))}</td>` : ""}</tr>`;
  const sec = (label) => `<tr class="er-sec"><td colspan="${cols.length + (varios ? 2 : 1)}">${label}</td></tr>`;
  const hayGenerales = !todas && T.generalesMes > 0;
  const meses = cols.length;
  // bloques como en la planilla: una por sucursal (con color) y el total
  const conMovimiento = (r) => r.total.ingresos || r.total.variables || r.total.fijos;
  const bloques = todas
    ? [...state.sucursales.map((s) => [calcularResultados(s.id), s.nombre, sucColor(s.id)]).filter(([r]) => conMovimiento(r)), [R, "Total de las farmacias", "er-total"]]
    : [[R, sucursalNombre(er.suc), sucColor(er.suc)]];

  return `
  ${sinVentas.length ? `<div class="dup-aviso warn mb16">Sin ventas guardadas en: <b>${esc(listaMeses(sinVentas))}</b>. Cargalas en la pestaña Ventas, si no el resultado da de menos.</div>` : ""}
  ${sinGastos.length ? `<div class="dup-aviso warn mb16">Sin gastos operativos cargados en: <b>${esc(listaMeses(sinGastos))}</b>${todas ? "" : " para esta sucursal"}. Cargalos abajo, en la lista de gastos operativos.</div>` : ""}
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Ventas totales${ivaTxt}</div><div class="kpi-value">${fmtMoney(T.ingresos)}</div><div class="total-sub">${todas ? "Todas las sucursales" : esc(sucursalNombre(er.suc))}</div></div>
    <div class="kpi"><div class="kpi-label">Margen bruto</div><div class="kpi-value">${fmtMoney(T.margen)}</div><div class="total-sub">${T.margenPct == null ? "—" : pct(T.margenPct) + " de las ventas"}</div></div>
    <div class="kpi ${T.resultado >= 0 ? "kpi-pos" : "kpi-neg"}"><div class="kpi-label">${T.resultado >= 0 ? "Ganancia" : "Pérdida"}</div><div class="kpi-value">${fmtMoney(Math.abs(T.resultado))}</div><div class="total-sub">${T.resultadoPct == null ? "—" : pct(T.resultadoPct) + " de las ventas"}</div></div>
  </div>
  ${plegable("er-equilibrio", "Punto de equilibrio e IVA", `<div class="ventas-iva" style="margin-bottom:0;">Gastos operativos <b>${fmtMoney(T.fijos)}</b>${meses > 1 ? ` (promedio <b>${fmtMoney(T.fijos / meses)}</b> por mes)` : ""}
    ${T.equilibrio != null ? ` · Punto de equilibrio: con este margen hay que vender <b>${fmtMoney(T.equilibrio)}</b>${meses > 1 ? ` en el período (<b>${fmtMoney(T.equilibrio / meses)}</b> por mes)` : " en el mes"} para cubrir los gastos` : ""}
    · Posición de IVA: <b>${fmtMoney(Math.abs(T.saldoIva))}</b> ${T.saldoIva >= 0 ? "a pagar" : "a favor"}</div>`,
    { resumen: T.equilibrio != null ? "Equilibrio " + fmtMoney(T.equilibrio / Math.max(1, meses)) + (meses > 1 ? " por mes" : "") : "" })}

  ${bloques.map(([r, titulo, clase]) => bloqueResumen(r, titulo, clase)).join("")}

  ${plegable("er-detalle", `Detalle${todas ? " (todas las sucursales)" : ""}: blanco / negro y cada gasto`,`<div class="hoy-wrap"><table class="data-table er-tabla">
    <thead><tr><th>Concepto</th>${cols.map((c) => `<th class="er-mes">${esc(tituloMes(c.mes))}</th>`).join("")}${varios ? "<th>Total</th>" : ""}</tr></thead>
    <tbody>
      ${sec("Ventas")}
      ${fila(`Ventas en blanco${ivaTxt}`, (c) => c.vb, "er-det")}
      ${fila("Ventas en negro", (c) => c.ventasNegro, "er-det")}
      ${fila("Ventas totales", (c) => c.ingresos, "er-sub")}
      ${sec("Costo de ventas (compras de mercadería)")}
      ${fila(`Compras facturadas${ivaTxt}`, (c) => c.cb, "er-det")}
      ${fila("Compras no facturadas", (c) => c.comprasNegro, "er-det")}
      ${fila("Costo de ventas", (c) => c.variables, "er-sub")}
      ${fila("Margen bruto", (c) => c.margen, "er-margen", signed)}
      ${fila("% Margen bruto", (c) => c.margenPct, "er-pct", pctOr)}
      ${sec("Gastos operativos")}
      ${R.categorias.map((cat) => fila(esc(cat), (c) => c.fijosCat[cat] || 0, "er-det")).join("")}
      ${hayGenerales ? fila(`Parte de gastos generales <small>(según ventas${T.parte != null ? ", " + pct(T.parte * 100) : ""})</small>`, (c) => c.fijosGenerales, "er-det") : ""}
      ${!R.categorias.length && !hayGenerales ? `<tr class="er-det"><td colspan="${cols.length + (varios ? 2 : 1)}" style="color:var(--muted);">Sin gastos cargados</td></tr>` : ""}
      ${fila("Total de gastos operativos", (c) => c.fijos, "er-sub")}
      ${fila("Utilidad operativa (ganancia)", (c) => c.resultado, "er-final", signed)}
      ${fila("% Utilidad operativa", (c) => c.resultadoPct, "er-pct", pctOr)}
    </tbody>
  </table></div>`)}
  <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
    <button class="btn small" id="btnErPdf">📄 Estado de resultados PDF</button>
    <button class="btn secondary small" id="btnErXls">📊 Excel</button>
  </div>
  ${info("er-info", `Las compras del mes se toman como costo de ventas: si ese mes se compró mucho para stock (o se vendió stock viejo), el resultado del mes se mueve aunque el negocio no haya cambiado. Mirá varios meses juntos para ver la tendencia. ${esGerente() ? "La parte de los gastos generales (los compartidos entre sucursales) se calcula según lo que vendió tu sucursal ese mes." : 'Los gastos "General" se reparten entre las sucursales según lo que vendió cada una ese mes.'}`, "ⓘ Cómo se calcula")}`;
}

function datosResultados() {
  const todas = er.suc === "todas";
  const bloques = todas
    ? [...state.sucursales.map((s) => ({ nombre: s.nombre, R: calcularResultados(s.id) })).filter((b) => b.R.total.ingresos || b.R.total.variables || b.R.total.fijos), { nombre: "Total de las farmacias", R: calcularResultados() }]
    : [{ nombre: sucursalNombre(er.suc), R: calcularResultados() }];
  return { R: calcularResultados(), bloques, desde: er.desde, hasta: er.hasta, foco: todas ? "Todas las sucursales" : sucursalNombre(er.suc), mesLabel };
}

/* --- Grilla de gastos: conceptos × meses de un año, por sucursal (o general) --- */
async function cargarGastos() {
  if (esGerente()) gx.suc = state.perfil.sucursal_id;   // el gerente, siempre la suya
  else if (gx.suc === null) gx.suc = state.sucursales[0]?.id || "";   // arranca en la primera sucursal
  gx.cargando = true; gx.error = ""; if (route === "resultados") render();
  try {
    // el año entero y el diciembre anterior (para "copiar el mes anterior" en enero)
    const [conceptos, rows] = await Promise.all([
      fetchAll(() => sb.from("gastos_conceptos").select("*").order("orden").order("nombre")),
      fetchAll(() => sb.from("costos_fijos").select("id, mes, sucursal_id, categoria, monto").gte("mes", `${gx.año - 1}-12-01`).lte("mes", `${gx.año}-12-01`)),
    ]);
    gx.conceptos = conceptos; gx.rows = rows;
  } catch (e) { gx.rows = null; gx.error = errorMsg(e); }
  gx.cargando = false;
  if (route === "resultados") { render(); if (er.datos) pintarResultados(); }
}

const gxMeses = () => Array.from({ length: 12 }, (_, i) => `${gx.año}-${String(i + 1).padStart(2, "0")}`);
/** Importe de un concepto en un mes, para la sucursal elegida en la grilla. */
function gxValor(cat, mes) {
  const suc = gx.suc || null;
  return (gx.rows || []).filter((r) => r.categoria === cat && r.mes.startsWith(mes) && (r.sucursal_id || null) === suc).reduce((a, r) => a + (Number(r.monto) || 0), 0);
}

/** Total cargado en un mes para la sucursal elegida (todos los gastos, también los quitados). */
const gxTotalMes = (m) => (gx.rows || []).filter((r) => r.mes.startsWith(m) && (r.sucursal_id || null) === (gx.suc || null)).reduce((a, r) => a + (Number(r.monto) || 0), 0);

/** Cuánto subió o bajó un gasto contra el mes anterior (subir es malo: rojo). */
function difGasto(v, v0) {
  if (!v || !v0) return "";
  const d = v - v0;
  if (Math.abs(d) < 0.005) return `<span class="gl-dif igual">= igual</span>`;
  return `<span class="gl-dif ${d > 0 ? "sube" : "baja"}">${d > 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(d))} (${d > 0 ? "+" : "−"}${pct(Math.abs(d / v0) * 100)})</span>`;
}

function gastosHtml() {
  if (gx.cargando && !gx.rows) return `<div class="loading">Cargando gastos…</div>`;
  if (gx.error) return `<div class="dup-aviso err">${esc(gx.error)}${/costos_fijos|gastos_conceptos|guardar_gasto/.test(gx.error) ? "<br>Falta ejecutar en Supabase las migraciones <b>014_costos_fijos.sql</b> y <b>015_gastos_operativos.sql</b>." : ""}</div>`;
  if (!gx.rows) return "";
  const porMes = gx.vista !== "año";
  const meses = porMes ? [gx.mes] : gxMeses();
  const activos = gx.conceptos.filter((c) => c.activo);
  // los quitados siguen apareciendo si tienen importes en lo que se está viendo
  const quitadosConDatos = gx.conceptos.filter((c) => !c.activo && meses.some((m) => gxValor(c.nombre, m)));
  const filas = [...activos, ...quitadosConDatos];
  const totalMes = (m) => filas.reduce((a, c) => a + gxValor(c.nombre, m), 0);
  const quitados = gx.conceptos.filter((c) => !c.activo);
  const celda = (c, m, f, i) => { const v = gxValor(c.nombre, m); return `<input type="text" inputmode="decimal" autocomplete="off" class="monto gx-celda" data-gxcat="${esc(c.nombre)}" data-gxmes="${m}" data-f="${f}" data-c="${i}" value="${v ? esc(montoTexto(v)) : ""}" placeholder="0" aria-label="${esc(c.nombre)} ${esc(mesLabel(m))}">`; };
  const agregarHtml = esGerente() ? `<div class="hint" style="margin-bottom:0;">La lista de gastos la arma el administrador. Si falta alguno, pedile que lo agregue.</div>` : `<div class="provrow gl-add">
    <input type="text" id="gxNuevo" placeholder="Nuevo gasto (ej.: Seguro del local)" style="flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:4px; background:var(--panel); color:var(--ink);">
    <button id="btnGxAdd" type="button">+ Agregar gasto</button>
  </div>
  ${quitados.length ? `<div class="hint" style="margin-bottom:0;">Quitados (lo ya cargado se conserva): ${quitados.map((c) => `${esc(c.nombre)} <button class="linkbtn" data-gxtoggle="${c.id}">Volver a la lista</button>`).join(" · ")}</div>` : ""}`;

  const controles = `<div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
      ${porMes
        ? `<div class="gl-nav"><button class="btn secondary small" data-gxmesnav="-1" aria-label="Mes anterior">‹</button><input type="month" id="gxMesSel" value="${gx.mes}" max="${mesActual()}" aria-label="Mes"><button class="btn secondary small" data-gxmesnav="1" aria-label="Mes siguiente" ${gx.mes >= mesActual() ? "disabled" : ""}>›</button></div>`
        : `<div class="badge-group gx-año" style="margin:0;"><button data-gxaño="${gx.año - 1}" aria-label="Año anterior">‹</button><button class="active" disabled>${gx.año}</button><button data-gxaño="${gx.año + 1}" aria-label="Año siguiente">›</button></div>`}
      ${esGerente() ? `<span class="hint" style="margin:0;">Gastos de <b>${esc(sucursalNombre(state.perfil.sucursal_id))}</b></span>` : `<div class="filters" style="margin:0;">
        ${state.sucursales.map((s) => `<button data-gxsuc="${s.id}" class="${gx.suc === s.id ? "active" : ""}">${esc(s.nombre)}</button>`).join("")}
        <button data-gxsuc="" class="${!gx.suc ? "active" : ""}" title="Gastos compartidos: se reparten entre las sucursales según lo que vendió cada una">General (compartido)</button>
      </div>`}
      <button class="linkbtn" data-gxvista="${porMes ? "año" : "mes"}" style="margin-left:auto;">${porMes ? "Ver el año completo" : "Volver a la lista del mes"}</button>
    </div>`;

  if (porMes) {
    const m = gx.mes, ant = mesMas(m, -1);
    const puedeCopiar = !totalMes(m) && filas.some((c) => gxValor(c.nombre, ant));
    const año = m.slice(0, 4);
    const mesesAño = Array.from({ length: 12 }, (_, i) => `${año}-${String(i + 1).padStart(2, "0")}`);
    const t0 = totalMes(ant);
    return `<div class="panel mb16" style="padding:16px;">
    ${controles}
    <div class="gl-meses" role="group" aria-label="Meses de ${año}">${mesesAño.map((x, i) => {
      const cargado = gxTotalMes(x) > 0, futuro = x > mesActual();
      return `<button data-gxirmes="${x}" class="${x === m ? "active" : ""}${cargado ? " ok" : ""}" ${futuro ? "disabled" : ""} title="${esc(mesLabel(x))}${cargado ? " · cargado: " + fmtMoney(gxTotalMes(x)) : futuro ? "" : " · sin gastos cargados"}">${MES_CORTO[i]}${cargado ? " ✓" : ""}</button>`;
    }).join("")}</div>
    <div class="gl-total"><span>Total de gastos operativos · ${esc(nombreGastoSuc(gx.suc || null))}</span><span class="gl-total-der"><b data-gxtot="${m}">${fmtMoney(totalMes(m))}</b><small>${esc(mesLabel(ant))}: ${fmtMoney(t0)} <span data-gxdif="" data-ant="${t0}">${difGasto(totalMes(m), t0)}</span></small></span></div>
    ${puedeCopiar ? `<div class="gl-copiar"><button class="btn small" data-gxcopiar="${m}">📋 Copiar los importes de ${esc(mesLabel(ant))}</button><span class="hint" style="margin:0;">Después corregí los que cambiaron.</span></div>` : ""}
    <div class="gl-lista">
      <div class="gl-row gl-head"><span>Gasto</span><span>Importe de ${esc(mesLabel(m))}</span><span>Mes anterior</span><span></span></div>
      ${filas.map((c, f) => { const v0 = gxValor(c.nombre, ant); return `<div class="gl-row${c.activo ? "" : " gx-quitado"}">
        <span class="gl-nombre">${esc(c.nombre)}</span>
        <span>${celda(c, m, f, 0)}</span>
        <span class="gl-ant">${v0 ? fmtMoney(v0) : "—"}<small data-gxdif="${esc(c.nombre)}" data-ant="${v0}">${difGasto(gxValor(c.nombre, m), v0)}</small></span>
        <span class="gl-acc">${c.activo && esAdmin() ? `<button class="linkbtn" data-gxmover="${c.id}" data-dir="-1" title="Subir" aria-label="Subir">↑</button><button class="linkbtn" data-gxmover="${c.id}" data-dir="1" title="Bajar" aria-label="Bajar">↓</button><button class="linkbtn" data-gxren="${c.id}" title="Renombrar" aria-label="Renombrar">✎</button><button class="linkbtn" data-gxtoggle="${c.id}" title="Quitar de la lista" aria-label="Quitar de la lista">✕</button>` : ""}</span>
      </div>`; }).join("")}
    </div>
    <div style="margin-top:10px;">${info("gx-info", "Escribí el importe y pasá al siguiente con Tab o Enter: se guarda solo. Para borrar un importe, dejá el campo vacío. La lista es la misma todos los meses. La columna de la derecha muestra el mes anterior y cuánto subió (rojo) o bajó (verde).", "ⓘ Cómo se cargan")}</div>
    ${agregarHtml}
  </div>`;
  }

  return `<div class="panel mb16" style="padding:16px;">
    ${controles}
    <div class="hint" style="margin-top:0;">Escribí el importe en la celda y pasá a la siguiente (Tab o Enter): se guarda solo. Para borrar un importe, dejá la celda vacía.</div>
    <div class="gx-wrap"><table class="gx-tabla">
      <thead><tr><th class="gx-con">${esc(nombreGastoSuc(gx.suc || null))}</th>${meses.map((m, i) => {
        const ant = mesMas(m, -1);
        const puedeCopiar = !totalMes(m) && filas.some((c) => gxValor(c.nombre, ant)) && m <= mesActual();
        return `<th>${MES_CORTO[i]}${puedeCopiar ? `<button class="gx-copiar" data-gxcopiar="${m}" title="Copiar los importes de ${esc(mesLabel(ant))}">⇐ copiar</button>` : ""}</th>`;
      }).join("")}<th>Total</th></tr></thead>
      <tbody>
        <tr class="gx-total"><td class="gx-con">Total de gastos operativos</td>${meses.map((m) => `<td data-gxtot="${m}">${totalMes(m) ? fmtMoney(totalMes(m)) : ""}</td>`).join("")}<td data-gxtot="año">${fmtMoney(meses.reduce((a, m) => a + totalMes(m), 0))}</td></tr>
        ${filas.map((c, f) => `<tr${c.activo ? "" : ` class="gx-quitado" title="Concepto quitado"`}><td class="gx-con">${esc(c.nombre)}</td>
          ${meses.map((m, i) => `<td>${celda(c, m, f, i)}</td>`).join("")}
          <td class="gx-fila-tot" data-gxfila="${esc(c.nombre)}">${fmtMoney(meses.reduce((a, m) => a + gxValor(c.nombre, m), 0))}</td></tr>`).join("")}
      </tbody>
    </table></div>
    ${agregarHtml}
  </div>`;
}

/** Recalcula los totales sin volver a dibujar (para no perder el foco). */
function actualizarTotalesGx() {
  const meses = gx.vista === "año" ? gxMeses() : [gx.mes];
  const cats = [...new Set([...document.querySelectorAll("input.gx-celda")].map((el) => el.dataset.gxcat))];
  let año = 0;
  for (const m of meses) {
    const t = cats.reduce((a, c) => a + gxValor(c, m), 0); año += t;
    const td = document.querySelector(`[data-gxtot="${m}"]`); if (td) td.textContent = t || gx.vista !== "año" ? fmtMoney(t) : "";
  }
  const ta = document.querySelector(`[data-gxtot="año"]`); if (ta) ta.textContent = fmtMoney(año);
  if (gx.vista !== "año") document.querySelectorAll("[data-gxdif]").forEach((el) => {
    const cat = el.dataset.gxdif;
    el.innerHTML = difGasto(cat ? gxValor(cat, gx.mes) : cats.reduce((a, c) => a + gxValor(c, gx.mes), 0), Number(el.dataset.ant) || 0);
  });
  // el ✓ del mes en los botones de meses
  const bm = document.querySelector(`[data-gxirmes="${gx.mes}"]`);
  if (bm) { const ok = gxTotalMes(gx.mes) > 0; bm.classList.toggle("ok", ok); bm.textContent = MES_CORTO[Number(gx.mes.slice(5)) - 1] + (ok ? " ✓" : ""); }
  document.querySelectorAll("[data-gxfila]").forEach((td) => { td.textContent = fmtMoney(meses.reduce((a, m) => a + gxValor(td.dataset.gxfila, m), 0)); });
}

let gxRecalc = null;
/** Después de cambiar gastos, el resultado se vuelve a calcular (un momento después, por si se siguen cargando). */
function gastosCambiaron() {
  clearTimeout(gxRecalc);
  gxRecalc = setTimeout(() => cargarResultados(), 900);
}

async function guardarCeldaGasto(el) {
  const cat = el.dataset.gxcat, mes = el.dataset.gxmes, suc = gx.suc || null;
  const monto = parseMonto(el.value);
  if (isNaN(monto) || monto < 0) { toast("Revisá el importe."); el.classList.add("gx-error"); return; }
  if (Math.abs(monto - gxValor(cat, mes)) < 0.005) { el.classList.remove("gx-error"); return; }
  el.classList.add("gx-guardando"); el.classList.remove("gx-error");
  const { error } = await sb.rpc("guardar_gasto", { p_mes: mes + "-01", p_sucursal: suc, p_categoria: cat, p_monto: monto });
  el.classList.remove("gx-guardando");
  if (error) { el.classList.add("gx-error"); toast(errorMsg(error)); return; }
  gx.rows = gx.rows.filter((r) => !(r.categoria === cat && r.mes.startsWith(mes) && (r.sucursal_id || null) === suc));
  if (monto > 0) gx.rows.push({ mes: mes + "-01", sucursal_id: suc, categoria: cat, monto });
  el.classList.add("gx-ok"); setTimeout(() => el.classList.remove("gx-ok"), 900);
  actualizarTotalesGx();
  gastosCambiaron();
}

async function copiarGastosMes(mes) {
  const ant = mesMas(mes, -1), suc = gx.suc || null;
  const filas = (gx.rows || []).filter((r) => r.mes.startsWith(ant) && (r.sucursal_id || null) === suc);
  if (!filas.length) return;
  const nuevas = filas.map((r) => ({ mes: mes + "-01", sucursal_id: suc, categoria: r.categoria, monto: r.monto }));
  const { error } = await sb.from("costos_fijos").insert(nuevas);
  if (error) { toast(errorMsg(error)); return; }
  gx.rows.push(...nuevas);
  toast(`Copiados ${nuevas.length} gastos de ${mesLabel(ant)} a ${mesLabel(mes)}. Corregí los que cambiaron.`);
  render(); gastosCambiaron();
}

async function opConcepto(op, okMsg) {
  const { error } = await op;
  if (error) { toast(error.code === "23505" ? "Ya existe un gasto con ese nombre." : errorMsg(error)); return false; }
  if (okMsg) toast(okMsg);
  gx.editarLista = true;
  await cargarGastos();
  return true;
}

function wireResultados() {
  wirePlegables(document.getElementById("erBox") || document);
  on("btnErPdf", "click", () => generarResultadosPDF(datosResultados()));
  on("btnErXls", "click", async () => {
    try { await generarResultadosExcel(datosResultados()); } catch (e) { toast("No se pudo generar el Excel."); console.error(e); }
  });
}

let copiando = false;
/** Copia completa en Excel (todos los datos + estado de resultados). */
async function copiaCompleta() {
  if (copiando) return;
  copiando = true;
  const botones = [...document.querySelectorAll("[data-copiatodo]")];
  botones.forEach((b) => { b.disabled = true; b.dataset.txt = b.textContent; b.textContent = "Preparando la copia…"; });
  try {
    const n = await descargarTodo();
    toast(`Copia descargada: ${n.comprobantes} comprobantes, ${n.ventas} registros de ventas, ${n.gastos} gastos y ${n.proveedores} proveedores.`);
  } catch (e) { console.error(e); toast("No se pudo armar la copia: " + errorMsg(e)); }
  copiando = false;
  botones.forEach((b) => { b.disabled = false; b.textContent = b.dataset.txt; });
}

function pageProveedores() {
  return `
  <div class="pagehead"><h1 class="serif">Proveedores</h1><p>Agregá los proveedores una vez y quedan disponibles para todas las sucursales.</p></div>
  <div class="trip trip-prov">
  <section class="trip-col fija">
  <div class="trip-h">1 · Agregar proveedor</div>
  <div class="panel" style="margin-bottom:20px;">
    <div class="row2">
      <div class="field" style="margin-bottom:12px;"><label>Nombre</label><input type="text" id="pv_nombre" placeholder="Ej: Droguería del Sud"></div>
      <div class="field" style="margin-bottom:12px;"><label>CUIT</label><input type="text" id="pv_cuit" class="cuit" inputmode="numeric" autocomplete="off" maxlength="13" placeholder="30-12345678-9"></div>
    </div>
    <button class="btn small" id="btnAddProv">+ Agregar proveedor</button>
  </div>
  </section>
  <section class="trip-col">
  <div class="trip-h">2 · Proveedores (${state.proveedores.length})</div>
  ${state.proveedores.length ? `<div class="hoy-wrap"><table class="data-table prov-tabla">
    <thead><tr><th>Proveedor</th><th>CUIT</th>${esAdmin() ? "<th></th>" : ""}</tr></thead>
    <tbody>${state.proveedores.map((p) => `<tr>
      <td>${esc(p.nombre)}</td>
      <td>${p.cuit ? esc(p.cuit) : `<span class="muted">Sin CUIT</span>`}</td>
      ${esAdmin() ? `<td><button class="btn secondary small" data-delprov="${p.id}">Eliminar</button></td>` : ""}
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="empty-state panel"><span class="serif">Sin proveedores</span>Agregá el primero.</div>`}
  </section>
  </div>
  `;
}

/* ---------- WIRE ---------- */
function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); return el; }

function wireLogin() {
  on("loginForm", "submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("btnLogin"); btn.disabled = true; btn.textContent = "Entrando…";
    actividadLista = true; ultimaGrabada = 0; marcarActividad();
    const { error } = await sb.auth.signInWithPassword({
      email: document.getElementById("loginEmail").value.trim(),
      password: document.getElementById("loginPass").value,
    });
    if (error) { loginError = errorMsg(error); render(); return; }
    loginError = "";
  });
}

function wireShell() {
  on("btnLogout", "click", async () => { await sb.auth.signOut(); location.hash = ""; });
  on("btnRetry", "click", () => onSession({ ...state.session }).catch(() => {}));
  document.querySelectorAll("[data-route]").forEach((b) => b.addEventListener("click", () => { location.hash = b.dataset.route; }));
}

function wireChartTip() {
  const panel = document.getElementById("chartPanel"), tip = document.getElementById("chartTip");
  if (!panel || !chartData) return;
  const show = (col) => {
    const c = chartData.cols[col.dataset.ci];
    tip.innerHTML = `<div class="tip-title">${esc(periodLabel(c.key, chartData.gran))}</div>
      ${c.sucs
        ? c.sucs.map((s) => `<div><i class="sw ${sucColor(s.id)}"></i>${esc(sucursalNombre(s.id))} <b>${fmtMoney(s.v)}</b></div>`).join("")
        : `<div><i class="sw fact"></i>Facturado <b>${fmtMoney(c.fact)}</b></div>
      <div><i class="sw nofact"></i>No facturado <b>${fmtMoney(c.noFact)}</b></div>`}
      <div class="tip-tot">Total <b>${fmtMoney(c.tot)}</b></div>`;
    tip.hidden = false;
    panel.querySelectorAll(".chart-col.hover").forEach((el) => el.classList.remove("hover"));
    col.classList.add("hover");
    const p = panel.getBoundingClientRect(), r = col.getBoundingClientRect();
    const x = r.left - p.left + r.width / 2;
    tip.style.left = Math.min(Math.max(x - tip.offsetWidth / 2, 8), p.width - tip.offsetWidth - 8) + "px";
    tip.style.top = Math.max(r.top - p.top - tip.offsetHeight + 24, 8) + "px";
  };
  const hide = () => { tip.hidden = true; panel.querySelectorAll(".chart-col.hover").forEach((el) => el.classList.remove("hover")); };
  panel.querySelectorAll(".chart-col").forEach((col) => {
    col.addEventListener("pointerenter", () => show(col));
    col.addEventListener("focus", () => show(col));
    col.addEventListener("click", () => show(col));
  });
  panel.querySelector(".chart").addEventListener("pointerleave", hide);
  panel.addEventListener("focusout", hide);
}

/** Campo de monto: puntos de miles y coma decimal mientras se escribe ("." del teclado numérico = coma). */
function wireMonto(el) {
  el.addEventListener("input", (e) => {
    let v = el.value, pos = el.selectionStart ?? v.length;
    if (e.data === "." && v[pos - 1] === ".") v = v.slice(0, pos - 1) + "," + v.slice(pos);
    // pegado o autocompletado tipo "1234.56": el punto final es decimal (los de miles siempre llevan 3 dígitos)
    else if (e.inputType?.startsWith("insert") && !v.includes(",") && /\.\d{1,2}$/.test(v)) v = v.replace(/\.(\d{1,2})$/, ",$1");
    // cursor contado desde el final en dígitos y coma, que es lo que sobrevive al formateo
    const sig = v.slice(pos).replace(/[^\d,]/g, "").length;
    const out = formatMontoTexto(v);
    el.value = out;
    let p = out.length, n = 0;
    while (p > 0 && n < sig) { p--; if (/[\d,]/.test(out[p])) n++; }
    el.setSelectionRange(p, p);
  });
}

function wirePage() {
  wirePlegables();
  document.querySelectorAll("[data-copiatodo]").forEach((b) => b.addEventListener("click", copiaCompleta));
  if (route === "subir") {
    document.querySelectorAll("#grupoToggle button").forEach((btn) =>
      btn.addEventListener("click", () => { syncDraft(); draft.grupo = btn.dataset.grupo; render(); }));
    on("f_nc", "change", (e) => { syncDraft(); draft.tipo = e.target.checked ? "NOTA_CREDITO" : "FACTURA"; render(); });
    on("btnNuevoProv", "click", () => { syncDraft(); showNewProv = !showNewProv; render(); if (showNewProv) document.getElementById("np_nombre")?.focus(); });
    on("btnCancelarProv", "click", () => { syncDraft(); showNewProv = false; provNuevoPendiente = null; render(); });
    on("btnGuardarProv", "click", async () => {
      const nombre = document.getElementById("np_nombre").value.trim();
      const cuit = document.getElementById("np_cuit").value.trim();
      if (!nombre) { toast("Ingresá el nombre del proveedor."); return; }
      syncDraft();
      const p = await crearProveedor(nombre, cuit);
      if (!p) return;
      draft.proveedorId = p.id; showNewProv = false; provNuevoPendiente = null;
      toast("Proveedor agregado."); render();
    });
    on("btnGuardar", "click", guardarComprobante);
    on("btnCancelarEdit", "click", () => { editId = null; draft = null; render(); });
    on("f_numero", "input", (e) => { draft.numero = e.target.value; clearTimeout(dupTimer); dupTimer = setTimeout(verificarDuplicado, 500); });
    on("f_proveedor", "change", (e) => { draft.proveedorId = e.target.value; verificarDuplicado(); });
    if (draft?.numero?.trim()) verificarDuplicado();
    document.querySelectorAll("input.monto").forEach(wireMonto);
    document.querySelectorAll("input.cuit").forEach(wireCuit);
    if (provNuevoPendiente && showNewProv) {
      const n = document.getElementById("np_nombre"), c = document.getElementById("np_cuit");
      if (n && !n.value) n.value = provNuevoPendiente.nombre;
      if (c && !c.value) c.value = cuitTexto(provNuevoPendiente.cuit);
    }
  }

  if (route === "listado") {
    const busq = on("fBusq", "input", (e) => {
      busqueda = e.target.value;
      clearTimeout(busqTimer);
      busqTimer = setTimeout(buscarNumero, 300);
    });
    renderBusq();
    on("btnDuplicados", "click", buscarDuplicados);
    document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      [desde, hasta] = rangoRapido(b.dataset.range);
      loadComprobantes();
    }));
    // Las fechas se aplican apenas se cambian: así elegir sucursal después no las pierde
    const aplicarFechas = (cambio) => {
      let d = document.getElementById("fDesde").value, h = document.getElementById("fHasta").value;
      if (!d || !h) return;
      if (d > h) { if (cambio === "desde") h = d; else d = h; }   // un solo día si se cruzan
      if (d === desde && h === hasta) return;
      desde = d; hasta = h; loadComprobantes();
    };
    on("fDesde", "change", () => aplicarFechas("desde"));
    on("fHasta", "change", () => aplicarFechas("hasta"));
    on("btnAplicar", "click", () => {
      const d = document.getElementById("fDesde").value, h = document.getElementById("fHasta").value;
      if (!d || !h || d > h) { toast("Revisá el rango de fechas."); return; }
      desde = d; hasta = h; loadComprobantes();
    });
    document.querySelectorAll("[data-suc]").forEach((b) => b.addEventListener("click", () => { sucursalFilter = b.dataset.suc; render(); }));
    document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { listFilter = b.dataset.filter; render(); }));
    document.querySelectorAll("[data-gran]").forEach((b) => b.addEventListener("click", () => { periodGranularity = b.dataset.gran; render(); }));
    on("fProv", "change", (e) => { provFilter = e.target.value; render(); });
    document.querySelectorAll("[data-sfil]").forEach((b) => b.addEventListener("click", () => { sucursalFilter = b.dataset.sfil; render(); }));
    document.querySelectorAll("[data-pfil]").forEach((b) => b.addEventListener("click", () => { provFilter = b.dataset.pfil; render(); }));
    document.querySelectorAll("[data-cgran]").forEach((b) => b.addEventListener("click", () => { chartGran = b.dataset.cgran; render(); }));
    document.querySelectorAll("[data-cver]").forEach((b) => b.addEventListener("click", () => { chartVer = b.dataset.cver; render(); }));
    wireChartTip();
    document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (await eliminarComprobante(b.dataset.del)) render();
    }));
    document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => corregirComprobante(b.dataset.edit)));
    // El reporte sale con los mismos filtros que se ven en pantalla (sucursal, facturado / no facturado, proveedor)
    const datosReporte = () => {
      let list = listaFiltrada();
      const alcance = [esGerente() ? sucursalNombre(state.perfil.sucursal_id)
        : sucursalFilter === "todas" ? "Todas las sucursales" : sucursalNombre(sucursalFilter)];
      if (listFilter === "facturado") { list = list.filter((c) => c.grupo === "FACTURADO"); alcance.push("Solo facturado"); }
      if (listFilter === "nofacturado") { list = list.filter((c) => c.grupo === "NO_FACTURADO"); alcance.push("Solo no facturado"); }
      if (provFilter !== "todos") { list = list.filter((c) => c.proveedor_id === provFilter); alcance.push(proveedorNombre(provFilter)); }
      return { list, desde, hasta, alcance: alcance.join(" · "), proveedorNombre, sucursalNombre, tributoNombre };
    };
    on("btnGenPDF", "click", () => generarReportePDF(datosReporte()));
    on("btnGenXls", "click", async () => {
      try { await generarReporteExcel(datosReporte()); } catch (e) { toast("No se pudo generar el Excel."); console.error(e); }
    });
    on("btnTribAdd", "click", async () => {
      const nombre = document.getElementById("tribNuevo").value.trim();
      if (!nombre) { toast("Escribí el nombre del tributo o tasa."); return; }
      const orden = Math.max(0, ...state.tributos.map((t) => t.orden || 0)) + 1;
      if (await guardarTributo(sb.from("tributos").insert({ nombre, orden }))) toast("Tributo agregado.");
    });
    document.querySelectorAll("[data-tribtoggle]").forEach((b) => b.addEventListener("click", async () => {
      const t = state.tributos.find((x) => x.id === b.dataset.tribtoggle);
      if (t.activo && !(await dialogo(`¿Quitar "${t.nombre}"? Deja de aparecer al cargar; los comprobantes ya cargados lo conservan.`, { aceptar: "Quitar", peligro: true }))) return;
      await guardarTributo(sb.from("tributos").update({ activo: !t.activo }).eq("id", t.id));
    }));
    document.querySelectorAll("[data-tribren]").forEach((b) => b.addEventListener("click", async () => {
      const t = state.tributos.find((x) => x.id === b.dataset.tribren);
      const nombre = (await dialogo("Nuevo nombre:", { aceptar: "Guardar", valor: t.nombre }))?.trim();
      if (!nombre || nombre === t.nombre) return;
      await guardarTributo(sb.from("tributos").update({ nombre }).eq("id", t.id));
    }));
    const input = document.getElementById("importFile");
    on("btnImport", "click", () => input.click());
    input?.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importarBackup(f); });
  }

  if (route === "ventas") {
    const inp = document.getElementById("ventasFile");
    const cargarPdf = async (f) => {
      if (!f) return;
      if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { toast("Tiene que ser el PDF del Libro de IVA Ventas."); return; }
      ventasCargando = true; ventasError = ""; render();
      try { ventasLibro = await leerLibroVentas(f); ventasArchivo = f.name; ventasPV = {}; await detectarSucursalVentas(); }   // cada PDF pregunta de nuevo blanco / negro
      catch (err) { ventasError = err.message || "No se pudo leer el PDF."; console.error(err); }
      ventasCargando = false; render();
    };
    const zona = document.getElementById("ventasDrop");
    zona?.addEventListener("click", () => inp.click());
    zona?.addEventListener("dragover", (e) => { e.preventDefault(); zona.classList.add("encima"); });
    zona?.addEventListener("dragleave", () => zona.classList.remove("encima"));
    zona?.addEventListener("drop", (e) => { e.preventDefault(); zona.classList.remove("encima"); cargarPdf(e.dataTransfer.files[0]); });
    inp?.addEventListener("change", (e) => cargarPdf(e.target.files[0]));
    on("ventasSuc", "change", (e) => { ventasSucursal = e.target.value; render(); });
    on("btnVentasGuardar", "click", guardarVentas);
    document.querySelectorAll("input.monto").forEach(wireMonto);
    on("btnVmGuardar", "click", guardarVentaManual);
    // que lo tipeado no se pierda si otra parte de la pantalla se vuelve a dibujar
    for (const [k, id] of [["fecha", "vmFecha"], ["blanco", "vmBlanco"], ["negro", "vmNegro"], ["iva", "vmIva"], ["sucursal", "vmSuc"]])
      on(id, "input", (e) => { ventasManual[k] = e.target.value; });
    on("vmSuc", "change", (e) => { ventasManual.sucursal = e.target.value; });
    document.querySelectorAll("[data-vmdel]").forEach((b) => b.addEventListener("click", () => eliminarVentaManual(b.dataset.vmdel)));
    document.querySelectorAll("[data-vmedit]").forEach((b) => b.addEventListener("click", () => corregirVentaManual(b.dataset.vmedit)));
    const histFechas = () => {
      const d = document.getElementById("vhDesde").value, h = document.getElementById("vhHasta").value;
      if (!d || !h) return;
      ventasHist = { ...ventasHist, desde: d <= h ? d : h, hasta: d <= h ? h : d, rows: null }; cargarHistVentas();
    };
    on("vhDesde", "change", histFechas);
    on("vhHasta", "change", histFechas);
    document.querySelectorAll("[data-vrango]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.vrango, hoy = new Date();
      const [d, h] = k === "mes" ? monthRange() : k === "año" ? yearRange()
        : [new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1), new Date(hoy.getFullYear(), hoy.getMonth(), 0)].map((x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`);
      ventasHist = { ...ventasHist, desde: d, hasta: h, rows: null }; cargarHistVentas();
    }));
    document.querySelectorAll("[data-vsuc]").forEach((b) => b.addEventListener("click", () => { ventasHist = { ...ventasHist, suc: b.dataset.vsuc, rows: null }; cargarHistVentas(); }));
    on("btnVhPdf", "click", () => generarInformeVentasPDF(datosHistVentas()));
    on("btnCmpPdf", "click", () => generarComparativoPDF(datosComparativo()));
    on("btnCmpXls", "click", async () => {
      try { await generarComparativoExcel(datosComparativo()); } catch (e) { toast("No se pudo generar el Excel."); console.error(e); }
    });
    on("btnVhXls", "click", async () => {
      try { await generarInformeVentasExcel(datosHistVentas()); } catch (e) { toast("No se pudo generar el Excel."); console.error(e); }
    });
    document.querySelectorAll("[data-pv]").forEach((b) => b.addEventListener("click", () => {
      ventasPV = { ...ventasPV, [b.dataset.pv]: b.dataset.lado };
      render();
    }));
    on("btnVentasPdf", "click", () => generarInformeVentasPDF(datosVentas()));
    on("btnVentasXls", "click", async () => {
      try { await generarInformeVentasExcel(datosVentas()); } catch (e) { toast("No se pudo generar el Excel."); console.error(e); }
    });
  }

  if (route === "resultados") {
    const recargar = () => { er.datos = null; cargarResultados(); };
    const periodo = () => {
      const d = document.getElementById("erDesde").value, h = document.getElementById("erHasta").value;
      if (!d || !h) return;
      [er.desde, er.hasta] = d <= h ? [d, h] : [h, d]; recargar();
    };
    on("erDesde", "change", periodo);
    on("erHasta", "change", periodo);
    document.querySelectorAll("[data-errango]").forEach((b) => b.addEventListener("click", () => {
      const m = mesActual(), y = Number(m.slice(0, 4));
      [er.desde, er.hasta] = { mes: [m, m], mesAnt: [mesMas(m, -1), mesMas(m, -1)], tres: [mesMas(m, -2), m],
        año: [y + "-01", m], añoAnt: [(y - 1) + "-01", (y - 1) + "-12"] }[b.dataset.errango];
      recargar();
    }));
    // cambiar sucursal o IVA no necesita volver a traer datos
    document.querySelectorAll("[data-ersuc]").forEach((b) => b.addEventListener("click", () => { er.suc = b.dataset.ersuc; render(); }));
    on("erSinIva", "change", (e) => { er.sinIva = e.target.checked; pintarResultados(); });
    wireResultados();

    // Grilla de gastos
    const irAMes = (m) => {
      if (!m || m > mesActual()) return;
      gx.mes = m;
      const y = Number(m.slice(0, 4));
      if (y !== gx.año) { gx.año = y; gx.rows = null; cargarGastos(); } else render();
    };
    document.querySelectorAll("[data-gxmesnav]").forEach((b) => b.addEventListener("click", () => irAMes(mesMas(gx.mes, Number(b.dataset.gxmesnav)))));
    document.querySelectorAll("[data-gxirmes]").forEach((b) => b.addEventListener("click", () => irAMes(b.dataset.gxirmes)));
    on("gxMesSel", "change", (e) => irAMes(e.target.value));
    document.querySelectorAll("[data-gxvista]").forEach((b) => b.addEventListener("click", () => {
      gx.vista = b.dataset.gxvista;
      if (gx.vista === "mes" && Number(gx.mes.slice(0, 4)) !== gx.año) gx.mes = gx.año === new Date().getFullYear() ? mesActual() : gx.año + "-01";
      render();
    }));
    document.querySelectorAll("[data-gxaño]").forEach((b) => b.addEventListener("click", () => { gx.año = Number(b.dataset.gxaño); gx.rows = null; cargarGastos(); }));
    document.querySelectorAll("[data-gxsuc]").forEach((b) => b.addEventListener("click", () => { gx.suc = b.dataset.gxsuc; render(); }));
    document.querySelectorAll("input.gx-celda").forEach((el) => {
      wireMonto(el);
      el.addEventListener("change", () => guardarCeldaGasto(el));
      el.addEventListener("focus", () => el.select());
      // Enter: misma columna, fila de abajo (como en la planilla)
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const sig = document.querySelector(`input.gx-celda[data-c="${el.dataset.c}"][data-f="${Number(el.dataset.f) + (e.shiftKey ? -1 : 1)}"]`);
        if (sig) sig.focus(); else el.blur();
      });
    });
    document.querySelectorAll("[data-gxcopiar]").forEach((b) => b.addEventListener("click", () => copiarGastosMes(b.dataset.gxcopiar)));
    on("gxLista", "toggle", (e) => { gx.editarLista = e.target.open; });
    const agregar = async () => {
      const inp = document.getElementById("gxNuevo"), nombre = inp.value.trim();
      if (!nombre) { toast("Escribí el nombre del gasto."); inp.focus(); return; }
      const orden = Math.max(0, ...gx.conceptos.map((c) => c.orden)) + 1;
      if (await opConcepto(sb.from("gastos_conceptos").insert({ nombre, orden }), `"${nombre}" agregado a la lista.`))
        document.querySelector(`input.gx-celda[data-gxcat="${CSS.escape(nombre)}"]`)?.focus();   // directo a poner el importe
    };
    on("btnGxAdd", "click", agregar);
    on("gxNuevo", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); agregar(); } });
    document.querySelectorAll("[data-gxren]").forEach((b) => b.addEventListener("click", async () => {
      const c = gx.conceptos.find((x) => x.id === b.dataset.gxren);
      const nombre = (await dialogo(`Nuevo nombre para "${c.nombre}" (los importes ya cargados pasan al nuevo nombre):`, { aceptar: "Renombrar", valor: c.nombre }))?.trim();
      if (!nombre || nombre === c.nombre) return;
      if (await opConcepto(sb.from("gastos_conceptos").update({ nombre }).eq("id", c.id), "Gasto renombrado.")) gastosCambiaron();
    }));
    document.querySelectorAll("[data-gxtoggle]").forEach((b) => b.addEventListener("click", () => {
      const c = gx.conceptos.find((x) => x.id === b.dataset.gxtoggle);
      opConcepto(sb.from("gastos_conceptos").update({ activo: !c.activo }).eq("id", c.id), c.activo ? `"${c.nombre}" quitado de la lista.` : `"${c.nombre}" reactivado.`);
    }));
    document.querySelectorAll("[data-gxmover]").forEach((b) => b.addEventListener("click", async () => {
      const act = gx.conceptos.filter((c) => c.activo), i = act.findIndex((c) => c.id === b.dataset.gxmover), j = i + Number(b.dataset.dir);
      if (j < 0 || j >= act.length) return;
      [act[i], act[j]] = [act[j], act[i]];
      // se renumera toda la lista para que el orden quede firme
      const cambios = act.map((c, k) => ({ id: c.id, orden: k + 1 })).filter((x) => gx.conceptos.find((c) => c.id === x.id).orden !== x.orden);
      const res = await Promise.all(cambios.map((x) => sb.from("gastos_conceptos").update({ orden: x.orden }).eq("id", x.id)));
      await opConcepto(Promise.resolve(res.find((r) => r.error) || {}));
      if (er.datos) pintarResultados();
    }));
  }

  if (route === "arca") {
    const inp = document.getElementById("arcaFile");
    on("btnArcaFile", "click", () => inp.click());
    inp?.addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { arcaFilas = await leerArchivoArca(f); arcaArchivo = f.name; arcaError = ""; arcaRes = null; }
      catch (err) { arcaError = err.message || "No se pudo leer el archivo."; render(); return; }
      compararConArca();
    });
    on("btnArcaRecomparar", "click", compararConArca);
    on("btnArcaPdf", "click", () => generarInformeArca({ res: arcaRes, archivo: arcaArchivo, proveedorNombre, sucursalNombre }));
    on("btnArcaCsv", "click", descargarCsvArca);
    document.querySelectorAll("[data-arcacargar]").forEach((b) => b.addEventListener("click", () => cargarDesdeArca(Number(b.dataset.arcacargar))));
    document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => corregirComprobante(b.dataset.edit)));
  }

  if (route === "proveedores") {
    document.querySelectorAll("input.cuit").forEach(wireCuit);
    on("btnAddProv", "click", async () => {
      const nombre = document.getElementById("pv_nombre").value.trim();
      const cuit = document.getElementById("pv_cuit").value.trim();
      if (!nombre) { toast("Ingresá el nombre del proveedor."); return; }
      if (await crearProveedor(nombre, cuit)) { toast("Proveedor agregado."); render(); }
    });
    document.querySelectorAll("[data-delprov]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await dialogo("¿Eliminar este proveedor?", { aceptar: "Eliminar", peligro: true }))) return;
      const { error } = await sb.from("proveedores").delete().eq("id", b.dataset.delprov);
      if (error) { toast(errorMsg(error, "proveedor")); return; }
      state.proveedores = state.proveedores.filter((p) => p.id !== b.dataset.delprov);
      toast("Proveedor eliminado."); render();
    }));
  }
}

/* ---------- INIT ---------- */
window.addEventListener("hashchange", () => {
  syncDraft();
  route = location.hash.replace("#", "") || "subir";
  if (route === "listado") listLoaded = false; // siempre datos frescos al entrar
  if (route === "resultados") { er.datos = null; er.error = ""; gx.rows = null; gx.error = ""; }
  render();
});

// Al volver a la ventana, refrescar por si se perdió algún evento
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.perfil && route === "listado") loadComprobantes({ silent: true });
  if (document.visibilityState === "visible" && state.perfil && route === "subir") {
    if (hoyDia !== todayISO()) { hoy = []; renderHoy(); }
    loadHoy();
  }
});

if (configOk) {
  // No llamar a Supabase dentro del callback (puede bloquear el cliente): se difiere.
  sb.auth.onAuthStateChange((event, session) => {
    if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT"].includes(event)) setTimeout(() => onSession(session), 0);
    else state.session = session;
  });
} else {
  state.booting = false;
}
render();

