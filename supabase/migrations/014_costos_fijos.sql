-- =====================================================================
-- Costos fijos por mes (alquiler, sueldos, servicios…) para el Estado de resultados.
-- Cada costo es de una sucursal o general (sucursal_id vacío = compartido entre sucursales).
-- Solo el administrador los ve y los carga.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

create table if not exists public.costos_fijos (
  id           uuid primary key default gen_random_uuid(),
  mes          date not null check (extract(day from mes) = 1),   -- primer día del mes
  sucursal_id  uuid references public.sucursales (id) on delete restrict,   -- null = general
  categoria    text not null check (length(trim(categoria)) > 0),
  concepto     text,
  monto        numeric(14,2) not null check (monto >= 0),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists costos_fijos_mes_idx on public.costos_fijos (mes);

alter table public.costos_fijos enable row level security;
drop policy if exists costos_fijos_admin_all on public.costos_fijos;
create policy costos_fijos_admin_all on public.costos_fijos
  for all to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

-- Verificación
select count(*) as costos_fijos from public.costos_fijos;
