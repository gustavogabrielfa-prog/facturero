/* ---------- Libro de IVA Ventas (PDF del sistema de la farmacia) ---------- */

const RE_FECHA = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const RE_COMP = /^([A-Z]{2,3})\s+([A-Z])\s+(\d{4,5})\s+(\d{6,8})$/;   // "FV B 0006 00006987"
const RE_NUM = /-?\d{1,3}(?:\.\d{3})*,\d{2}/g;                         // "1.004.300,02"
const num = (s) => Number(s.replace(/\./g, "").replace(",", "."));
const iso = (s) => s.replace(RE_FECHA, "$3-$2-$1");

/** Lee el PDF en el navegador (no se sube a ningún lado) y devuelve los comprobantes. */
export async function leerLibroVentas(file) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const paginas = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    paginas.push(tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() })));
  }
  return parsearLibroVentas(paginas);
}

/** Agrupa los textos de una página en renglones (a veces un mismo renglón viene corrido 1 punto). */
function renglones(items) {
  const orden = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const filas = [];
  for (const it of orden) {
    const f = filas[filas.length - 1];
    if (f && Math.abs(f.y - it.y) <= 2.5) f.items.push(it); else filas.push({ y: it.y, items: [it] });
  }
  for (const f of filas) f.items.sort((a, b) => a.x - b.x);
  return filas;
}

/**
 * Columnas del libro: Neto, Exento, Percep. IVA, IVA 10,5%, IVA 21%, IVA Otros, Total (las notas de crédito ya vienen en negativo).
 * @param {{x:number,y:number,s:string}[][]} paginas
 */
export function parsearLibroVentas(paginas) {
  const texto1 = (paginas[0] || []).map((i) => i.s).join(" ");
  if (!/Libro de IVA Ventas/i.test(texto1)) throw new Error("Este PDF no parece un Libro de IVA Ventas.");
  const rango = texto1.match(/Desde (\d{2}\/\d{2}\/\d{4}) hasta (\d{2}\/\d{2}\/\d{4})/i);
  const empresa = renglones(paginas[0])[0]?.items[0]?.s || "";

  const filas = [], avisos = [];
  let totalPdf = null;
  paginas.forEach((items, pi) => {
    const rs = renglones(items);
    for (const r of rs) {
      const strs = r.items.map((i) => i.s);
      if (RE_FECHA.test(strs[0])) {
        const ci = strs.findIndex((s) => RE_COMP.test(s));
        if (ci < 0) continue;
        const [, tipo, letra, pv, numero] = strs[ci].match(RE_COMP);
        const resto = strs.slice(ci + 1);
        const nums = (resto.join(" ").match(RE_NUM) || []).map(num);
        if (nums.length < 7) { avisos.push(`Página ${pi + 1}: no se pudieron leer los importes de ${strs[ci]}.`); continue; }
        const [neto, exento, percep, iva105, iva21, ivaOtros, total] = nums.slice(-7);
        const cuit = resto.find((s) => /^\d{2}-\d{8}-\d$/.test(s)) || "";
        const iNum = resto.findIndex((s) => RE_NUM.test(s)); RE_NUM.lastIndex = 0;
        const cliente = resto.slice(0, iNum < 0 ? resto.length : iNum).filter((s) => s !== cuit && !/^[A-Z]{1,2}$/.test(s)).join(" ");
        filas.push({ fecha: iso(strs[0]), tipo, letra, pv: pv.padStart(4, "0"), numero, cuit, cliente, neto, exento, percep, iva105, iva21, ivaOtros, total });
      } else if (pi === paginas.length - 1 && !/^Transporte/i.test(strs[0])) {
        // el último renglón de importes sin fecha de la última página es el total general
        const nums = (strs.join(" ").match(RE_NUM) || []).map(num);
        if (nums.length) totalPdf = nums[nums.length - 1];
      }
    }
  });
  if (!filas.length) throw new Error("No se encontraron comprobantes en el PDF.");
  const fechas = filas.map((f) => f.fecha).sort();
  const suma = Math.round(filas.reduce((a, f) => a + f.total, 0) * 100) / 100;
  return {
    empresa,
    desde: rango ? iso(rango[1]) : fechas[0],
    hasta: rango ? iso(rango[2]) : fechas[fechas.length - 1],
    filas, avisos, suma, totalPdf,
    cuadra: totalPdf == null ? null : Math.abs(suma - totalPdf) < 0.05,
  };
}

