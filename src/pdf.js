import { jsPDF } from "jspdf";
import { fmtMoney, fmtDate, computeTotals, groupBy, IMPUESTOS, signo } from "./format.js";

/**
 * Columnas del reporte: solo los impuestos que aparecen en el período (para que la tabla entre en la hoja).
 * Cada columna sabe leer su valor (siempre positivo; el signo de las notas de crédito se aplica aparte).
 */
function columnasImpuestos(list, tributoNombre) {
  const usados = (get) => list.some((c) => (Number(get(c)) || 0) !== 0);
  const cols = IMPUESTOS.map(([k, label]) => ({ label, get: (c) => Number(c[k]) || 0 })).filter((col) => usados(col.get));
  if (usados((c) => c.iibb)) cols.push({ label: "IIBB", get: (c) => Number(c.iibb) || 0 });
  const tribIds = [...new Set(list.flatMap((c) => Object.keys(c.tributos || {})))];
  for (const id of tribIds) {
    const col = { label: tributoNombre(id), get: (c) => Number(c.tributos?.[id]) || 0 };
    if (usados(col.get)) cols.push(col);
  }
  return cols;
}

const ordenFecha = (a, b) => a.fecha.localeCompare(b.fecha) || String(a.numero).localeCompare(String(b.numero));

/**
 * Genera y descarga el reporte PDF de compras: resumen, impuestos, facturas y notas de crédito
 * en tablas separadas (cada una con su subtotal) y el total neto al final.
 * @param {{list:any[], desde:string, hasta:string, alcance:string, proveedorNombre:(id)=>string, sucursalNombre:(id)=>string}} opts
 */
