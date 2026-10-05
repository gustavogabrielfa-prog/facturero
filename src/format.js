export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

export function fmtMoney(n) {
  return (Number(n) || 0).toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function localISO(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function todayISO() { return localISO(new Date()); }
export function weekRange() {
  const d = new Date(); const day = (d.getDay() + 6) % 7;
  const monday = new Date(d); monday.setDate(d.getDate() - day);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return [localISO(monday), localISO(sunday)];
}
export function monthRange() {
  const d = new Date();
  return [localISO(new Date(d.getFullYear(), d.getMonth(), 1)), localISO(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
}
export function yearRange() { const y = new Date().getFullYear(); return [`${y}-01-01`, `${y}-12-31`]; }

export const IMPUESTOS = [
  ["iva21", "IVA 21%"], ["iva105", "IVA 10,5%"], ["iva27", "IVA 27%"], ["iva5", "IVA 5%"], ["iva25", "IVA 2,5%"],
];

export function computeTotals(list) {
  const t = { fact: 0, noFact: 0, iva21: 0, iva105: 0, iva27: 0, iva5: 0, iva25: 0, iibb: 0 };
  for (const c of list) {
    if (c.grupo === "FACTURADO") t.fact += Number(c.monto) || 0; else t.noFact += Number(c.monto) || 0;
    for (const [k] of IMPUESTOS) t[k] += Number(c[k]) || 0;
    t.iibb += Number(c.iibb) || 0;
  }
  t.ivaTotal = t.iva21 + t.iva105 + t.iva27 + t.iva5 + t.iva25;
  t.impuestosTotal = t.ivaTotal + t.iibb;
  t.total = t.fact + t.noFact;
  return t;
}

function isoWeekKey(iso) {
  const d = new Date(iso + "T00:00:00");
  const target = new Date(d.valueOf());
  target.setDate(target.getDate() - ((d.getDay() + 6) % 7) + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return target.getFullYear() + "-S" + String(week).padStart(2, "0");
}
export function periodKey(iso, gran) {
  if (gran === "dia") return iso;
  if (gran === "semana") return isoWeekKey(iso);
  if (gran === "mes") return iso.slice(0, 7);
  return iso.slice(0, 4);
}
export function periodLabel(key, gran) {
  if (gran === "dia") return fmtDate(key);
  if (gran === "semana") { const [y, w] = key.split("-S"); return `Semana ${w} · ${y}`; }
  if (gran === "mes") {
    const [y, m] = key.split("-");
    return ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"][parseInt(m, 10) - 1] + " " + y;
  }
  return key;
}

/** Agrupa por una clave y suma blanco/negro. */
export function groupBy(list, keyFn) {
  const map = {};
  for (const c of list) {
    const k = keyFn(c);
    if (!map[k]) map[k] = { key: k, fact: 0, noFact: 0 };
    if (c.grupo === "FACTURADO") map[k].fact += Number(c.monto) || 0; else map[k].noFact += Number(c.monto) || 0;
  }
  return Object.values(map);
}
export function groupByPeriod(list, gran) {
  return groupBy(list, (c) => periodKey(c.fecha, gran)).sort((a, b) => b.key.localeCompare(a.key));
}

/** Todas las claves de período entre dos fechas (incluye las vacías, en orden). */
export function periodKeysBetween(desde, hasta, gran) {
  const keys = [];
  const d = new Date(desde + "T00:00:00"), end = new Date(hasta + "T00:00:00");
  for (; d <= end; d.setDate(d.getDate() + 1)) {
    const k = periodKey(localISO(d), gran);
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  return keys;
}

/** Etiqueta corta para el eje del gráfico. */
export function periodShort(key, gran, multiYear) {
  if (gran === "dia") return key.slice(8, 10) + "/" + key.slice(5, 7);
  if (gran === "semana") return "S" + key.split("-S")[1];
  if (gran === "mes") {
    const m = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"][parseInt(key.slice(5, 7), 10) - 1];
    return multiYear ? m + " " + key.slice(2, 4) : m;
  }
  return key;
}

export function fmtCompact(n) {
  return "$ " + (Number(n) || 0).toLocaleString("es-AR", { notation: "compact", maximumFractionDigits: 1 });
}

export function last30Range() {
  const h = new Date(), d = new Date(); d.setDate(d.getDate() - 29);
  return [localISO(d), localISO(h)];
}
export function prevMonthRange() {
  const d = new Date();
  return [localISO(new Date(d.getFullYear(), d.getMonth() - 1, 1)), localISO(new Date(d.getFullYear(), d.getMonth(), 0))];
}

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const isFirstOfMonth = (d) => d.getDate() === 1;
const isLastOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getDate() === 1;
const addMonthsClamped = (d, n) => {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
};

/**
 * Período anterior comparable. Si el rango llega al futuro (ej. "este mes" a día 5),
 * se compara solo hasta hoy contra los mismos días del período anterior.
 * Rangos de meses completos se corren por meses; el resto, por la misma cantidad de días.
 */
export function prevRange(desde, hasta) {
  const D = new Date(desde + "T00:00:00"), H = new Date(hasta + "T00:00:00");
  const hoy = new Date(todayISO() + "T00:00:00");
  const efH = H > hoy && D <= hoy ? hoy : H;
  if (isFirstOfMonth(D) && isLastOfMonth(H)) {
    const meses = (H.getFullYear() - D.getFullYear()) * 12 + H.getMonth() - D.getMonth() + 1;
    const ps = new Date(D.getFullYear(), D.getMonth() - meses, 1);
    const pe = efH < H ? addMonthsClamped(efH, -meses) : new Date(D.getFullYear(), D.getMonth(), 0);
    return { desde: localISO(ps), hasta: localISO(pe), hastaActual: localISO(efH) };
  }
  const dias = Math.round((efH - D) / 864e5) + 1;
  const pe = new Date(D); pe.setDate(pe.getDate() - 1);
  const ps = new Date(pe); ps.setDate(ps.getDate() - dias + 1);
  return { desde: localISO(ps), hasta: localISO(pe), hastaActual: localISO(efH) };
}

/** "Sep 2026", "2025" o "01/09 al 05/09" */
export function rangeLabel(desde, hasta) {
  const D = new Date(desde + "T00:00:00"), H = new Date(hasta + "T00:00:00");
  if (isFirstOfMonth(D) && isLastOfMonth(H)) {
    if (D.getMonth() === 0 && H.getMonth() === 11 && D.getFullYear() === H.getFullYear()) return String(D.getFullYear());
    if (D.getMonth() === H.getMonth() && D.getFullYear() === H.getFullYear()) return MESES[D.getMonth()] + " " + D.getFullYear();
  }
  const f = (d) => String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0");
  if (desde === hasta) return f(D);
  return `${f(D)} al ${f(H)}${D.getFullYear() !== H.getFullYear() || D.getFullYear() !== new Date().getFullYear() ? " " + H.getFullYear() : ""}`;
}