/** Puntos de venta encontrados, con cantidad y total. */
export function puntosDeVenta(filas) {
  const m = {};
  for (const f of filas) {
    const p = (m[f.pv] ||= { pv: f.pv, n: 0, nc: 0, total: 0 });
    p.n++; if (f.tipo === "NC") p.nc++; p.total += f.total;
  }
  return Object.values(m).sort((a, b) => a.pv.localeCompare(b.pv));
}

/** Totales blanco / negro (según qué punto de venta es cada uno), por día y generales. */
export function resumenVentas(libro, asignacion) {
  const dias = {};
  for (let d = new Date(libro.desde + "T00:00:00"), fin = new Date(libro.hasta + "T00:00:00"); d <= fin; d.setDate(d.getDate() + 1)) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    dias[k] = { fecha: k, blanco: 0, negro: 0 };
  }
  const t = { blanco: 0, negro: 0, nBlanco: 0, nNegro: 0, ncBlanco: 0, ncNegro: 0, ivaBlanco: 0, netoBlanco: 0, exentoBlanco: 0 };
  for (const f of libro.filas) {
    const lado = asignacion[f.pv];
    if (lado !== "blanco" && lado !== "negro") continue;
    (dias[f.fecha] ||= { fecha: f.fecha, blanco: 0, negro: 0 })[lado] += f.total;
    t[lado] += f.total;
    if (lado === "blanco") {
      t.nBlanco++; if (f.tipo === "NC") t.ncBlanco += f.total;
      t.ivaBlanco += f.iva105 + f.iva21 + f.ivaOtros + f.percep; t.netoBlanco += f.neto; t.exentoBlanco += f.exento;
    } else { t.nNegro++; if (f.tipo === "NC") t.ncNegro += f.total; }
  }
  t.total = t.blanco + t.negro;
  t.pctNegro = t.total ? (t.negro / t.total) * 100 : 0;
  return { t, dias: Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha)) };
}

/** Filas para guardar: una por día + punto de venta (el PDF no se guarda, solo estos totales). */
export function filasParaGuardar(libro, asignacion, archivo) {
  const m = {};
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const f of libro.filas) {
    const lado = asignacion[f.pv];
    if (lado !== "blanco" && lado !== "negro") continue;
    const k = f.fecha + "|" + f.pv;
    const g = (m[k] ||= { fecha: f.fecha, pv: f.pv, lado, comprobantes: 0, notas_credito: 0, total: 0, nc_total: 0, neto: 0, exento: 0, percep: 0, iva105: 0, iva21: 0, iva_otros: 0, archivo });
    g.comprobantes++;
    if (f.tipo === "NC") { g.notas_credito++; g.nc_total += f.total; }
    g.total += f.total; g.neto += f.neto; g.exento += f.exento; g.percep += f.percep; g.iva105 += f.iva105; g.iva21 += f.iva21; g.iva_otros += f.ivaOtros;
  }
  return Object.values(m).map((g) => ({ ...g, ...Object.fromEntries(["total", "nc_total", "neto", "exento", "percep", "iva105", "iva21", "iva_otros"].map((k) => [k, r2(g[k])])) }));
}

