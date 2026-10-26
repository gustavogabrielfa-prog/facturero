/* Copia liviana: un ZIP con un CSV por tabla (se abre en Excel y en el Bloc de notas) y restaurar desde esa copia.
   El respaldo automático a Google Drive (scripts/respaldo-drive.gs) arma el mismo ZIP: si cambiás columnas,
   nombres de archivo o el formato de las celdas acá, cambialo también allá. */
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { sb } from "./supabase.js";

export const FORMATO = "facturero-respaldo-v1";

// Tabla de la base -> archivo dentro del ZIP y orden de las columnas (si aparece otra columna, va al final)
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
// Al leer: columnas con números (en el CSV van con coma decimal) y con JSON
const NUMEROS = new Set(["monto", "iva21", "iva105", "iva27", "iva5", "iva25", "iibb", "orden", "comprobantes", "notas_credito",
  "total", "nc_total", "neto", "exento", "percep", "iva_otros"]);
const JSONS = new Set(["tributos"]);

/* ---------- CSV: separado por ; y con coma decimal, como lo abre Excel en español ---------- */
function celda(v) {
  if (v == null) return "";
  const s = typeof v === "number" ? String(v).replace(".", ",") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[;"\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function aCsv(filas, columnas) {
  // ﻿: para que Excel reconozca los acentos y la ñ
  return "﻿" + [columnas.join(";"), ...filas.map((f) => columnas.map((c) => celda(f[c])).join(";"))].join("\r\n") + "\r\n";
}

function leerCsv(texto) {
  texto = texto.replace(/^﻿/, "");
  const filas = [];
  let fila = [], campo = "", comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch !== '"') campo += ch;
      else if (texto[i + 1] === '"') { campo += '"'; i++; }
      else comillas = false;
    } else if (ch === '"') comillas = true;
    else if (ch === ";") { fila.push(campo); campo = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += ch;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab = [], ...resto] = filas;
  return resto.filter((f) => f.some((x) => x !== "")).map((f) => Object.fromEntries(cab.map((c, i) => [c, f[i] ?? ""])));
}

function valor(col, s) {
  if (s === "") return null;
  if (NUMEROS.has(col)) return Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  if (JSONS.has(col)) return JSON.parse(s);
  return s;
}

/* ---------- ZIP ---------- */
const hoyIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function leame(datos) {
  const generado = new Date(datos.generado);
  return [
    "Facturero - Copia de respaldo",
    "",
    `Formato: ${FORMATO}`,
    `Generado: ${datos.generado}`,
    `Fecha: ${generado.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}`,
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

export function armarZip(datos) {
  const archivos = { "LEAME.txt": strToU8(leame(datos)) };
  for (const [t, [archivo, cols]] of Object.entries(TABLAS)) {
    const filas = datos[t] || [];
    const extra = [...new Set(filas.flatMap((f) => Object.keys(f)))].filter((c) => !cols.includes(c));
    archivos[archivo] = strToU8(aCsv(filas, [...cols, ...extra]));
  }
  return zipSync(archivos, { level: 9 });
}

/** Trae todo en una sola consulta y descarga el ZIP. */
export async function descargarRespaldo() {
  const { data, error } = await sb.rpc("respaldo_datos");
  if (error) throw error;
  const zip = armarZip(data);
  const nombre = `facturero-respaldo-${hoyIso()}.zip`;
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  Object.assign(document.createElement("a"), { href: url, download: nombre }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { nombre, kb: Math.max(1, Math.round(zip.length / 1024)), comprobantes: data.comprobantes.length };
}

/** Lee el ZIP (aunque esté dentro de una carpeta) y lo deja listo para restaurar_respaldo. */
export async function leerRespaldo(file) {
  let crudo;
  try { crudo = unzipSync(new Uint8Array(await file.arrayBuffer())); }
  catch { throw new Error("El archivo no es un .zip de copia de Facturero."); }
  const archivos = Object.fromEntries(Object.entries(crudo).map(([n, b]) => [n.split("/").pop(), b]));
  const texto = archivos["LEAME.txt"] ? strFromU8(archivos["LEAME.txt"]) : "";
  if (!texto.includes(FORMATO) || !archivos["comprobantes.csv"]) throw new Error("El archivo no es una copia de Facturero (falta LEAME.txt o comprobantes.csv).");

  const p = { formato: FORMATO, generado: texto.match(/^Generado: (.+)$/m)?.[1]?.trim() || null };
  for (const [t, [archivo]] of Object.entries(TABLAS)) {
    const bytes = archivos[archivo];
    p[t] = bytes ? leerCsv(strFromU8(bytes)).map((f) => Object.fromEntries(Object.entries(f).map(([c, s]) => [c, valor(c, s)]))) : [];
  }
  return p;
}

/** Con simular = true no guarda nada: devuelve cuánto se agregaría. */
export async function restaurarRespaldo(p, simular) {
  const { data, error } = await sb.rpc("restaurar_respaldo", { p, p_simular: simular });
  if (error) throw error;
  return data;
}