export function generarReportePDF({ list, desde, hasta, alcance, proveedorNombre, sucursalNombre, tributoNombre = (id) => id }) {
  const doc = new jsPDF({ orientation: "landscape" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12;
  const t = computeTotals(list);
  const facturas = list.filter((c) => signo(c) > 0).sort(ordenFecha);
  const notas = list.filter((c) => signo(c) < 0).sort(ordenFecha);
  const impCols = columnasImpuestos(list, tributoNombre);
  const variasSuc = new Set(list.map((c) => c.sucursal_id)).size > 1;
  const bySuc = groupBy(list, (c) => sucursalNombre(c.sucursal_id)).sort((a, b) => (b.fact + b.noFact) - (a.fact + a.noFact));

  let y = 16;
  const salto = (alto) => { if (y + alto > H - 12) { doc.addPage(); y = 16; return true; } return false; };
  const line = (text, step = 5) => { salto(step); doc.text(text, M, y); y += step; };
  const titulo = (text) => { salto(14); doc.setFontSize(12); doc.setFont(undefined, "bold"); line(text, 6); doc.setFont(undefined, "normal"); doc.setFontSize(10); };
  /** Pares etiqueta / importe alineados en dos columnas. */
  const pares = (filas) => {
    for (const [label, v, negrita] of filas) {
      salto(5);
      if (negrita) doc.setFont(undefined, "bold");
      doc.text(label, M, y); doc.text(fmtMoney(v), M + 120, y, { align: "right" });
      if (negrita) doc.setFont(undefined, "normal");
      y += 5;
    }
    y += 4;
  };

  doc.setFontSize(16); doc.setFont(undefined, "bold"); line("Facturero — Reporte de compras", 8); doc.setFont(undefined, "normal");
  doc.setFontSize(10); doc.setTextColor(90);
  line(`Período: ${fmtDate(desde)} a ${fmtDate(hasta)}   ·   Alcance: ${alcance}   ·   Generado: ${new Date().toLocaleString("es-AR")}`, 9);
  doc.setTextColor(20);

  const totFact = facturas.reduce((a, c) => a + (Number(c.monto) || 0), 0);
  const totNC = notas.reduce((a, c) => a + (Number(c.monto) || 0), 0);
  titulo("Resumen");
  pares([
    [`Facturas (${facturas.length})`, totFact],
    [`Notas de crédito (${notas.length}) — se restan`, -totNC],
    ["Total neto", t.total, true],
    ["   Facturado (blanco)", t.fact],
    ["   No facturado (negro)", t.noFact],
  ]);

  titulo("Impuestos (neto de notas de crédito)");
  pares([
    ...IMPUESTOS.map(([k, label]) => [label, t[k]]).filter(([, v]) => v),
    ["Total IVA", t.ivaTotal, true],
    ["Ingresos Brutos (Misiones)", t.iibb],
    ...Object.entries(t.tributos).filter(([, v]) => v).map(([id, v]) => [tributoNombre(id), v]),
    ["Total impuestos", t.impuestosTotal, true],
  ]);

  if (bySuc.length > 1) {
    titulo("Por sucursal");
    for (const s of bySuc) line(`${s.key}:  blanco ${fmtMoney(s.fact)}  ·  negro ${fmtMoney(s.noFact)}  ·  total ${fmtMoney(s.fact + s.noFact)}`);
    y += 4;
  }

  // ----- Tablas de detalle -----
  const cols = [
    { label: "Fecha", w: 20, get: (c) => fmtDate(c.fecha) },
    { label: "Tipo", w: 16, get: (c) => (c.grupo === "FACTURADO" ? "Fact." : "No fact.") },
    { label: "N°", w: 30, get: (c) => String(c.numero) },
    { label: "Proveedor", w: 0, get: (c) => proveedorNombre(c.proveedor_id) },
    ...(variasSuc ? [{ label: "Sucursal", w: 32, get: (c) => sucursalNombre(c.sucursal_id) }] : []),
    ...impCols.map((col) => ({ label: col.label, w: 24, num: true, get: col.get })),
    { label: "Total", w: 28, num: true, get: (c) => Number(c.monto) || 0 },
  ];
  const fijo = cols.reduce((a, c) => a + c.w, 0);
  cols.find((c) => c.label === "Proveedor").w = Math.max(30, W - 2 * M - fijo);
  let x = M; for (const c of cols) { c.x = x; x += c.w; }
  const celda = (col, texto) => {
    let s = String(texto);
    while (s.length > 1 && doc.getTextWidth(s) > col.w - 2) s = s.slice(0, -1);
    if (s !== String(texto)) s = s.slice(0, -1) + "…";
    if (col.num) doc.text(s, col.x + col.w - 1, y, { align: "right" });
    else doc.text(s, col.x + 1, y);
  };
  const encabezado = () => {
    doc.setFontSize(8); doc.setFont(undefined, "bold");
    doc.setFillColor(232, 236, 231); doc.rect(M, y - 4, W - 2 * M, 6, "F");
    for (const col of cols) celda(col, col.label);
    doc.setFont(undefined, "normal"); y += 6;
  };
  const tabla = (nombre, filas, pie) => {
    titulo(nombre);
    if (!filas.length) { line("Sin comprobantes.", 8); return; }
    encabezado();
    for (const c of filas) {
      if (salto(5)) encabezado();
      for (const col of cols) celda(col, col.num ? fmtMoney(col.get(c)) : col.get(c));
      doc.setDrawColor(215); doc.line(M, y + 1.4, W - M, y + 1.4);
      y += 5;
    }
    salto(7);
    doc.setFont(undefined, "bold"); doc.setFillColor(244, 246, 243); doc.rect(M, y - 4, W - 2 * M, 6, "F");
    doc.text(pie, M + 1, y);
    for (const col of cols.filter((c) => c.num)) celda(col, fmtMoney(filas.reduce((a, c) => a + col.get(c), 0)));
    doc.setFont(undefined, "normal"); doc.setFontSize(10); y += 10;
  };
  tabla(`Facturas (${facturas.length})`, facturas, "Subtotal facturas");
  tabla(`Notas de crédito (${notas.length}) — se restan del total`, notas, "Subtotal notas de crédito");

  salto(16);
  doc.setFontSize(12); doc.setFont(undefined, "bold");
  doc.text("TOTAL NETO (facturas menos notas de crédito)", M, y);
  doc.text(fmtMoney(t.total), W - M - 1, y, { align: "right" });
  y += 6; doc.setFontSize(10); doc.setFont(undefined, "normal");
  doc.text(`Impuestos netos: ${fmtMoney(t.impuestosTotal)}  (IVA ${fmtMoney(t.ivaTotal)} · IIBB ${fmtMoney(t.iibb)}${t.tributosTotal ? ` · Otros ${fmtMoney(t.tributosTotal)}` : ""})`, M, y);

  const paginas = doc.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text(`Página ${i} de ${paginas}`, W - M, H - 6, { align: "right" }); }
  doc.save(`facturero_reporte_${desde}_a_${hasta}.pdf`);
}

/**
 * Mismo reporte en Excel: hoja "Comprobantes" (números reales, notas de crédito en negativo para que las
 * sumas den el neto, fila de totales con fórmulas) y hoja "Resumen".
 */
export async function generarReporteExcel({ list, desde, hasta, alcance, proveedorNombre, sucursalNombre, tributoNombre = (id) => id }) {
  const XLSX = await import("xlsx");
  const t = computeTotals(list);
  const impCols = columnasImpuestos(list, tributoNombre);
  const filas = list.slice().sort((a, b) => signo(b) - signo(a) || ordenFecha(a, b));
  const r2 = (n) => Math.round(n * 100) / 100;

  const head = ["Fecha", "Tipo", "Grupo", "N° comprobante", "Proveedor", "Sucursal", "Cargó", ...impCols.map((c) => c.label), "Total", "Notas"];
  const aoa = [head, ...filas.map((c) => {
    const sg = signo(c);
    return [new Date(c.fecha + "T00:00:00"), sg < 0 ? "Nota de crédito" : "Factura", c.grupo === "FACTURADO" ? "Facturado" : "No facturado",
      String(c.numero), proveedorNombre(c.proveedor_id), sucursalNombre(c.sucursal_id), c.cargado_por || "",
      ...impCols.map((col) => r2(sg * col.get(c))), r2(sg * (Number(c.monto) || 0)), c.notas || ""];
  })];
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  // Fila de totales con fórmulas (las notas de crédito ya están en negativo)
  const n = filas.length, ultima = n + 1, totRow = n + 2;
  XLSX.utils.sheet_add_aoa(ws, [["TOTAL NETO"]], { origin: { r: totRow, c: 0 } });
  const primeraNum = 7;
  for (let i = 0; i <= impCols.length; i++) {
    const col = XLSX.utils.encode_col(primeraNum + i);
    const v = r2(aoa.slice(1).reduce((acc, fila) => acc + (Number(fila[primeraNum + i]) || 0), 0));   // valor ya calculado por si el visor no recalcula
    ws[`${col}${totRow + 1}`] = { t: "n", f: n ? `SUM(${col}2:${col}${ultima})` : "0", v };
  }
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totRow, c: head.length - 1 } });
  for (let r = 1; r <= totRow; r++) {
    const f = ws[XLSX.utils.encode_cell({ r, c: 0 })]; if (f && f.t === "d") f.z = "dd/mm/yyyy";
    for (let i = 0; i <= impCols.length; i++) { const cell = ws[XLSX.utils.encode_cell({ r, c: primeraNum + i })]; if (cell) cell.z = "#,##0.00"; }
  }
  ws["!cols"] = head.map((h) => ({ wch: h === "Proveedor" ? 28 : h === "Sucursal" ? 20 : h === "Notas" ? 30 : h === "N° comprobante" ? 18 : 13 }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: ultima - 1, c: head.length - 1 } }) };

  const facturas = list.filter((c) => signo(c) > 0), notas = list.filter((c) => signo(c) < 0);
  const suma = (l) => r2(l.reduce((a, c) => a + (Number(c.monto) || 0), 0));
  const res = [
    ["Facturero — Reporte de compras"],
    ["Período", `${fmtDate(desde)} a ${fmtDate(hasta)}`],
    ["Alcance", alcance],
    ["Generado", new Date().toLocaleString("es-AR")],
    [],
    ["Resumen", "Cantidad", "Importe"],
    ["Facturas", facturas.length, suma(facturas)],
    ["Notas de crédito (se restan)", notas.length, -suma(notas)],
    ["Total neto", list.length, r2(t.total)],
    ["Facturado (blanco)", "", r2(t.fact)],
    ["No facturado (negro)", "", r2(t.noFact)],
    [],
    ["Impuestos (neto de notas de crédito)", "", "Importe"],
    ...IMPUESTOS.map(([k, label]) => [label, "", r2(t[k])]),
    ["Total IVA", "", r2(t.ivaTotal)],
    ["Ingresos Brutos (Misiones)", "", r2(t.iibb)],
    ...Object.entries(t.tributos).map(([id, v]) => [tributoNombre(id), "", r2(v)]),
    ["Total impuestos", "", r2(t.impuestosTotal)],
  ];
  const bySuc = groupBy(list, (c) => sucursalNombre(c.sucursal_id));
  if (bySuc.length > 1) res.push([], ["Por sucursal", "Blanco", "Negro", "Total"], ...bySuc.map((s) => [s.key, r2(s.fact), r2(s.noFact), r2(s.fact + s.noFact)]));
  const wsR = XLSX.utils.aoa_to_sheet(res);
  for (const k of Object.keys(wsR)) if (!k.startsWith("!") && wsR[k].t === "n" && !/^B[789]$/.test(k)) wsR[k].z = "#,##0.00";
  wsR["!cols"] = [{ wch: 38 }, { wch: 14 }, { wch: 16 }, { wch: 16 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsR, "Resumen");
  XLSX.utils.book_append_sheet(wb, ws, "Comprobantes");
  XLSX.writeFile(wb, `facturero_reporte_${desde}_a_${hasta}.xlsx`);
}

