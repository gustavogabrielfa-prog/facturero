-- =====================================================================
-- Ventas: resumen por sucursal + día + punto de venta, leído del Libro de IVA Ventas (PDF).
-- El PDF no se guarda; solo estos totales. Blanco / negro es lo que se eligió al subirlo.
-- Volver a subir un período reemplaza esos días de esa sucursal (no duplica).
-- Solo el administrador ve y guarda ventas.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

create table if not exists public.ventas_diarias (
  id             uuid primary key default gen_random_uuid(),
  sucursal_id    uuid not null references public.sucursales (id) on delete restrict,
  fecha          date not null,
  pv             text not null check (pv ~ '^\d{4,5}$'),
  lado           text not null check (lado in ('blanco', 'negro')),
  comprobantes   integer not null default 0,
  notas_credito  integer not null default 0,
  total          numeric(14,2) not null default 0,   -- ya con las notas de crédito restadas
  nc_total       numeric(14,2) not null default 0,   -- importe de las notas de crédito (negativo)
  neto           numeric(14,2) not null default 0,
  exento         numeric(14,2) not null default 0,
  percep         numeric(14,2) not null default 0,
  iva105         numeric(14,2) not null default 0,
  iva21          numeric(14,2) not null default 0,
  iva_otros      numeric(14,2) not null default 0,
  archivo        text,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint ventas_diarias_unico unique (sucursal_id, fecha, pv)
);
create index if not exists ventas_diarias_fecha_idx on public.ventas_diarias (fecha);

alter table public.ventas_diarias enable row level security;
drop policy if exists ventas_admin_all on public.ventas_diarias;
create policy ventas_admin_all on public.ventas_diarias
  for all to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

-- Guarda un libro de una vez: borra ese período de esa sucursal y carga las filas nuevas (todo o nada).
create or replace function public.guardar_ventas(p_sucursal uuid, p_desde date, p_hasta date, p_filas jsonb)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare n integer;
begin
  if not (select public.es_admin()) then raise exception 'Solo el administrador puede guardar ventas.'; end if;
  delete from public.ventas_diarias where sucursal_id = p_sucursal and fecha between p_desde and p_hasta;
  insert into public.ventas_diarias (sucursal_id, fecha, pv, lado, comprobantes, notas_credito, total, nc_total,
                                     neto, exento, percep, iva105, iva21, iva_otros, archivo)
  select p_sucursal, (f->>'fecha')::date, f->>'pv', f->>'lado', (f->>'comprobantes')::int, (f->>'notas_credito')::int,
         (f->>'total')::numeric, (f->>'nc_total')::numeric, (f->>'neto')::numeric, (f->>'exento')::numeric,
         (f->>'percep')::numeric, (f->>'iva105')::numeric, (f->>'iva21')::numeric, (f->>'iva_otros')::numeric, f->>'archivo'
  from jsonb_array_elements(p_filas) f
  where (f->>'fecha')::date between p_desde and p_hasta;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function public.guardar_ventas(uuid, date, date, jsonb) to authenticated;

-- Verificación
select count(*) as filas_ventas from public.ventas_diarias;
