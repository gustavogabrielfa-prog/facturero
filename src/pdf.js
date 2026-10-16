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
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14, AN = W - 2 * M;
  const t = computeTotals(list);
  const facturas = list.filter((c) => signo(c) > 0).sort(ordenFecha);
  const notas = list.filter((c) => signo(c) < 0).sort(ordenFecha);
  const impCols = columnasImpuestos(list, tributoNombre);
  const variasSuc = new Set(list.map((c) => c.sucursal_id)).size > 1;
  const bySuc = groupBy(list, (c) => sucursalNombre(c.sucursal_id)).sort((a, b) => (b.fact + b.noFact) - (a.fact + a.noFact));
  const totFact = facturas.reduce((a, c) => a + (Number(c.monto) || 0), 0);
  const totNC = notas.reduce((a, c) => a + (Number(c.monto) || 0), 0);
  const periodo = desde === hasta ? fmtDate(desde) : `${fmtDate(desde)} al ${fmtDate(hasta)}`;
  const generado = new Date().toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });

  // Paleta (la misma de la app)
  const C = {
    marca: [23, 96, 92], marcaSuave: [233, 242, 241], tinta: [18, 33, 28], gris: [93, 107, 100], linea: [216, 221, 215],
    suave: [244, 246, 243], fact: [29, 113, 70], nofact: [154, 90, 23], nc: [156, 51, 34], ncSuave: [248, 230, 226], blanco: [255, 255, 255],
  };
  const color = (c) => doc.setTextColor(...c);
  const relleno = (c) => doc.setFillColor(...c);
  const trazo = (c) => doc.setDrawColor(...c);
  const fuente = (tam, estilo = "normal") => { doc.setFontSize(tam); doc.setFont("helvetica", estilo); };

  let y = 0;
  const cabeceraChica = () => {
    fuente(9, "bold"); color(C.marca); doc.text("Facturero", M, 12);
    fuente(9); color(C.gris); doc.text(`Reporte de compras · ${periodo} · ${alcance}`, M + 19, 12);
    trazo(C.marca); doc.setLineWidth(0.5); doc.line(M, 15, W - M, 15); doc.setLineWidth(0.2);
    y = 23;
  };
  const salto = (alto) => { if (y + alto > H - 16) { doc.addPage(); cabeceraChica(); return true; } return false; };

  // ----- Encabezado principal -----
  relleno(C.marca); doc.rect(0, 0, W, 30, "F");
  fuente(20, "bold"); color(C.blanco); doc.text("Facturero", M, 14);
  fuente(11); doc.text("Reporte de compras", M, 21);
  fuente(14, "bold"); doc.text(periodo, W - M, 14, { align: "right" });
  fuente(10); doc.text(alcance, W - M, 21, { align: "right" });
  y = 40;

  // ----- Tarjetas de resumen -----
  const tarjetas = [
    ["TOTAL NETO", t.total, C.marca, `${facturas.length + notas.length} comprobantes`],
    ["FACTURADO (BLANCO)", t.fact, C.fact, ""],
    ["NO FACTURADO (NEGRO)", t.noFact, C.nofact, ""],
    ["NOTAS DE CRÉDITO", -totNC, C.nc, `${notas.length} ${notas.length === 1 ? "nota" : "notas"} · se restan`],
  ];
  const gap = 5, tw = (AN - gap * 3) / 4, th = 24;
  tarjetas.forEach(([label, v, col, sub], i) => {
    const x = M + i * (tw + gap);
    relleno(i === 0 ? C.marcaSuave : C.blanco); trazo(C.linea); doc.roundedRect(x, y, tw, th, 2, 2, "FD");
    relleno(col); doc.rect(x, y + 3, 1.6, th - 6, "F");
    fuente(7.5, "bold"); color(C.gris); doc.text(label, x + 6, y + 7);
    fuente(15, "bold"); color(i === 0 ? C.marca : C.tinta); doc.text(fmtMoney(v), x + 6, y + 15.5);
    if (sub) { fuente(7.5); color(C.gris); doc.text(sub, x + 6, y + 20.5); }
  });
  y += th + 9;

  // ----- Cajas: impuestos y composición -----
  /** Caja con título y filas [etiqueta, importe, esTotal, color]; los totales van en negrita con una línea arriba ("sep" = solo la línea). */
  const caja = (x, w, titulo, filas) => {
    const alto = 11 + filas.length * 6.2 + 3;
    trazo(C.linea); relleno(C.blanco); doc.roundedRect(x, y, w, alto, 2, 2, "FD");
    fuente(10, "bold"); color(C.marca); doc.text(titulo, x + 5, y + 7);
    let yy = y + 14;
    for (const [label, v, total, col] of filas) {
      if (total) { trazo(C.linea); doc.line(x + 5, yy - 4.3, x + w - 5, yy - 4.3); }
      fuente(9, total === true ? "bold" : "normal"); color(col || C.tinta);
      doc.text(label, x + 5, yy);
      doc.text(fmtMoney(v), x + w - 5, yy, { align: "right" });
      yy += 6.2;
    }
    return alto;
  };
  const filasImp = [
    ...IMPUESTOS.map(([k, label]) => [label, t[k]]).filter(([, v]) => v),
    ["Total IVA", t.ivaTotal, true],
    ["Ingresos Brutos (Misiones)", t.iibb],
    ...Object.entries(t.tributos).filter(([, v]) => v).map(([id, v]) => [tributoNombre(id), v]),
    ["Total impuestos", t.impuestosTotal, true, C.marca],
  ];
  const filasComp = [
    [`Facturas (${facturas.length})`, totFact],
    [`Notas de crédito (${notas.length})`, -totNC, false, notas.length ? C.nc : null],
    ["Total neto", t.total, true, C.marca],
    ...(bySuc.length > 1 ? bySuc.map((s, i) => [s.key, s.fact + s.noFact, i === 0 ? "sep" : false]) : []),
  ];
  const cw = (AN - gap) / 2;
  const altoCajas = Math.max(
    caja(M, cw, "Impuestos (neto de notas de crédito)", filasImp),
    caja(M + cw + gap, cw, bySuc.length > 1 ? "Composición y aporte por sucursal" : "Composición", filasComp),
  );
  y += altoCajas + 10;

  // ----- Tablas de detalle -----
  const cols = [
    { label: "Fecha", w: 21, get: (c) => fmtDate(c.fecha) },
    { label: "Tipo", w: 17, get: (c) => (c.grupo === "FACTURADO" ? "Fact." : "No fact."), col: (c) => (c.grupo === "FACTURADO" ? C.fact : C.nofact) },
    { label: "N° comprobante", w: 31, get: (c) => String(c.numero) },
    { label: "Proveedor", w: 0, get: (c) => proveedorNombre(c.proveedor_id) },
    ...(variasSuc ? [{ label: "Sucursal", w: 32, get: (c) => sucursalNombre(c.sucursal_id) }] : []),
    ...impCols.map((col) => ({ label: col.label, w: 24, num: true, get: col.get })),
    { label: "Total", w: 29, num: true, fuerte: true, get: (c) => Number(c.monto) || 0 },
  ];
  const fijo = cols.reduce((a, c) => a + c.w, 0);
  cols.find((c) => c.label === "Proveedor").w = Math.max(30, AN - fijo);
  let cx = M; for (const c of cols) { c.x = cx; cx += c.w; }
  const celda = (col, texto) => {
    let s = String(texto);
    while (s.length > 1 && doc.getTextWidth(s) > col.w - 3) s = s.slice(0, -1);
    if (s !== String(texto)) s = s.slice(0, -1) + "…";
    if (col.num) doc.text(s, col.x + col.w - 1.5, y, { align: "right" });
    else doc.text(s, col.x + 1.5, y);
  };
  const FILA = 6.2;
  const tabla = (titulo, filas, pie, acento, fondoPie) => {
    salto(30);
    fuente(12, "bold"); color(acento); doc.text(titulo, M, y);
    y += 4;
    const encabezado = () => {
      relleno(acento); doc.rect(M, y, AN, 7.5, "F");
      fuente(8, "bold"); color(C.blanco);
      y += 5; for (const col of cols) celda(col, col.label); y += 2.5;
    };
    encabezado();
    filas.forEach((c, i) => {
      if (salto(FILA + 2)) encabezado();
      if (i % 2) { relleno(C.suave); doc.rect(M, y, AN, FILA, "F"); }
      y += 4.3;
      for (const col of cols) {
        fuente(8.3, col.fuerte ? "bold" : "normal"); color(col.col ? col.col(c) : C.tinta);
        celda(col, col.num ? fmtMoney(col.get(c)) : col.get(c));
      }
      y += FILA - 4.3;
    });
    salto(FILA + 4);
    relleno(fondoPie); doc.rect(M, y, AN, FILA + 1, "F");
    trazo(acento); doc.setLineWidth(0.5); doc.line(M, y, W - M, y); doc.setLineWidth(0.2);
    y += 4.8; fuente(8.5, "bold"); color(acento);
    doc.text(pie, M + 1.5, y);
    color(C.tinta);
    for (const col of cols.filter((c) => c.num)) celda(col, fmtMoney(filas.reduce((a, c) => a + col.get(c), 0)));
    y += 12;
  };
  if (facturas.length) tabla(`Facturas (${facturas.length})`, facturas, "Subtotal facturas", C.marca, C.marcaSuave);
  else { fuente(10); color(C.gris); doc.text("Sin facturas en este período.", M, y); y += 10; }
  if (notas.length) tabla(`Notas de crédito (${notas.length}) — se restan del total`, notas, "Subtotal notas de crédito", C.nc, C.ncSuave);

  // ----- Total final -----
  salto(26);
  relleno(C.marca); doc.roundedRect(M, y, AN, 18, 2, 2, "F");
  fuente(9, "bold"); color([200, 228, 225]); doc.text(notas.length ? "TOTAL NETO · facturas menos notas de crédito" : "TOTAL DEL PERÍODO", M + 6, y + 7);
  fuente(8.5); doc.text(`Impuestos ${fmtMoney(t.impuestosTotal)}  ·  IVA ${fmtMoney(t.ivaTotal)}  ·  IIBB ${fmtMoney(t.iibb)}${t.tributosTotal ? `  ·  Otros ${fmtMoney(t.tributosTotal)}` : ""}`, M + 6, y + 13);
  fuente(18, "bold"); color(C.blanco); doc.text(fmtMoney(t.total), W - M - 6, y + 12, { align: "right" });

  // ----- Pie de página -----
  const paginas = doc.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i);
    trazo(C.linea); doc.line(M, H - 10, W - M, H - 10);
    fuente(7.5); color(C.gris);
    doc.text(`Facturero · Generado el ${generado}`, M, H - 6);
    doc.text(`Página ${i} de ${paginas}`, W - M, H - 6, { align: "right" });
  }
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
