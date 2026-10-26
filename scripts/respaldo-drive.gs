/* =====================================================================
   Facturero — respaldo automático a Google Drive (Google Apps Script)

   Todas las noches pide a Supabase la copia completa en UNA sola consulta,
   arma el mismo .zip de CSV que el botón "Descargar copia (.zip)" y lo guarda
   en la carpeta "Facturero - Respaldos" de tu Drive.
   - Si nada cambió desde la última copia, no guarda otra.
   - Cada copia es completa (con las correcciones del día), en una sola carpeta y sin subcarpetas.
   - Guarda las copias de los últimos 7 días, una por mes de los últimos 12 meses y,
     de los años anteriores, una por año (la última, con el año cerrado): unos 20 archivos
     más uno por año. Las demás van a la papelera de Drive.
   - Si algo falla, Google te manda un mail.

   Instalación (una sola vez): ver README.md > "Respaldo automático a Google Drive".
   Si cambiás columnas, nombres de archivo o el formato de las celdas, cambialo
   también en src/respaldo.js.
   ===================================================================== */

const CARPETA = "Facturero - Respaldos";
const GUARDAR_DIAS = 7;     // últimas copias diarias
const GUARDAR_MESES = 12;   // y la primera de cada uno de los últimos meses
const ZONA = "America/Argentina/Buenos_Aires";
const FORMATO = "facturero-respaldo-v1";

const TABLAS = {
  sucursales: ["sucursales.csv", ["id", "nombre", "pv_blanco", "created_at"]],
  proveedores: ["proveedores.csv", ["id", "nombre", "cuit", "created_by", "created_at"]],
  tributos: ["otros_tributos.csv", ["id", "nombre", "activo", "orden", "created_at"]],
  gastos_conceptos: ["lista_de_gastos.csv", ["id", "nombre", "activo", "orden", "created_at"]],
  comprobantes: ["comprobantes.csv", ["id", "fecha", "sucursal_id", "proveedor_id", "grupo", "tipo", "numero", "factura_ref", "monto",
    "iva21", "iva105", "iva27", "iva5", "iva25", "iibb", "tributos", "notas", "cargado_por", "created_by", "created_at"]],
  ventas_diarias: ["ventas.csv", ["id", "fecha", "sucursal_id", "pv", "lado", "origen", "comprobantes", "notas_credito", "total", "nc_total",
    "neto", "exento", "percep", "iva105", "iva21", "iva_otros", "archivo", "created_by", "created_at"]],
  costos_fijos: ["gastos_operativos.csv", ["id", "mes", "sucursal_id", "categoria", "concepto", "monto", "created_by", "created_at"]],
};

/** Lo ejecuta el activador todas las noches (también se puede correr a mano). */
function respaldar() {
  const props = PropertiesService.getScriptProperties();
  const datos = pedirDatos(props);

  const csv = {};
  for (const [t, [archivo, cols]] of Object.entries(TABLAS)) {
    const filas = datos[t] || [];
    const extra = [...new Set(filas.flatMap((f) => Object.keys(f)))].filter((c) => !cols.includes(c));
    csv[archivo] = aCsv(filas, [...cols, ...extra]);
  }

  // Sin cambios desde la última copia: no se guarda otra igual
  const firma = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Object.values(csv).join("\n"), Utilities.Charset.UTF_8));
  if (firma === props.getProperty("ULTIMA_FIRMA")) { console.log("Sin cambios desde la última copia."); return; }

  const blobs = [Utilities.newBlob(leame(datos), "text/plain", "LEAME.txt")]
    .concat(Object.entries(csv).map(([n, texto]) => Utilities.newBlob(texto, "text/csv", n)));
  const nombre = `facturero-respaldo-${Utilities.formatDate(new Date(), ZONA, "yyyy-MM-dd")}.zip`;
  const carpeta = carpetaRespaldos();
  const viejo = carpeta.getFilesByName(nombre);   // si se corre dos veces el mismo día, queda la última
  while (viejo.hasNext()) viejo.next().setTrashed(true);
  const zip = carpeta.createFile(Utilities.zip(blobs, nombre));

  props.setProperty("ULTIMA_FIRMA", firma);
  console.log(`Guardado ${nombre} (${Math.round(zip.getSize() / 1024)} KB): ${datos.comprobantes.length} comprobantes.`);
  limpiar(carpeta);
}

