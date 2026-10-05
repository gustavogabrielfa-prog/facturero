-- =====================================================================
-- Otros tributos y tasas (tasa municipal, seguridad e higiene, etc.)
-- Lista editable por el administrador desde la app. El monto de cada
-- tributo se guarda en comprobantes.tributos como { "<id>": monto }.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

create table if not exists public.tributos (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique check (length(trim(nombre)) > 0),
  activo      boolean not null default true,   -- "quitar" lo desactiva: los comprobantes viejos conservan el nombre
  orden       int not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.tributos enable row level security;

drop policy if exists tributos_select on public.tributos;
create policy tributos_select on public.tributos
  for select to authenticated using (true);

drop policy if exists tributos_admin_write on public.tributos;
create policy tributos_admin_write on public.tributos
  for all to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

-- Montos por comprobante: objeto { id_tributo: número >= 0 }
create or replace function public.tributos_validos(j jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(j) = 'object'
     and coalesce((
       select bool_and(case when jsonb_typeof(value) = 'number'
                            then (value #>> '{}')::numeric >= 0 else false end)
       from jsonb_each(j)
     ), true);
$$;

alter table public.comprobantes
  add column if not exists tributos jsonb not null default '{}'::jsonb;

alter table public.comprobantes drop constraint if exists comprobantes_tributos_validos;
alter table public.comprobantes
  add constraint comprobantes_tributos_validos check (public.tributos_validos(tributos));

-- Valores iniciales (el admin los puede renombrar, quitar o sumar otros desde la app)
insert into public.tributos (nombre, orden) values
  ('Tasa municipal', 1),
  ('Otros tributos', 2)
on conflict (nombre) do nothing;
