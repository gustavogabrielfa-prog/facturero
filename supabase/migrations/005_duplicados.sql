-- =====================================================================
-- Detección de comprobantes duplicados
-- Compara el número sin guiones ni ceros adelante, así "0001-00012345",
-- "000100012345" y "1-12345" cuentan como el mismo comprobante.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- Número normalizado: con guion, punto de venta a 4 dígitos + número a 8; sin guion, solo dígitos.
create or replace function public.numero_norm(n text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  pv  text;
  num text;
  d   text;
begin
  if n like '%-%' then
    pv  := regexp_replace(split_part(n, '-', 1), '\D', '', 'g');
    num := regexp_replace(substring(n from position('-' in n) + 1), '\D', '', 'g');
    d := (case when length(pv)  < 4 then lpad(pv, 4, '0')  else pv  end)
      || (case when length(num) < 8 then lpad(num, 8, '0') else num end);
  else
    d := regexp_replace(coalesce(n, ''), '\D', '', 'g');
  end if;
  d := ltrim(d, '0');
  return case when d = '' then coalesce(n, '') else d end;
end;
$$;

-- Comprobantes del mismo proveedor con el mismo número (para avisar al cargar).
-- security definer: el usuario de carga solo ve lo suyo del día, pero igual tiene que enterarse
-- si otro ya cargó ese comprobante. Devuelve lo mínimo para identificarlo.
create or replace function public.comprobantes_mismo_numero(p_proveedor uuid, p_numero text, p_excluir uuid default null)
returns table (id uuid, fecha date, monto numeric, grupo text, sucursal text, numero text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.fecha, c.monto, c.grupo::text, s.nombre, c.numero
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

create index if not exists comprobantes_prov_numnorm_idx
  on public.comprobantes (proveedor_id, public.numero_norm(numero));
