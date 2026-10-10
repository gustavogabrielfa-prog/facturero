import { numeroNorm, signo, IMPUESTOS } from "./format.js";

/* ---------- Lectura del archivo de "Mis Comprobantes" (Recibidos) de ARCA ---------- */

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const soloDigitos = (s) => String(s ?? "").replace(/\D/g, "");

/** CSV con ; , o tabulador, respetando comillas. */
function parseCSV(texto) {
  const primera = texto.split(/\r?\n/).find((l) => l.trim()) || "";
  const sep = [";", "\t", ","].map((c) => [c, primera.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const filas = [];
  let fila = [], campo = "", comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (ch === '"') comillas = false;
      else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) { fila.push(campo); campo = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += ch;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

/** "154.232,91", "154232.91", 154232.91 -> 154232.91 */
function numero(v) {
  if (typeof v === "number") return v;
  let t = String(v ?? "").replace(/[\s$]/g, "");
  if (!t) return 0;
  const coma = t.lastIndexOf(","), punto = t.lastIndexOf(".");
  if (coma > -1 && punto > -1) t = coma > punto ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (coma > -1) t = t.replace(/\./g, "").replace(",", ".");
  else if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, "");
  const n = Number(t);
  return isNaN(n) ? 0 : n;
}

/** "03/10/2026", "2026-10-03" o número de serie de Excel -> "2026-10-03" */
function fecha(v) {
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return d.toISOString().slice(0, 10);
  }
  const t = String(v ?? "").trim();
  let m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

const COLUMNAS = {
  fecha: [/^fecha/],
  tipo: [/tipo de comprobante/, /^tipo$/, /^tipo cbte/],
  pv: [/punto de venta/, /^pto\.? ?vta/],
  num: [/numero desde/, /nro\.? desde/, /^numero$/, /^nro\.? comprobante/],
  cuit: [/nro\.? doc\.? emisor/, /numero doc.* emisor/, /cuit emisor/, /nro\. doc\. emisor/],
  nombre: [/denominacion emisor/, /razon social/],
  total: [/imp\.? total/, /importe total/],
  iva: [/^iva$/, /^imp\.? iva$/, /^total iva$/],
  moneda: [/^moneda/],
  cambio: [/tipo (de )?cambio/],
};

function mapearColumnas(encabezado) {
  const h = encabezado.map(norm);
  const col = {};
  for (const [k, pats] of Object.entries(COLUMNAS)) {
    for (const p of pats) { const i = h.findIndex((x) => p.test(x)); if (i > -1) { col[k] = i; break; } }
  }
  return col;
}

/** Devuelve { filas, avisos } con un objeto por comprobante de ARCA. */
export async function leerArchivoArca(file) {
  let filas;
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
  } else {
    filas = parseCSV(await file.text());
  }

  const iEnc = filas.findIndex((f) => {
    const h = f.map(norm);
    return h.some((x) => /punto de venta|pto\.? ?vta/.test(x)) && h.some((x) => /doc\.? emisor|cuit emisor/.test(x));
  });
  if (iEnc < 0) throw new Error("No reconozco el archivo. Tiene que ser el que exporta ARCA en Mis Comprobantes → Recibidos.");
  const col = mapearColumnas(filas[iEnc]);
  for (const k of ["fecha", "pv", "num", "cuit", "total"]) {
    if (col[k] === undefined) throw new Error("Al archivo le falta la columna de " + { fecha: "fecha", pv: "punto de venta", num: "número", cuit: "CUIT del emisor", total: "importe total" }[k] + ".");
  }

  const out = [];
  for (const f of filas.slice(iEnc + 1)) {
    const cuit = soloDigitos(f[col.cuit]);
    const pv = soloDigitos(f[col.pv]), num = soloDigitos(f[col.num]);
    if (cuit.length !== 11 || !pv || !num) continue;
    const tipoTexto = col.tipo !== undefined ? String(f[col.tipo]).trim() : "";
    const codigo = parseInt(tipoTexto, 10);
    const nc = /cr[eé]dito/i.test(tipoTexto) || [3, 8, 13, 53, 203, 208, 213].includes(codigo);
    const moneda = col.moneda !== undefined ? norm(f[col.moneda]) : "";
    const cambio = col.cambio !== undefined ? numero(f[col.cambio]) || 1 : 1;
    const mult = moneda && !/^(pes|\$|ars)/.test(moneda) ? cambio : 1;   // comprobantes en moneda extranjera a pesos
    out.push({
      fecha: fecha(f[col.fecha]),
      tipoTexto: tipoTexto.replace(/^\d+\s*-\s*/, "") || (nc ? "Nota de crédito" : "Factura"),
      nc, pv, num, cuit,
      nombre: col.nombre !== undefined ? String(f[col.nombre]).trim() : "",
      total: Math.abs(numero(f[col.total])) * mult,
      iva: col.iva !== undefined && String(f[col.iva]).trim() !== "" ? Math.abs(numero(f[col.iva])) * mult : null,
    });
  }
  if (!out.length) throw new Error("El archivo no tiene comprobantes.");
  return out;
}

/* ---------- Comparación con lo cargado en Facturero ---------- */

const TOL = 1;   // diferencias de hasta $1 se consideran redondeo
const cuitDe = (p) => soloDigitos(p?.cuit);
const claveArca = (a) => `${a.cuit}|${a.nc ? "NC" : "F"}|${numeroNorm(`${a.pv}-${a.num}`)}`;
const ivaDe = (c) => IMPUESTOS.reduce((s, [k]) => s + (Number(c[k]) || 0), 0);

/** Rango de fechas que cubre el archivo. */
export function rangoArca(filas) {
  const f = filas.map((a) => a.fecha).filter(Boolean).sort();
  return [f[0], f[f.length - 1]];
}

/**
 * @returns {{desde, hasta, ok, dif, revisar, falta, noArca, provSinCuit}}
 *  ok/dif/revisar: { a (fila ARCA), c (comprobante) , detalle }
 *  falta: { a } · noArca: { c }
 */
export function compararArca(filasArca, comprobantes, proveedores) {
  const [desde, hasta] = rangoArca(filasArca);
  const provById = Object.fromEntries(proveedores.map((p) => [p.id, p]));
  const facturados = comprobantes.filter((c) => c.grupo === "FACTURADO");
  const provSinCuit = [...new Set(facturados.filter((c) => !cuitDe(provById[c.proveedor_id])).map((c) => c.proveedor_id))];

  const porClave = {};
  for (const c of facturados) {
    const cuit = cuitDe(provById[c.proveedor_id]);
    if (!cuit) continue;
    const k = `${cuit}|${c.tipo === "NOTA_CREDITO" ? "NC" : "F"}|${numeroNorm(c.numero)}`;
    (porClave[k] ||= []).push(c);
  }
  const usados = new Set();
  const ok = [], dif = [], revisar = [], falta = [];

  const diferencias = (a, c) => {
    const d = [];
    if (Math.abs(Number(c.monto) - a.total) > TOL) d.push(`Total: ARCA ${a.total.toFixed(2)} / Facturero ${Number(c.monto).toFixed(2)}`);
    if (a.iva !== null && Math.abs(ivaDe(c) - a.iva) > TOL) d.push(`IVA: ARCA ${a.iva.toFixed(2)} / Facturero ${ivaDe(c).toFixed(2)}`);
    return d;
  };

  const pendientes = [];
  for (const a of filasArca) {
    const c = (porClave[claveArca(a)] || []).find((x) => !usados.has(x.id));
    if (!c) { pendientes.push(a); continue; }
    usados.add(c.id);
    const d = diferencias(a, c);
    (d.length ? dif : ok).push({ a, c, detalle: d });
  }

  // Segunda pasada: mismo proveedor, mismo total y el número termina igual (punto de venta mal cargado o faltante)
  for (const a of pendientes) {
    const n = String(Number(a.num));
    const c = facturados.find((x) => !usados.has(x.id)
      && cuitDe(provById[x.proveedor_id]) === a.cuit
      && (x.tipo === "NOTA_CREDITO") === a.nc
      && soloDigitos(x.numero).replace(/^0+/, "").endsWith(n)
      && Math.abs(Number(x.monto) - a.total) <= TOL);
    if (c) { usados.add(c.id); revisar.push({ a, c, detalle: [`Número: ARCA ${a.pv}-${a.num} / Facturero ${c.numero}`] }); }
    else falta.push({ a });
  }

  const noArca = facturados
    .filter((c) => !usados.has(c.id) && c.fecha >= desde && c.fecha <= hasta)
    .map((c) => ({ c }));

  return { desde, hasta, ok, dif, revisar, falta, noArca, provSinCuit };
}

/** Importe con signo de un comprobante de Facturero (para el informe). */
export const montoFacturero = (c) => signo(c) * Number(c.monto);
