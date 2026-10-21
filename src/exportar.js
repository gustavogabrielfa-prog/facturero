/* Copia completa en Excel: todos los datos (con nombres, no códigos) + el estado de resultados.
   Sirve para trabajar en Excel / Google Sheets, como respaldo y para volver a cargarla si hiciera falta. */
import { sb, fetchAll } from "./supabase.js";
import { estadoResultados, mesesEntre, mesLabel } from "./resultados.js";

export const VERSION_EXPORT = "facturero-copia-v1";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fecha = (iso) => (iso ? new Date(iso.slice(0, 10) + "T00:00:00") : "");

/** Trae todo lo que el administrador puede ver. */
async function traerTodo() {
  const todo = (t, orden) => fetchAll(() => sb.from(t).select("*").order(orden));
  const [sucursales, proveedores, comprobantes, tributos, ventas, costos, conceptos] = await Promise.all([
    todo("sucursales", "nombre"), todo("proveedores", "nombre"), todo("comprobantes", "fecha"), todo("tributos", "orden"),
    todo("ventas_diarias", "fecha"), todo("costos_fijos", "mes"), todo("gastos_conceptos", "orden"),
  ]);
  return { sucursales, proveedores, comprobantes, tributos, ventas, costos, conceptos };
}

/** Bloques del estado de resultados (cada sucursal + total), mes por mes, con cada gasto. */
function hojaResultado(XLSX, d, meses) {
  const ids = d.sucursales.map((s) => s.id), orden = d.conceptos.map((c) => c.nombre);
  const base = { ventas: d.ventas, compras: d.comprobantes, costos: d.costos, meses, sucursalIds: ids, sinIva: false, orden };
  const bloques = [...d.sucursales.map((s) => [s.nombre, estadoResultados({ ...base, foco: s.id })]), ["Total de las farmacias", estadoResultados({ ...base, foco: "todas" })]];
  const aoa = [["Facturero — Estado de resultados (importes con IVA: el costo de ventas es la suma de las facturas)"], []];
  const formatos = [];   // [fila, "pct" | "money"]
  for (const [nombre, R] of bloques) {
    const cols = [...R.cols, R.total];
    aoa.push([nombre, ...R.cols.map((c) => mesLabel(c.mes)), "Total"]);
    const fila = (label, get, tipo = "money") => { aoa.push([label, ...cols.map((c) => { const v = get(c); return v == null ? "" : tipo === "pct" ? v / 100 : r2(v); })]); formatos.push([aoa.length - 1, tipo]); };
    fila("Ventas en blanco", (c) => c.vb);
    fila("Ventas en negro", (c) => c.ventasNegro);
    fila("Ventas totales", (c) => c.ingresos);
    fila("Compras facturadas (blanco)", (c) => c.cb);
    fila("Compras no facturadas (negro)", (c) => c.comprasNegro);
    fila("Costo de ventas", (c) => c.variables);
    fila("Margen bruto", (c) => c.margen);
    fila("% Margen bruto", (c) => c.margenPct, "pct");
    for (const cat of R.categorias) fila("   " + cat, (c) => c.fijosCat[cat] || 0);
    if (R.total.generalesMes) fila("   Parte de gastos generales (según ventas)", (c) => c.fijosGenerales);
    fila("Total de gastos operativos", (c) => c.fijos);
    fila("Utilidad operativa (ganancia)", (c) => c.resultado);
    fila("% Utilidad operativa", (c) => c.resultadoPct, "pct");
    aoa.push([]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (const [r, tipo] of formatos) for (let c = 1; c <= meses.length + 1; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell && cell.t === "n") cell.z = tipo === "pct" ? "0.0%" : "#,##0.00";
  }
  ws["!cols"] = [{ wch: 44 }, ...Array(meses.length + 1).fill({ wch: 16 })];
  return ws;
}

/** Hoja a partir de filas (objetos con los nombres de columna); fechas en dd/mm/aaaa y montos con 2 decimales. */
function hoja(XLSX, filas, columnas, { anchos = {}, montos = [], fechas = [] } = {}) {
  const ws = XLSX.utils.json_to_sheet(filas, { header: columnas, cellDates: true });
  if (!filas.length) XLSX.utils.sheet_add_aoa(ws, [columnas]);
  for (let r = 1; r <= filas.length; r++) columnas.forEach((col, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell) return;
    if (fechas.includes(col) && cell.t === "d") cell.z = col.includes("hora") ? "dd/mm/yyyy hh:mm" : "dd/mm/yyyy";
    if (montos.includes(col) && cell.t === "n") cell.z = "#,##0.00";
  });
  ws["!cols"] = columnas.map((c) => ({ wch: anchos[c] || Math.max(12, c.length + 2) }));
  return ws;
}

