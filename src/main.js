import "./style.css";
import { sb, configOk, fetchAll, errorMsg } from "./supabase.js";
import {
  esc, fmtMoney, fmtDate, todayISO, weekRange, monthRange, yearRange,
  IMPUESTOS, computeTotals, groupBy, groupByPeriod, periodLabel,
  periodKey, periodKeysBetween, periodShort, fmtCompact, parseMonto, formatMontoTexto,
} from "./format.js";
import { generarReportePDF } from "./pdf.js";

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
let ultimoProveedorId = "";   // queda elegido hasta que lo cambien o se cierre la app
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
let chartGran = null;   // null = automático según el rango de fechas
let chartData = null;   // columnas del gráfico, para el tooltip

const esAdmin = () => state.perfil?.rol === "admin";
const esGerente = () => state.perfil?.rol === "gerente";
const veListado = () => esAdmin() || esGerente();   // gerente: solo su sucursal (lo aplica RLS)
const sucursalNombre = (id) => state.sucursales.find((s) => s.id === id)?.nombre || "Sin sucursal";
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

/** Comprobantes cargados hoy por el usuario actual. RLS además los limita al día (hora Argentina). */
async function loadHoy() {
  const d = new Date();
  const medianoche = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const seq = hoyDia = todayISO();
  try {
    const rows = await fetchAll(() =>
      sb.from("comprobantes").select("*")
        .eq("created_by", state.session.user.id)
        .gte("created_at", medianoche)
        .order("created_at", { ascending: false })
    );
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
  // Los eventos de comprobantes llegan al admin y al gerente de esa sucursal (Realtime respeta RLS)
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
    unsubscribeRealtime();
    Object.assign(state, { perfil: null, sucursales: [], proveedores: [], booting: false, bootError: "" });
    comprobantes = []; listLoaded = false; draft = null; ultimoProveedorId = "";
    hoy = []; hoyLoaded = false; clearTimeout(medianocheTimer);
    render(); return;
  }
  if (prevUser === session.user.id && state.perfil) return; // refresh de token
  state.booting = true; state.bootError = ""; render();
  try { await loadBase(); subscribeRealtime(); programarMedianoche(); }
  catch (e) { state.bootError = errorMsg(e); }
  state.booting = false;
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

  if (route === "listado" && !veListado()) route = "subir";
  let body;
  if (route === "listado") body = pageListado();
  else if (route === "proveedores") body = pageProveedores();
  else { route = "subir"; body = pageSubir(); }

  document.body.dataset.mode = route === "subir" && draft ? draft.grupo : "";
  app.innerHTML = shell(body, true, true);
  wireShell();
  wirePage();

  if (route === "listado" && !listLoaded && !listLoading) loadComprobantes();
  if (route === "subir") { if (hoyLoaded) renderHoy(); else loadHoy(); }
}

function shell(bodyHtml, logged, tabs = false) {
  const badge = logged && state.perfil
    ? esAdmin() ? "Administrador"
      : esGerente() ? "Gerente · " + sucursalNombre(state.perfil.sucursal_id)
      : sucursalNombre(state.perfil.sucursal_id)
    : "";
  return `
  <div class="wrap">
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
    </div>` : ""}
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
    fecha: todayISO(), numero: "", monto: "",
    iva21: "", iva105: "", iva27: "", iva5: "", iva25: "", iibb: "", notas: "", tributos: {},
  };
}

