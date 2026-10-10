-- =====================================================================
-- Notas de crédito
-- Cada comprobante tiene un tipo: FACTURA (suma) o NOTA_CREDITO (resta).
-- Los importes se guardan siempre en positivo; la app resta las notas de crédito.
-- Los comprobantes que ya existen quedan como FACTURA.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

alter table public.comprobantes
  add column if not exists tipo text not null default 'FACTURA';

alter table public.comprobantes drop constraint if exists comprobantes_tipo_valido;
alter table public.comprobantes
  add constraint comprobantes_tipo_valido check (tipo in ('FACTURA', 'NOTA_CREDITO'));

-- Número de la factura que afecta la nota de crédito (opcional)
alter table public.comprobantes
  add column if not exists factura_ref text;

-- Las notas de crédito tienen su propia numeración: el mismo número puede existir como factura
alter table public.comprobantes drop constraint if exists comprobantes_unico;
alter table public.comprobantes
  add constraint comprobantes_unico unique (proveedor_id, grupo, tipo, numero);

-- La búsqueda de duplicados ahora devuelve también el tipo
drop function if exists public.comprobantes_mismo_numero(uuid, text, uuid);
create function public.comprobantes_mismo_numero(p_proveedor uuid, p_numero text, p_excluir uuid default null)
returns table (id uuid, fecha date, monto numeric, grupo text, sucursal text, numero text, tipo text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.fecha, c.monto, c.grupo::text, s.nombre, c.numero, c.tipo
  from public.comprobantes c
  left join public.sucursales s on s.id = c.sucursal_id
  where (select auth.uid()) is not null
    and c.proveedor_id = p_proveedor
    and public.numero_norm(c.numero) = public.numero_norm(p_numero)
    and (p_excluir is null or c.id <> p_excluir)
  order by c.fecha desc
  limit 5;
$$;

revoke all on function public.comprobantes_mismo_numero(uuid, text, uuid) from public, anon;
grant execute on function public.comprobantes_mismo_numero(uuid, text, uuid) to authenticated;
