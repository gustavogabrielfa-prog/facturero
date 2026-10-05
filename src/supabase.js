import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configOk = Boolean(url && anonKey && !url.includes("<project-ref>"));

export const sb = configOk
  ? createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

/** Trae todas las filas paginando (PostgREST devuelve hasta 1000 por pedido). */
export async function fetchAll(buildQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

/** Traduce errores de Postgres/Supabase a mensajes para el usuario. */
export function errorMsg(error, contexto = "") {
  if (!error) return "";
  switch (error.code) {
    case "23505":
      if (contexto === "proveedor") return "Ya existe un proveedor con ese CUIT.";
      return "Ese comprobante ya fue cargado (mismo proveedor, tipo y número).";
    case "23503":
      return contexto === "proveedor"
        ? "No se puede eliminar: el proveedor tiene comprobantes cargados."
        : "Referencia inválida (proveedor o sucursal inexistente).";
    case "23514":
      return contexto === "proveedor"
        ? "CUIT inválido. Usá el formato 30-12345678-9."
        : "Algún valor no es válido (montos negativos o campos vacíos).";
    case "42501":
      return "No tenés permiso para hacer esto.";
  }
  if (error.message === "Invalid login credentials") return "Email o contraseña incorrectos.";
  return error.message || "Ocurrió un error inesperado.";
}