/** Mismo resumen que resumenVentas, pero a partir de lo guardado en la base (ventas_diarias). */
export function resumenGuardado(rows, desde, hasta) {
  const dias = {};
  for (let d = new Date(desde + "T00:00:00"), fin = new Date(hasta + "T00:00:00"); d <= fin; d.setDate(d.getDate() + 1)) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    dias[k] = { fecha: k, blanco: 0, negro: 0 };
  }
  const t = { blanco: 0, negro: 0, nBlanco: 0, nNegro: 0, ncBlanco: 0, ncNegro: 0, ivaBlanco: 0, netoBlanco: 0, exentoBlanco: 0 };
  const pvs = {};
  for (const r of rows) {
    const v = Number(r.total) || 0, lado = r.lado;
    (dias[r.fecha] ||= { fecha: r.fecha, blanco: 0, negro: 0 })[lado] += v;
    t[lado] += v;
    const p = (pvs[r.pv + "|" + lado] ||= { pv: r.pv, lado, n: 0, total: 0 }); p.n += r.comprobantes; p.total += v;
    if (lado === "blanco") {
      t.nBlanco += r.comprobantes; t.ncBlanco += Number(r.nc_total) || 0;
      t.ivaBlanco += (Number(r.iva105) || 0) + (Number(r.iva21) || 0) + (Number(r.iva_otros) || 0) + (Number(r.percep) || 0);
      t.netoBlanco += Number(r.neto) || 0; t.exentoBlanco += Number(r.exento) || 0;
    } else { t.nNegro += r.comprobantes; t.ncNegro += Number(r.nc_total) || 0; }
  }
  t.total = t.blanco + t.negro;
  t.pctNegro = t.total ? (t.negro / t.total) * 100 : 0;
  return { t, dias: Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha)), pvs: Object.values(pvs).sort((a, b) => a.pv.localeCompare(b.pv)) };
}

/**
 * Compara ventas guardadas (ventas_diarias) con compras cargadas (comprobantes), por sucursal y en general.
 * Compras: facturado = blanco, no facturado = negro; las notas de crédito restan. Ventas: según el punto de venta.
 */
export function compararVentasCompras(ventasRows, compras, desde, hasta, sucursalIds) {
  const n = (v) => Number(v) || 0;
  const vacio = () => ({ ventasBlanco: 0, ventasNegro: 0, comprasBlanco: 0, comprasNegro: 0, ivaDebito: 0, ivaCredito: 0 });
  const grupos = { general: vacio() };
  for (const id of sucursalIds) grupos[id] = vacio();
  const dias = {};
  for (let d = new Date(desde + "T00:00:00"), fin = new Date(hasta + "T00:00:00"); d <= fin; d.setDate(d.getDate() + 1)) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    dias[k] = { fecha: k, ventasBlanco: 0, comprasBlanco: 0, hayVentas: false };
  }
  const sumar = (id, campo, v) => { grupos.general[campo] += v; if (grupos[id]) grupos[id][campo] += v; };
  for (const r of ventasRows) {
    const v = n(r.total);
    if (r.lado === "blanco") {
      sumar(r.sucursal_id, "ventasBlanco", v);
      sumar(r.sucursal_id, "ivaDebito", n(r.iva105) + n(r.iva21) + n(r.iva_otros) + n(r.percep));
      if (dias[r.fecha]) dias[r.fecha].ventasBlanco += v;
    } else sumar(r.sucursal_id, "ventasNegro", v);
    if (dias[r.fecha]) dias[r.fecha].hayVentas = true;
  }
  for (const c of compras) {
    const sg = c.tipo === "NOTA_CREDITO" ? -1 : 1, v = sg * n(c.monto);
    if (c.grupo === "FACTURADO") {
      sumar(c.sucursal_id, "comprasBlanco", v);
      sumar(c.sucursal_id, "ivaCredito", sg * (n(c.iva21) + n(c.iva105) + n(c.iva27) + n(c.iva5) + n(c.iva25)));
      if (dias[c.fecha]) dias[c.fecha].comprasBlanco += v;
    } else sumar(c.sucursal_id, "comprasNegro", v);
  }
  for (const g of Object.values(grupos)) {
    g.dif = g.ventasBlanco - g.comprasBlanco;
    g.cobertura = g.comprasBlanco > 0 ? g.ventasBlanco / g.comprasBlanco : null;
    g.saldoIva = g.ivaDebito - g.ivaCredito;
    g.difNegro = g.ventasNegro - g.comprasNegro;
  }
  let acV = 0, acC = 0;
  const lista = Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha)).map((d) => {
    acV += d.ventasBlanco; acC += d.comprasBlanco;
    return { ...d, acumVentas: acV, acumCompras: acC, acumDif: acV - acC };
  });
  return { grupos, dias: lista, diasSinVentas: lista.filter((d) => !d.hayVentas).length };
}
