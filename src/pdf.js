import { jsPDF } from "jspdf";
import { fmtMoney, fmtDate, computeTotals, groupBy, IMPUESTOS } from "./format.js";

/**
 * Genera y descarga el reporte PDF de compras.
 * @param {{list:any[], desde:string, hasta:string, alcance:string, proveedorNombre:(id)=>string, sucursalNombre:(id)=>string}} opts
 */
export function generarReportePDF({ list, desde, hasta, alcance, proveedorNombre, sucursalNombre, tributoNombre = (id) => id }) {
  const doc = new jsPDF();
  const t = computeTotals(list);
  const bySuc = groupBy(list, (c) => sucursalNombre(c.sucursal_id)).sort((a, b) => (b.fact + b.noFact) - (a.fact + a.noFact));

  let y = 20;
  const line = (text, step = 5) => { if (y > 280) { doc.addPage(); y = 20; } doc.text(text, 14, y); y += step; };

  doc.setFontSize(16); line("Facturero — Reporte de compras", 8);
  doc.setFontSize(10); doc.setTextColor(90);
  line(`Período: ${fmtDate(desde)} a ${fmtDate(hasta)}`);
  line(`Alcance: ${alcance}`);
  line(`Generado: ${new Date().toLocaleString("es-AR")}`, 9);
  doc.setTextColor(20);

  doc.setFontSize(12); line("Totales", 6);
  doc.setFontSize(10);
  line(`Facturado (blanco): ${fmtMoney(t.fact)}`);
  line(`No facturado (negro): ${fmtMoney(t.noFact)}`);
  line(`Total real: ${fmtMoney(t.total)}`, 9);

  doc.setFontSize(12); line("Impuestos", 6);
  doc.setFontSize(10);
  for (const [k, label] of IMPUESTOS) line(`${label}: ${fmtMoney(t[k])}`);
  line(`Total IVA: ${fmtMoney(t.ivaTotal)}`);
  line(`Ingresos Brutos (Misiones): ${fmtMoney(t.iibb)}`);
  for (const [id, v] of Object.entries(t.tributos)) if (v) line(`${tributoNombre(id)}: ${fmtMoney(v)}`);
  line(`Total impuestos: ${fmtMoney(t.impuestosTotal)}`, 9);

  if (bySuc.length > 1) {
    doc.setFontSize(12); line("Por sucursal", 6);
    doc.setFontSize(10);
    for (const s of bySuc) line(`${s.key}: Blanco ${fmtMoney(s.fact)} · Negro ${fmtMoney(s.noFact)} · Total ${fmtMoney(s.fact + s.noFact)}`);
    y += 4;
  }

  doc.setFontSize(12); line("Detalle de comprobantes", 6);
  doc.setFontSize(9);
  if (!list.length) line("Sin comprobantes en este período.");
  list.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).forEach((c) => {
    line(`${fmtDate(c.fecha)} · ${c.grupo === "FACTURADO" ? "Fact." : "No fact."} · N° ${c.numero} · ${proveedorNombre(c.proveedor_id)} · ${sucursalNombre(c.sucursal_id)} — ${fmtMoney(c.monto)}`, 4.6);
  });

  doc.save(`facturero_reporte_${desde}_a_${hasta}.pdf`);
}
