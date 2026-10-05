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
