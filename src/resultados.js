/* Estado de resultados: ventas − costo de ventas (compras) − gastos operativos, mes por mes. */

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "2026-10" -> "octubre 2026" (corto: "oct 26"). */
export function mesLabel(m, corto = false) {
  const [y, mm] = m.split("-").map(Number);
  return corto ? `${MESES[mm - 1].slice(0, 3)} ${String(y).slice(2)}` : `${MESES[mm - 1]} ${y}`;
}

/** Meses "AAAA-MM" entre dos meses, inclusive. */
export function mesesEntre(desde, hasta) {
  const out = [];
  let [y, m] = desde.split("-").map(Number);
  const [y2, m2] = hasta.split("-").map(Number);
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** Suma (o resta) meses a "AAAA-MM". */
export function mesMas(mes, k) {
  const [y, m] = mes.split("-").map(Number);
  const d = new Date(y, m - 1 + k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Último día del mes "AAAA-MM" como "AAAA-MM-DD". */
export function finDeMes(mes) {
  const [y, m] = mes.split("-").map(Number);
  return `${mes}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

/**
 * Arma el estado de resultados por mes para una sucursal o para todas.
 * - Ventas (ventas_diarias): blanco / negro según el punto de venta.
 * - Costos variables (comprobantes): facturado = blanco, no facturado = negro; las notas de crédito restan.
 * - Gastos operativos (costos_fijos): los de la sucursal; los generales se reparten entre las sucursales
 *   según lo que vendió cada una ese mes (si nadie vendió, en partes iguales).
 * - generalesDados ({ "AAAA-MM": monto }): la parte de los generales ya repartida por la base (gerente, que no ve
 *   las ventas de las otras sucursales); si viene, se usa tal cual en vez de repartir acá.
 * - sinIva: a lo blanco se le resta el IVA (débito en ventas, crédito en compras), que no es ingreso ni costo.
 */
export function estadoResultados({ ventas, compras, costos, meses, foco, sucursalIds, sinIva = true, orden = [], generalesDados = null }) {
  const n = (v) => Number(v) || 0;
  const vacio = () => ({ vb: 0, vn: 0, ivaD: 0, cb: 0, cn: 0, ivaC: 0, fijos: {}, hayVentas: false });
  const agg = {};
  const get = (mes, id) => ((agg[mes] ||= {})[id || "general"] ||= vacio());

  for (const r of ventas) {
    const g = get(r.fecha.slice(0, 7), r.sucursal_id);
    g.hayVentas = true;
    if (r.lado === "blanco") { g.vb += n(r.total); g.ivaD += n(r.iva105) + n(r.iva21) + n(r.iva_otros) + n(r.percep); }
    else g.vn += n(r.total);
  }
  for (const c of compras) {
    const g = get(c.fecha.slice(0, 7), c.sucursal_id), sg = c.tipo === "NOTA_CREDITO" ? -1 : 1;
    if (c.grupo === "FACTURADO") { g.cb += sg * n(c.monto); g.ivaC += sg * (n(c.iva21) + n(c.iva105) + n(c.iva27) + n(c.iva5) + n(c.iva25)); }
    else g.cn += sg * n(c.monto);
  }
  for (const c of costos) {
    const g = get(c.mes.slice(0, 7), c.sucursal_id);
    g.fijos[c.categoria] = (g.fijos[c.categoria] || 0) + n(c.monto);
  }

  const todas = foco === "todas";
  const ids = todas ? [...sucursalIds, "general"] : [foco];
  const sumaFijos = (f) => Object.values(f).reduce((a, v) => a + v, 0);

  const cols = meses.map((mes) => {
    const c = { mes, ventasBlanco: 0, ventasNegro: 0, comprasBlanco: 0, comprasNegro: 0, ivaDebito: 0, ivaCredito: 0,
      fijosCat: {}, fijosGenerales: 0, generalesMes: 0, parte: null, hayVentas: false };
    for (const id of ids) {
      const g = agg[mes]?.[id];
      if (!g) continue;
      c.ventasBlanco += g.vb; c.ventasNegro += g.vn; c.comprasBlanco += g.cb; c.comprasNegro += g.cn;
      c.ivaDebito += g.ivaD; c.ivaCredito += g.ivaC; c.hayVentas ||= g.hayVentas;
      for (const [cat, v] of Object.entries(g.fijos)) c.fijosCat[cat] = (c.fijosCat[cat] || 0) + v;
    }
    if (!todas && generalesDados) {
      c.generalesMes = c.fijosGenerales = generalesDados[mes] || 0;
    } else if (!todas) {
      const gen = agg[mes]?.general;
      c.generalesMes = gen ? sumaFijos(gen.fijos) : 0;
      if (c.generalesMes) {
        const vendido = (id) => { const g = agg[mes]?.[id]; return g ? g.vb + g.vn : 0; };
        const totalVendido = sucursalIds.reduce((a, id) => a + vendido(id), 0);
        c.parte = totalVendido > 0 ? vendido(foco) / totalVendido : 1 / Math.max(1, sucursalIds.length);
        c.fijosGenerales = c.generalesMes * c.parte;
      }
    }
    return completar(c, sinIva);
  });

  // Columna total: suma de los meses
  const t = { mes: "total", ventasBlanco: 0, ventasNegro: 0, comprasBlanco: 0, comprasNegro: 0, ivaDebito: 0, ivaCredito: 0,
    fijosCat: {}, fijosGenerales: 0, generalesMes: 0, parte: null, hayVentas: cols.some((c) => c.hayVentas) };
  for (const c of cols) {
    for (const k of ["ventasBlanco", "ventasNegro", "comprasBlanco", "comprasNegro", "ivaDebito", "ivaCredito", "fijosGenerales", "generalesMes"]) t[k] += c[k];
    for (const [cat, v] of Object.entries(c.fijosCat)) t.fijosCat[cat] = (t.fijosCat[cat] || 0) + v;
  }
  if (t.generalesMes && !generalesDados) t.parte = t.fijosGenerales / t.generalesMes;
  const total = completar(t, sinIva);

  const presentes = new Set(cols.flatMap((c) => Object.keys(c.fijosCat)));
  // en el orden de la lista de gastos; los que no están en la lista, al final
  const categorias = [...orden.filter((c) => presentes.has(c)),
    ...[...presentes].filter((c) => !orden.includes(c)).sort((a, b) => a.localeCompare(b))];

  return { cols, total, categorias, sinIva };
}

/** Subtotales, margen, resultado y punto de equilibrio de una columna. */
function completar(c, sinIva) {
  const vb = c.ventasBlanco - (sinIva ? c.ivaDebito : 0);
  const cb = c.comprasBlanco - (sinIva ? c.ivaCredito : 0);
  const ingresos = vb + c.ventasNegro;
  const variables = cb + c.comprasNegro;
  const margen = ingresos - variables;
  const fijos = Object.values(c.fijosCat).reduce((a, v) => a + v, 0) + c.fijosGenerales;
  const resultado = margen - fijos;
  const margenPct = ingresos ? (margen / ingresos) * 100 : null;
  return {
    ...c, vb, cb, ingresos, variables, margen, fijos, resultado, margenPct,
    resultadoPct: ingresos ? (resultado / ingresos) * 100 : null,
    // ventas necesarias para cubrir los gastos operativos con el margen de ese período
    equilibrio: margen > 0 && ingresos > 0 ? fijos / (margen / ingresos) : null,
    saldoIva: c.ivaDebito - c.ivaCredito,
  };
}