/** Crea el activador diario (entre las 3 y las 4 de la mañana). Correrlo una sola vez. */
function instalar() {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "respaldar") ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger("respaldar").timeBased().everyDays(1).atHour(3).inTimezone(ZONA).create();
  respaldar();
  console.log("Listo: el respaldo corre solo todas las noches.");
}

function pedirDatos(props) {
  const url = (props.getProperty("SUPABASE_URL") || "").replace(/\/+$/, "");
  const clave = props.getProperty("SUPABASE_SECRET_KEY") || "";
  if (!url || !clave) throw new Error("Faltan SUPABASE_URL o SUPABASE_SECRET_KEY en Configuración del proyecto > Propiedades de la secuencia de comandos.");
  const headers = { apikey: clave };
  if (!clave.startsWith("sb_")) headers.Authorization = "Bearer " + clave;   // clave service_role vieja (JWT)
  const res = UrlFetchApp.fetch(url + "/rest/v1/rpc/respaldo_datos", {
    method: "post", contentType: "application/json", payload: "{}", headers, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error(`Supabase respondió ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  const datos = JSON.parse(res.getContentText());
  if (datos.formato !== FORMATO) throw new Error("Respuesta inesperada de Supabase (¿falta correr la migración 018?).");
  return datos;
}

function carpetaRespaldos() {
  const it = DriveApp.getFoldersByName(CARPETA);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CARPETA);
}

/** Deja las últimas GUARDAR_DIAS copias, la primera de cada uno de los últimos GUARDAR_MESES meses
    y la última de cada año; el resto va a la papelera. */
function limpiar(carpeta) {
  const copias = [];
  const it = carpeta.getFiles();
  while (it.hasNext()) {
    const f = it.next(), m = f.getName().match(/^facturero-respaldo-((\d{4})-\d{2})-\d{2}\.zip$/);
    if (m) copias.push({ f, nombre: f.getName(), mes: m[1], anio: m[2] });
  }
  copias.sort((a, b) => b.nombre.localeCompare(a.nombre));   // más nueva primero
  const primeraDelMes = {}, ultimaDelAnio = {};
  for (const c of copias) {
    primeraDelMes[c.mes] = c.nombre;                  // queda la más vieja de cada mes
    if (!ultimaDelAnio[c.anio]) ultimaDelAnio[c.anio] = c.nombre;   // y la más nueva de cada año
  }
  const meses = [...new Set(copias.map((c) => c.mes))].slice(0, GUARDAR_MESES);
  copias.forEach((c, i) => {
    const mensual = primeraDelMes[c.mes] === c.nombre && meses.includes(c.mes);
    const anual = ultimaDelAnio[c.anio] === c.nombre;
    if (i >= GUARDAR_DIAS && !mensual && !anual) c.f.setTrashed(true);
  });
}

/* ---------- Igual que en src/respaldo.js ---------- */
function celda(v) {
  if (v == null) return "";
  const s = typeof v === "number" ? String(v).replace(".", ",") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[;"\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function aCsv(filas, columnas) {
  return "﻿" + [columnas.join(";"), ...filas.map((f) => columnas.map((c) => celda(f[c])).join(";"))].join("\r\n") + "\r\n";
}

function leame(datos) {
  return [
    "Facturero - Copia de respaldo",
    "",
    `Formato: ${FORMATO}`,
    `Generado: ${datos.generado}`,
    `Fecha: ${Utilities.formatDate(new Date(datos.generado), ZONA, "dd/MM/yyyy, HH:mm:ss")}`,
    "",
    "Cada archivo .csv es una tabla. Se abren con Excel o con el Bloc de notas.",
    "Para volver a cargar la copia: Facturero > Listado > Herramientas del administrador > Restaurar desde copia,",
    "y elegí este mismo .zip (sin descomprimir). Solo se agrega lo que falta: no se duplica ni se pisa nada.",
    "No modifiques los .csv si después vas a restaurar la copia.",
    "",
    ...Object.entries(TABLAS).map(([t, [archivo]]) => `${archivo}: ${(datos[t] || []).length} filas`),
    "",
  ].join("\r\n");
}