export async function descargarTodo() {
  const XLSX = await import("xlsx");
  const d = await traerTodo();
  const suc = Object.fromEntries(d.sucursales.map((s) => [s.id, s.nombre]));
  const prov = Object.fromEntries(d.proveedores.map((p) => [p.id, p]));
  const trib = Object.fromEntries(d.tributos.map((t) => [t.id, t.nombre]));
  const nombresTrib = [...new Set(d.comprobantes.flatMap((c) => Object.keys(c.tributos || {})).map((id) => trib[id] || "Tributo eliminado"))];

  // Período del resultado: del primer mes con datos hasta hoy
  const ahora = new Date(), hoyMes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`;
  const primeros = [d.comprobantes[0]?.fecha, d.ventas[0]?.fecha, d.costos[0]?.mes].filter(Boolean).map((x) => x.slice(0, 7)).sort();
  const meses = mesesEntre(primeros[0] || hoyMes, hoyMes);

  const comprobantes = d.comprobantes.map((c) => {
    const f = {
      "Fecha": fecha(c.fecha), "Sucursal": suc[c.sucursal_id] || "", "Proveedor": prov[c.proveedor_id]?.nombre || "", "CUIT": prov[c.proveedor_id]?.cuit || "",
      "Blanco / Negro": c.grupo === "FACTURADO" ? "Blanco" : "Negro", "Tipo": c.tipo === "NOTA_CREDITO" ? "Nota de crédito" : "Factura",
      "Número": c.numero, "Factura que afecta": c.factura_ref || "", "Importe": r2(c.monto),
      "IVA 21%": r2(c.iva21), "IVA 10,5%": r2(c.iva105), "IVA 27%": r2(c.iva27), "IVA 5%": r2(c.iva5), "IVA 2,5%": r2(c.iva25), "IIBB": r2(c.iibb),
    };
    for (const n of nombresTrib) f[n] = 0;
    for (const [id, v] of Object.entries(c.tributos || {})) f[trib[id] || "Tributo eliminado"] = r2((f[trib[id] || "Tributo eliminado"] || 0) + Number(v));
    Object.assign(f, { "Notas": c.notas || "", "Cargado por": c.cargado_por || "", "Cargado el (fecha y hora)": c.created_at ? new Date(c.created_at) : "" });
    return f;
  });
  const colsComp = ["Fecha", "Sucursal", "Proveedor", "CUIT", "Blanco / Negro", "Tipo", "Número", "Factura que afecta", "Importe", "IVA 21%", "IVA 10,5%", "IVA 27%", "IVA 5%", "IVA 2,5%", "IIBB", ...nombresTrib, "Notas", "Cargado por", "Cargado el (fecha y hora)"];

  const ventas = d.ventas.map((v) => ({
    "Fecha": fecha(v.fecha), "Sucursal": suc[v.sucursal_id] || "", "Punto de venta": v.pv, "Blanco / Negro": v.lado === "blanco" ? "Blanco" : "Negro",
    "Origen": v.origen === "manual" ? "Carga manual" : "PDF del sistema", "Comprobantes": v.comprobantes, "Notas de crédito": v.notas_credito,
    "Total": r2(v.total), "Notas de crédito ($)": r2(v.nc_total), "Neto gravado": r2(v.neto), "Exento": r2(v.exento), "Percepciones": r2(v.percep),
    "IVA 10,5%": r2(v.iva105), "IVA 21%": r2(v.iva21), "IVA otros": r2(v.iva_otros), "Archivo": v.archivo || "",
  }));
  const colsVentas = ["Fecha", "Sucursal", "Punto de venta", "Blanco / Negro", "Origen", "Comprobantes", "Notas de crédito", "Total", "Notas de crédito ($)", "Neto gravado", "Exento", "Percepciones", "IVA 10,5%", "IVA 21%", "IVA otros", "Archivo"];

  const gastos = d.costos.map((c) => ({ "Mes": fecha(c.mes), "Sucursal": c.sucursal_id ? suc[c.sucursal_id] || "" : "General (compartido)", "Gasto": c.categoria, "Importe": r2(c.monto) }))
    .sort((a, b) => a["Mes"] - b["Mes"] || a["Sucursal"].localeCompare(b["Sucursal"]));

  const montosComp = colsComp.filter((c) => !["Fecha", "Sucursal", "Proveedor", "CUIT", "Blanco / Negro", "Tipo", "Número", "Factura que afecta", "Notas", "Cargado por", "Cargado el (fecha y hora)"].includes(c));
  const generado = new Date();
  const leame = XLSX.utils.aoa_to_sheet([
    ["Facturero — Copia completa"],
    ["Generada el", generado.toLocaleString("es-AR")],
    ["Formato", VERSION_EXPORT],
    [],
    ["Hoja", "Qué tiene", "Filas"],
    ["Resultado", "Estado de resultados mes por mes de cada sucursal y del total (con IVA)", meses.length + " meses"],
    ["Comprobantes", "Facturas y notas de crédito de compras (las notas de crédito restan)", comprobantes.length],
    ["Ventas", "Ventas por día, sucursal y punto de venta", ventas.length],
    ["Gastos operativos", "Importe de cada gasto por mes y sucursal", gastos.length],
    ["Lista de gastos", "Los gastos de la lista, en orden", d.conceptos.length],
    ["Proveedores", "Nombre y CUIT", d.proveedores.length],
    ["Sucursales", "Sucursales y su punto de venta en blanco", d.sucursales.length],
    ["Otros tributos", "Tributos y tasas que se cargan en los comprobantes", d.tributos.length],
    [],
    ["No cambies los nombres de las hojas ni de las columnas si después la querés volver a cargar en Facturero."],
  ]);
  leame["!cols"] = [{ wch: 20 }, { wch: 72 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, leame, "Léame");
  XLSX.utils.book_append_sheet(wb, hojaResultado(XLSX, d, meses), "Resultado");
  XLSX.utils.book_append_sheet(wb, hoja(XLSX, comprobantes, colsComp, { montos: montosComp, fechas: ["Fecha", "Cargado el (fecha y hora)"], anchos: { Proveedor: 30, Notas: 30, "Cargado el (fecha y hora)": 20 } }), "Comprobantes");
  XLSX.utils.book_append_sheet(wb, hoja(XLSX, ventas, colsVentas, { montos: ["Total", "Notas de crédito ($)", "Neto gravado", "Exento", "Percepciones", "IVA 10,5%", "IVA 21%", "IVA otros"], fechas: ["Fecha"], anchos: { Archivo: 30 } }), "Ventas");
  XLSX.utils.book_append_sheet(wb, hoja(XLSX, gastos, ["Mes", "Sucursal", "Gasto", "Importe"], { montos: ["Importe"], fechas: ["Mes"], anchos: { Sucursal: 22, Gasto: 28 } }), "Gastos operativos");
  XLSX.utils.book_append_sheet(wb, hoja(XLSX, d.conceptos.map((c, i) => ({ "Orden": i + 1, "Gasto": c.nombre, "En la lista": c.activo ? "Sí" : "No (quitado)" })), ["Orden", "Gasto", "En la lista"], { anchos: { Gasto: 28 } }), "Lista de gastos");
  XLSX.utils.book_append_sheet(wb, hoja(XLSX, d.proveedores.map((p) => ({ "Proveedor": p.nombre, "CUIT": p.cuit || "" })), ["Proveedor", "CUIT"], { anchos: { Proveedor: 34, CUIT: 16 } }), "Proveedores");
  XLSX.utils.book_append_sheet(wb, hoja(XLSX, d.sucursales.map((s) => ({ "Sucursal": s.nombre, "Punto de venta en blanco": s.pv_blanco || "" })), ["Sucursal", "Punto de venta en blanco"], { anchos: { Sucursal: 22 } }), "Sucursales");
  XLSX.utils.book_append_sheet(wb, hoja(XLSX, d.tributos.map((t) => ({ "Tributo": t.nombre, "En uso": t.activo ? "Sí" : "No" })), ["Tributo", "En uso"], { anchos: { Tributo: 28 } }), "Otros tributos");

  const stamp = `${generado.getFullYear()}-${String(generado.getMonth() + 1).padStart(2, "0")}-${String(generado.getDate()).padStart(2, "0")}`;
  XLSX.writeFile(wb, `facturero_copia_completa_${stamp}.xlsx`);
  return { comprobantes: comprobantes.length, ventas: ventas.length, gastos: gastos.length, proveedores: d.proveedores.length };
}