function pageSubir() {
  if (!draft) draft = newDraft();
  const d = draft;
  const ivaField = (k, label) => `<div class="field"><label>${label}</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" id="f_${k}" value="${esc(d[k])}" placeholder="0"></div>`;
  return `
  <div class="pagehead"><h1 class="serif">Subir comprobante</h1><p>Cargá los datos del comprobante — sin adjuntar archivos.</p></div>

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
        <div class="field" style="margin-bottom:0;"><label>CUIT</label><input type="text" id="np_cuit" placeholder="30-XXXXXXXX-X"></div>
      </div>
      <div class="newprov-actions">
        <button class="btn small" id="btnGuardarProv">Guardar proveedor</button>
        <button class="btn secondary small" id="btnCancelarProv">Cancelar</button>
      </div>
    </div>` : ""}
  </div>

  <div class="row2">
    <div class="field"><label>Fecha</label><input type="date" id="f_fecha" value="${esc(d.fecha)}"></div>
    <div class="field"><label>Número de comprobante *</label><input type="text" id="f_numero" value="${esc(d.numero)}" placeholder="0001-00012345"></div>
  </div>
  <div class="field"><label>Monto total *</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" id="f_monto" value="${esc(d.monto)}" placeholder="0"></div>

  <div class="section-label">IVA por alícuota — dejá en 0 la que no aplique (ej. medicamento exento)</div>
  <div class="row2">${ivaField("iva21", "IVA 21%")}${ivaField("iva105", "IVA 10,5%")}</div>
  <div class="row2">${ivaField("iva27", "IVA 27%")}${ivaField("iva5", "IVA 5%")}</div>
  ${ivaField("iva25", "IVA 2,5%")}

  <div class="section-label">Otros impuestos</div>
  ${ivaField("iibb", "Ingresos Brutos (Misiones)")}
  ${tributosActivos().length ? `<div class="row2">${tributosActivos().map((t) => `<div class="field"><label>${esc(t.nombre)}</label><input type="text" inputmode="decimal" autocomplete="off" class="monto" data-trib="${t.id}" value="${esc(d.tributos?.[t.id] ?? "")}" placeholder="0"></div>`).join("")}</div>` : ""}

  <div class="field"><label>Notas (opcional)</label><textarea id="f_notas">${esc(d.notas)}</textarea></div>

  <button class="btn" id="btnGuardar" ${saving ? "disabled" : ""}>${saving ? "Guardando…" : "Guardar comprobante"}</button>

  <div class="section-label" style="margin-top:28px;">Cargados hoy</div>
  <div id="hoyList"><div class="loading">Cargando…</div></div>
  `;
}

/** Pinta solo la lista del día, sin re-renderizar el formulario (no pisa lo que se está tipeando). */
function renderHoy() {
  const el = document.getElementById("hoyList");
  if (!el) return;
  if (!hoy.length) {
    el.innerHTML = `<div class="empty-state panel" style="padding:26px 20px;">Todavía no cargaste comprobantes hoy.<br>Se reinicia todos los días a las 00:00.</div>`;
    return;
  }
  const hora = (ts) => new Date(ts).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const iva = (c) => IMPUESTOS.reduce((a, [k]) => a + (Number(c[k]) || 0), 0);
  // Lista simple para revisar de un vistazo: total, IVA e IIBB de cada comprobante (sin suma del día)
  el.innerHTML = `<div class="hoy-wrap"><table class="data-table hoy-table">
    <thead><tr><th>Comprobante</th><th>Total</th><th>IVA</th><th>IIBB</th></tr></thead>
    <tbody>${hoy.map((c) => `<tr>
      <td><span class="${c.grupo === "FACTURADO" ? "fact" : "nofact"}" title="${c.grupo === "FACTURADO" ? "Facturado" : "No facturado"}">●</span> ${esc(proveedorNombre(c.proveedor_id))}
        <small>${hora(c.created_at)} hs · N° ${esc(c.numero)} · ${fmtDate(c.fecha)}${esAdmin() ? " · " + esc(sucursalNombre(c.sucursal_id)) : ""}</small></td>
      <td class="tot">${fmtMoney(c.monto)}</td>
      <td>${fmtMoney(iva(c))}</td>
      <td>${fmtMoney(c.iibb)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function syncDraft() {
  if (route !== "subir" || !draft) return;
  const val = (id) => document.getElementById(id)?.value;
  const map = { sucursalId: "f_sucursal", proveedorId: "f_proveedor", fecha: "f_fecha", numero: "f_numero", monto: "f_monto", notas: "f_notas" };
  for (const [k, id] of Object.entries(map)) { const v = val(id); if (v !== undefined) draft[k] = v; }
  for (const k of ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"]) { const v = val("f_" + k); if (v !== undefined) draft[k] = v; }
  document.querySelectorAll("[data-trib]").forEach((el) => { draft.tributos[el.dataset.trib] = el.value; });
}

async function crearProveedor(nombre, cuit) {
  const { data, error } = await sb.from("proveedores").insert({ nombre, cuit: cuit || null }).select().single();
  if (error) { toast(errorMsg(error, "proveedor")); return null; }
  state.proveedores.push(data);
  state.proveedores.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return data;
}

async function guardarComprobante() {
  syncDraft();
  const d = draft;
  const sucursalId = esAdmin() ? d.sucursalId : state.perfil.sucursal_id;
  if (!sucursalId) { toast("Elegí una sucursal."); return; }
  if (!d.proveedorId) { toast("Elegí o agregá un proveedor."); return; }
  if (!d.numero.trim()) { toast("El número de comprobante es obligatorio."); document.getElementById("f_numero")?.focus(); return; }
  if (!d.monto.trim() || isNaN(parseMonto(d.monto))) { toast("Ingresá el monto total."); return; }
  for (const k of ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"]) {
    if (isNaN(parseMonto(d[k]))) { toast("Revisá los montos de IVA e impuestos."); return; }
  }

  const row = {
    sucursal_id: sucursalId, proveedor_id: d.proveedorId, grupo: d.grupo, fecha: d.fecha,
    numero: d.numero.trim(), monto: parseMonto(d.monto), notas: d.notas.trim() || null,
  };
  for (const k of ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"]) row[k] = parseMonto(d[k]);
  const trib = {};
  for (const [id, v] of Object.entries(d.tributos || {})) {
    const n = parseMonto(v);
    if (isNaN(n)) { toast("Revisá los montos de tributos y tasas."); return; }
    if (n > 0) trib[id] = n;
  }
  if (Object.keys(trib).length) row.tributos = trib;   // solo si hay montos: no depende de la columna si no se usa

  saving = true; render();
  // Sin .select(): el insert no depende de poder leer la fila
  const { error } = await sb.from("comprobantes").insert(row);
  saving = false;
  if (error) { toast(errorMsg(error)); render(); return; }
  hoyLoaded = false;   // render() vuelve a traer el historial del día
  ultimoProveedorId = d.proveedorId;

  draft = null; showNewProv = false; listLoaded = false;
  toast("Comprobante guardado.");
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
  const cols = keys.map((k) => ({ key: k, fact: byKey[k]?.fact || 0, noFact: byKey[k]?.noFact || 0 }));
  chartData = { cols, gran };

  const max = Math.max(0, ...cols.map((c) => c.fact + c.noFact));
  const step = max > 0 ? niceStep(max) : 1;
  const top = max > 0 ? Math.ceil(max / step) * step : 4;
  const ticks = []; for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const pct = (v) => (v / top) * 100;
  const multiYear = desde.slice(0, 4) !== hasta.slice(0, 4);
  const every = Math.max(1, Math.ceil(cols.length / 7));
  const pico = cols.reduce((a, c, i) => (c.fact + c.noFact > cols[a].fact + cols[a].noFact ? i : a), 0);
  const granBtns = [["dia", "Día"], ["semana", "Semana"], ["mes", "Mes"], ["año", "Año"]];

  return `
  <div class="panel chart-panel mb26" id="chartPanel">
    <div class="chart-head">
      <div class="chart-legend"><span><i class="sw fact"></i>Facturado</span><span><i class="sw nofact"></i>No facturado</span></div>
      <div class="filters chart-gran">${granBtns.map(([g, l]) => `<button data-cgran="${g}" class="${gran === g ? "active" : ""}">${l}</button>`).join("")}</div>
    </div>
    <div class="chart">
      <div class="chart-y">${ticks.map((v) => `<span style="bottom:${pct(v)}%">${v ? fmtCompact(v) : "0"}</span>`).join("")}</div>
      <div class="chart-scroll">
        <div class="chart-plot" style="min-width:${cols.length * 10}px">
          <div class="chart-cols">
            ${ticks.map((v) => `<div class="chart-grid" style="bottom:${pct(v)}%"></div>`).join("")}
            ${cols.map((c, i) => {
              const tot = c.fact + c.noFact;
              return `<div class="chart-col" data-ci="${i}" tabindex="0" aria-label="${esc(periodLabel(c.key, gran))}: ${fmtMoney(tot)}">
                <div class="chart-bar" style="height:${pct(tot)}%">
                  ${c.noFact > 0 ? `<div class="seg nofact" style="flex:${c.noFact}"></div>` : ""}
                  ${c.fact > 0 ? `<div class="seg fact" style="flex:${c.fact}"></div>` : ""}
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

/** Aporte de cada proveedor al total (barras horizontales); los más chicos van a "Otros". */
function chartProveedores(list) {
  const TOP = 6;
  const rows = groupBy(list, (c) => c.proveedor_id).map((g) => ({ ...g, tot: g.fact + g.noFact })).sort((a, b) => b.tot - a.tot);
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
      <div class="prov-title">Aporte por proveedor</div>
      <div class="chart-legend"><span><i class="sw fact"></i>Facturado</span><span><i class="sw nofact"></i>No facturado</span></div>
    </div>
    ${shown.map((g) => {
      const nombre = g.key ? proveedorNombre(g.key) : g.nombre;
      return `<${g.key ? `button type="button" data-pfil="${g.key}" title="Ver solo ${esc(nombre)}"` : "div"} class="prov-row">
        <span class="prov-name">${esc(nombre)}</span>
        <span class="prov-bar"><i class="seg fact" style="width:${pct(g.fact)}%"></i><i class="seg nofact" style="width:${pct(g.noFact)}%"></i></span>
        <span class="prov-amt"><b>${fmtMoney(g.tot)}</b> · ${Math.round((g.tot / total) * 100)}%</span>
      </${g.key ? "button" : "div"}>`;
    }).join("")}
    <div class="prov-hint">Tocá un proveedor para ver solo el suyo.</div>
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

  return `
  <div class="pagehead"><h1 class="serif">Listado</h1><p>${esAdmin() ? "Comprobantes de todas las sucursales." : "Comprobantes de " + esc(sucursalNombre(state.perfil.sucursal_id)) + "."}</p></div>

  <div class="panel mb26" style="padding:18px;">
    <div class="filters">
      <button data-range="semana">Esta semana</button>
      <button data-range="mes">Este mes</button>
      <button data-range="año">Este año</button>
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
    </div>
  </div>

  ${listLoading ? `<div class="loading">Cargando comprobantes…</div>` : `
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Facturado (blanco)</div><div class="kpi-value">${fmtMoney(t.fact)}</div></div>
    <div class="kpi"><div class="kpi-label">No facturado (negro)</div><div class="kpi-value">${fmtMoney(t.noFact)}</div></div>
    <div class="kpi"><div class="kpi-label">Total real</div><div class="kpi-value">${fmtMoney(t.total)}</div></div>
  </div>

  <div class="section-label" style="border-top:none; padding-top:0;">Impuestos — para cotejar con tu contador o ARCA</div>
  <div class="panel" style="padding:6px 18px; margin-bottom:12px;">
    <table class="data-table">
      ${IMPUESTOS.map(([k, label]) => `<tr><td>${label}</td><td>${fmtMoney(t[k])}</td></tr>`).join("")}
      <tr class="tot"><td><b>Total IVA</b></td><td><b>${fmtMoney(t.ivaTotal)}</b></td></tr>
      <tr><td>Ingresos Brutos (Misiones)</td><td>${fmtMoney(t.iibb)}</td></tr>
      ${[...new Set([...tributosActivos().map((x) => x.id), ...Object.keys(t.tributos)])]
        .map((id) => `<tr><td>${esc(tributoNombre(id))}</td><td>${fmtMoney(t.tributos[id] || 0)}</td></tr>`).join("")}
    </table>
  </div>
  <div class="total-box mb26">
    <span>Total impuestos</span>
    <span>${fmtMoney(t.impuestosTotal)}</span>
  </div>

  ${esAdmin() && sucursalFilter === "todas" && bySuc.length > 1 ? `
  <div class="section-label" style="border-top:none; padding-top:0;">Por sucursal</div>
  <div class="panel mb26" style="padding:0 18px;">${tablaResumen(bySuc)}</div>` : ""}

  <div class="section-label" style="border-top:none; padding-top:0;">Resumen por período</div>
  <div class="filters">
    ${[["dia", "Día"], ["semana", "Semana"], ["mes", "Mes"], ["año", "Año"]].map(([g, l]) => `<button data-gran="${g}" class="${periodGranularity === g ? "active" : ""}">${l}</button>`).join("")}
  </div>
  ${periods.length
    ? `<div class="panel mb26" style="padding:0 18px;">${tablaResumen(periods, (k) => periodLabel(k, periodGranularity))}</div>`
    : `<div class="empty-state panel mb26">No hay comprobantes en este período.</div>`}

  <div class="section-label" style="border-top:none; padding-top:0;">Historial</div>
  <div class="filters">
    <button data-filter="todos" class="${listFilter === "todos" ? "active" : ""}">Todos</button>
    <button data-filter="facturado" class="${listFilter === "facturado" ? "active" : ""}">Facturado</button>
    <button data-filter="nofacturado" class="${listFilter === "nofacturado" ? "active" : ""}">No facturado</button>
  </div>
  <div class="field" style="margin-bottom:12px;">
    <label>Proveedor</label>
    <select id="fProv">
      <option value="todos">Todos los proveedores</option>
      ${provOpts.map((p) => `<option value="${p.id}" ${provFilter === p.id ? "selected" : ""}>${esc(p.nombre)} (${p.n})</option>`).join("")}
    </select>
  </div>
  ${hist.length ? `
  <div class="total-box" style="margin-bottom:${listFilter === "todos" ? "10px" : "16px"};">
    <span>Total${provFilter !== "todos" ? " · " + esc(proveedorNombre(provFilter)) : ""}<small class="total-sub">${hist.length} comprobante${hist.length === 1 ? "" : "s"}${ht.impuestosTotal > 0 ? " · Impuestos " + fmtMoney(ht.impuestosTotal) : ""}</small></span>
    <span>${fmtMoney(ht.total)}</span>
  </div>
  ${listFilter === "todos" ? `
  <div class="total-split mb16">
    <span><i class="sw fact"></i>Facturado <b>${fmtMoney(ht.fact)}</b></span>
    <span><i class="sw nofact"></i>No facturado <b>${fmtMoney(ht.noFact)}</b></span>
  </div>
  ${chartCompras(hist)}` : ""}
  ${provFilter === "todos" ? chartProveedores(hist) : ""}` : ""}
  ${hist.length ? hist.map((c) => {
    const imp = ["iva21", "iva105", "iva27", "iva5", "iva25", "iibb"].reduce((a, k) => a + (Number(c[k]) || 0), 0) + sumTributos(c);
    return `<div class="card">
      <div class="card-icon">🧾</div>
      <div class="card-body">
        <div class="card-title">${esc(proveedorNombre(c.proveedor_id))}</div>
        <div class="card-sub">${fmtDate(c.fecha)} · N° ${esc(c.numero)} · ${esc(sucursalNombre(c.sucursal_id))}</div>
        <div class="${c.grupo === "FACTURADO" ? "tag fact dot" : "tag nofact dot"}">${c.grupo === "FACTURADO" ? "Facturado" : "No facturado"}</div>
        ${imp > 0 ? `<div class="card-sub" style="margin-top:4px;">Impuestos: ${fmtMoney(imp)}</div>` : ""}
        ${c.notas ? `<div class="card-sub" style="margin-top:4px;">${esc(c.notas)}</div>` : ""}
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:8px;">
        <div class="card-amount">${fmtMoney(c.monto)}</div>
        ${esAdmin() ? `<button class="btn secondary small" data-del="${c.id}">Eliminar</button>` : ""}
      </div>
    </div>`;
  }).join("") : `<div class="empty-state panel"><span class="serif">Sin comprobantes</span>No hay comprobantes para este filtro.</div>`}
  `}

  ${esAdmin() ? seccionTributos() : ""}

  ${esAdmin() ? `<div class="section-label">Migrar datos de la versión anterior</div>
  <div class="filters">
    <button id="btnImport">📤 Importar copia de seguridad (.json)</button>
    <input type="file" id="importFile" accept="application/json" style="display:none;">
  </div>
  <div class="hint">Subí las copias descargadas desde el Facturero anterior (una por sucursal). Los comprobantes repetidos se ignoran.</div>` : ""}
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

  if (!confirm(`Se van a importar ${incoming.comprobantes.length} comprobantes y ${incoming.proveedores.length} proveedores. Los repetidos se ignoran. ¿Continuar?`)) return;
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
function pageProveedores() {
  return `
  <div class="pagehead"><h1 class="serif">Proveedores</h1><p>Agregá los proveedores una vez y quedan disponibles para todas las sucursales.</p></div>
  <div class="panel" style="margin-bottom:20px;">
    <div class="row2">
      <div class="field" style="margin-bottom:12px;"><label>Nombre</label><input type="text" id="pv_nombre" placeholder="Ej: Droguería del Sud"></div>
      <div class="field" style="margin-bottom:12px;"><label>CUIT</label><input type="text" id="pv_cuit" placeholder="30-XXXXXXXX-X"></div>
    </div>
    <button class="btn small" id="btnAddProv">+ Agregar proveedor</button>
  </div>
  ${state.proveedores.length ? state.proveedores.map((p) => `
    <div class="card">
      <div class="card-icon">🏷</div>
      <div class="card-body">
        <div class="card-title">${esc(p.nombre)}</div>
        <div class="card-sub">${p.cuit ? "CUIT " + esc(p.cuit) : "Sin CUIT cargado"}</div>
      </div>
      ${esAdmin() ? `<button class="btn secondary small" data-delprov="${p.id}">Eliminar</button>` : ""}
    </div>`).join("") : `<div class="empty-state panel"><span class="serif">Sin proveedores</span>Agregá el primero arriba.</div>`}
  `;
}

/* ---------- WIRE ---------- */
function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); return el; }

function wireLogin() {
  on("loginForm", "submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("btnLogin"); btn.disabled = true; btn.textContent = "Entrando…";
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
      <div><i class="sw fact"></i>Facturado <b>${fmtMoney(c.fact)}</b></div>
      <div><i class="sw nofact"></i>No facturado <b>${fmtMoney(c.noFact)}</b></div>
      <div class="tip-tot">Total <b>${fmtMoney(c.fact + c.noFact)}</b></div>`;
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
  if (route === "subir") {
    document.querySelectorAll("#grupoToggle button").forEach((btn) =>
      btn.addEventListener("click", () => { syncDraft(); draft.grupo = btn.dataset.grupo; render(); }));
    on("btnNuevoProv", "click", () => { syncDraft(); showNewProv = !showNewProv; render(); if (showNewProv) document.getElementById("np_nombre")?.focus(); });
    on("btnCancelarProv", "click", () => { syncDraft(); showNewProv = false; render(); });
    on("btnGuardarProv", "click", async () => {
      const nombre = document.getElementById("np_nombre").value.trim();
      const cuit = document.getElementById("np_cuit").value.trim();
      if (!nombre) { toast("Ingresá el nombre del proveedor."); return; }
      syncDraft();
      const p = await crearProveedor(nombre, cuit);
      if (!p) return;
      draft.proveedorId = p.id; showNewProv = false;
      toast("Proveedor agregado."); render();
    });
    on("btnGuardar", "click", guardarComprobante);
    document.querySelectorAll("input.monto").forEach(wireMonto);
  }

  if (route === "listado") {
    document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      const r = b.dataset.range;
      [desde, hasta] = r === "semana" ? weekRange() : r === "mes" ? monthRange() : yearRange();
      loadComprobantes();
    }));
    on("btnAplicar", "click", () => {
      const d = document.getElementById("fDesde").value, h = document.getElementById("fHasta").value;
      if (!d || !h || d > h) { toast("Revisá el rango de fechas."); return; }
      desde = d; hasta = h; loadComprobantes();
    });
    document.querySelectorAll("[data-suc]").forEach((b) => b.addEventListener("click", () => { sucursalFilter = b.dataset.suc; render(); }));
    document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { listFilter = b.dataset.filter; render(); }));
    document.querySelectorAll("[data-gran]").forEach((b) => b.addEventListener("click", () => { periodGranularity = b.dataset.gran; render(); }));
    on("fProv", "change", (e) => { provFilter = e.target.value; render(); });
    document.querySelectorAll("[data-pfil]").forEach((b) => b.addEventListener("click", () => { provFilter = b.dataset.pfil; render(); }));
    document.querySelectorAll("[data-cgran]").forEach((b) => b.addEventListener("click", () => { chartGran = b.dataset.cgran; render(); }));
    wireChartTip();
    document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este comprobante?")) return;
      const { error } = await sb.from("comprobantes").delete().eq("id", b.dataset.del);
      if (error) { toast(errorMsg(error)); return; }
      comprobantes = comprobantes.filter((c) => c.id !== b.dataset.del);
      toast("Comprobante eliminado."); render();
    }));
    on("btnGenPDF", "click", () => {
      generarReportePDF({
        list: listaFiltrada(), desde, hasta,
        alcance: esGerente() ? sucursalNombre(state.perfil.sucursal_id)
          : sucursalFilter === "todas" ? "Todas las sucursales" : sucursalNombre(sucursalFilter),
        proveedorNombre, sucursalNombre, tributoNombre,
      });
    });
    on("btnTribAdd", "click", async () => {
      const nombre = document.getElementById("tribNuevo").value.trim();
      if (!nombre) { toast("Escribí el nombre del tributo o tasa."); return; }
      const orden = Math.max(0, ...state.tributos.map((t) => t.orden || 0)) + 1;
      if (await guardarTributo(sb.from("tributos").insert({ nombre, orden }))) toast("Tributo agregado.");
    });
    document.querySelectorAll("[data-tribtoggle]").forEach((b) => b.addEventListener("click", async () => {
      const t = state.tributos.find((x) => x.id === b.dataset.tribtoggle);
      if (t.activo && !confirm(`¿Quitar "${t.nombre}"? Deja de aparecer al cargar; los comprobantes ya cargados lo conservan.`)) return;
      await guardarTributo(sb.from("tributos").update({ activo: !t.activo }).eq("id", t.id));
    }));
    document.querySelectorAll("[data-tribren]").forEach((b) => b.addEventListener("click", async () => {
      const t = state.tributos.find((x) => x.id === b.dataset.tribren);
      const nombre = prompt("Nuevo nombre:", t.nombre)?.trim();
      if (!nombre || nombre === t.nombre) return;
      await guardarTributo(sb.from("tributos").update({ nombre }).eq("id", t.id));
    }));
    const input = document.getElementById("importFile");
    on("btnImport", "click", () => input.click());
    input?.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importarBackup(f); });
  }

  if (route === "proveedores") {
    on("btnAddProv", "click", async () => {
      const nombre = document.getElementById("pv_nombre").value.trim();
      const cuit = document.getElementById("pv_cuit").value.trim();
      if (!nombre) { toast("Ingresá el nombre del proveedor."); return; }
      if (await crearProveedor(nombre, cuit)) { toast("Proveedor agregado."); render(); }
    });
    document.querySelectorAll("[data-delprov]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este proveedor?")) return;
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