/** Informe de diferencias entre ARCA (Mis Comprobantes) y Facturero. */
export function generarInformeArca({ res, archivo, proveedorNombre, sucursalNombre }) {
  const doc = new jsPDF();
  let y = 20;
  const line = (text, step = 5) => { if (y > 280) { doc.addPage(); y = 20; } doc.text(String(text), 14, y); y += step; };
  const wrap = (text, step = 4.6) => doc.splitTextToSize(String(text), 182).forEach((l) => line(l, step));
  const num = (a) => `${a.pv.padStart(5, "0")}-${a.num.padStart(8, "0")}`;
  const tipo = (nc) => (nc ? "N. crédito" : "Factura");

  doc.setFontSize(16); line("Facturero — Compara ARCA", 8);
  doc.setFontSize(10); doc.setTextColor(90);
  line(`Período del archivo: ${fmtDate(res.desde)} a ${fmtDate(res.hasta)}`);
  line(`Archivo: ${archivo}`);
  line(`Generado: ${new Date().toLocaleString("es-AR")}`, 9);
  doc.setTextColor(20);

  doc.setFontSize(12); line("Resumen", 6);
  doc.setFontSize(10);
  line(`Coinciden: ${res.ok.length}`);
  line(`Con diferencia de importe: ${res.dif.length}`);
  line(`Número cargado distinto: ${res.revisar.length}`);
  line(`En ARCA y sin cargar en Facturero: ${res.falta.length}`);
  line(`Cargados como facturados y no están en ARCA: ${res.noArca.length}`, 9);

  const seccion = (titulo, items, fila) => {
    doc.setFontSize(12); line(`${titulo} (${items.length})`, 6);
    doc.setFontSize(9);
    if (!items.length) line("Sin casos.", 7);
    else { items.forEach((it) => wrap(fila(it))); y += 3; }
  };
  seccion("Diferencia de importe", res.dif, ({ a, c, detalle }) =>
    `${fmtDate(a.fecha)} · ${tipo(a.nc)} ${num(a)} · ${a.nombre || proveedorNombre(c.proveedor_id)} · ${sucursalNombre(c.sucursal_id)} — ${detalle.join(" · ")}`);
  seccion("Número cargado distinto", res.revisar, ({ a, c, detalle }) =>
    `${fmtDate(a.fecha)} · ${tipo(a.nc)} · ${a.nombre || proveedorNombre(c.proveedor_id)} · ${fmtMoney(a.total)} · ${sucursalNombre(c.sucursal_id)} — ${detalle.join(" · ")}`);
  seccion("En ARCA y sin cargar en Facturero", res.falta, ({ a }) =>
    `${fmtDate(a.fecha)} · ${tipo(a.nc)} ${num(a)} · ${a.nombre} (CUIT ${a.cuit}) — ${fmtMoney(a.total)}`);
  seccion("Cargados como facturados y no están en ARCA", res.noArca, ({ c }) =>
    `${fmtDate(c.fecha)} · ${c.tipo === "NOTA_CREDITO" ? "N. crédito" : "Factura"} N° ${c.numero} · ${proveedorNombre(c.proveedor_id)} · ${sucursalNombre(c.sucursal_id)} — ${fmtMoney(c.monto)}`);

  doc.save(`facturero_control_arca_${res.desde}_a_${res.hasta}.pdf`);
}
