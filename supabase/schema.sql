-- =====================================================================
-- Facturero — esquema de base de datos para Supabase
-- Pegar completo en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
do $$ begin
  create type public.grupo_comprobante as enum ('FACTURADO', 'NO_FACTURADO');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.rol_usuario as enum ('admin', 'carga', 'gerente');
exception when duplicate_object then null; end $$;
alter type public.rol_usuario add value if not exists 'gerente';

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table if not exists public.sucursales (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique check (length(trim(nombre)) > 0),
  created_at  timestamptz not null default now()
);

-- Un perfil por usuario de Supabase Auth.
--   rol 'carga' : solo puede cargar comprobantes en SU sucursal.
--   rol 'gerente': ve listado, totales y reportes de SU sucursal; carga solo en ella, no borra.
--   rol 'admin' : ve listado, totales, reportes y puede cargar en cualquier sucursal.
create table if not exists public.perfiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  nombre       text,
  rol          public.rol_usuario not null default 'carga',
  sucursal_id  uuid references public.sucursales (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists public.proveedores (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null check (length(trim(nombre)) > 0),
  cuit        text unique check (cuit is null or cuit ~ '^\d{2}-\d{8}-\d$'),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.comprobantes (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references public.sucursales (id) on delete restrict,
  proveedor_id  uuid not null references public.proveedores (id) on delete restrict,
  grupo         public.grupo_comprobante not null,
  fecha         date not null default current_date,
  numero        text not null check (length(trim(numero)) > 0),
  monto         numeric(14,2) not null check (monto >= 0),
  iva21         numeric(14,2) not null default 0 check (iva21  >= 0),
  iva105        numeric(14,2) not null default 0 check (iva105 >= 0),
  iva27         numeric(14,2) not null default 0 check (iva27  >= 0),
  iva5          numeric(14,2) not null default 0 check (iva5   >= 0),
  iva25         numeric(14,2) not null default 0 check (iva25  >= 0),
  iibb          numeric(14,2) not null default 0 check (iibb   >= 0),
  notas         text,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  -- Evita cargar dos veces el mismo comprobante del mismo proveedor
  constraint comprobantes_unico unique (proveedor_id, grupo, numero)
);

create index if not exists comprobantes_fecha_idx          on public.comprobantes (fecha);
create index if not exists comprobantes_sucursal_fecha_idx on public.comprobantes (sucursal_id, fecha);
create index if not exists comprobantes_proveedor_idx      on public.comprobantes (proveedor_id);
create index if not exists perfiles_sucursal_idx           on public.perfiles (sucursal_id);

-- ---------------------------------------------------------------------
-- Funciones auxiliares (security definer para no recursar en RLS)
-- ---------------------------------------------------------------------
create or replace function public.es_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and rol = 'admin'
  );
$$;

-- rol::text: así el script corre de una sola vez aunque 'gerente' recién se haya agregado al enum
create or replace function public.es_gerente()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and rol::text = 'gerente'
  );
$$;

create or replace function public.mi_sucursal()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select sucursal_id from public.perfiles where id = auth.uid();
$$;

-- Crea el perfil automáticamente cuando se da de alta un usuario en Auth
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.perfiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Perfiles para usuarios que ya existían antes de correr este script
insert into public.perfiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.sucursales   enable row level security;
alter table public.perfiles     enable row level security;
alter table public.proveedores  enable row level security;
alter table public.comprobantes enable row level security;

-- sucursales: todos los usuarios logueados las ven; solo admin las modifica
drop policy if exists sucursales_select on public.sucursales;
create policy sucursales_select on public.sucursales
  for select to authenticated using (true);

drop policy if exists sucursales_admin_write on public.sucursales;
create policy sucursales_admin_write on public.sucursales
  for all to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

-- perfiles: cada uno ve el suyo; admin ve y edita todos
drop policy if exists perfiles_select on public.perfiles;
create policy perfiles_select on public.perfiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.es_admin()));

drop policy if exists perfiles_admin_update on public.perfiles;
create policy perfiles_admin_update on public.perfiles
  for update to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

-- proveedores: todos ven y agregan; solo admin edita o borra
drop policy if exists proveedores_select on public.proveedores;
create policy proveedores_select on public.proveedores
  for select to authenticated using (true);

drop policy if exists proveedores_insert on public.proveedores;
create policy proveedores_insert on public.proveedores
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists proveedores_admin_update on public.proveedores;
create policy proveedores_admin_update on public.proveedores
  for update to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

drop policy if exists proveedores_admin_delete on public.proveedores;
create policy proveedores_admin_delete on public.proveedores
  for delete to authenticated using ((select public.es_admin()));

-- comprobantes:
--   carga  -> INSERT en su propia sucursal; ve lo cargado hoy en su sucursal (no ve listado ni totales)
--   gerente-> ve, inserta, corrige y elimina solo en su sucursal
--   admin  -> todo
drop policy if exists comprobantes_admin_select on public.comprobantes;
create policy comprobantes_admin_select on public.comprobantes
  for select to authenticated using ((select public.es_admin()));

drop policy if exists comprobantes_gerente_select on public.comprobantes;
create policy comprobantes_gerente_select on public.comprobantes
  for select to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

-- cualquier usuario ve lo que él mismo cargó HOY (hora Argentina): historial del día
drop policy if exists comprobantes_propios_hoy on public.comprobantes;
create policy comprobantes_propios_hoy on public.comprobantes
  for select to authenticated
  using (
    created_by = (select auth.uid())
    and created_at >= (date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                       at time zone 'America/Argentina/Buenos_Aires')
  );

-- cualquier usuario ve lo que se cargó HOY en su sucursal: "Cargados hoy" compartido
drop policy if exists comprobantes_sucursal_hoy on public.comprobantes;
create policy comprobantes_sucursal_hoy on public.comprobantes
  for select to authenticated
  using (
    sucursal_id = (select public.mi_sucursal())
    and created_at >= (date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                       at time zone 'America/Argentina/Buenos_Aires')
  );

drop policy if exists comprobantes_insert on public.comprobantes;
create policy comprobantes_insert on public.comprobantes
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and ((select public.es_admin()) or sucursal_id = (select public.mi_sucursal()))
  );

drop policy if exists comprobantes_admin_update on public.comprobantes;
create policy comprobantes_admin_update on public.comprobantes
  for update to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

drop policy if exists comprobantes_admin_delete on public.comprobantes;
create policy comprobantes_admin_delete on public.comprobantes
  for delete to authenticated using ((select public.es_admin()));

drop policy if exists comprobantes_gerente_update on public.comprobantes;
create policy comprobantes_gerente_update on public.comprobantes
  for update to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()))
  with check ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

drop policy if exists comprobantes_gerente_delete on public.comprobantes;
create policy comprobantes_gerente_delete on public.comprobantes
  for delete to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

-- ---------------------------------------------------------------------
-- Otros tributos y tasas (lista editable por el admin; montos en comprobantes.tributos)
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Realtime: el listado se actualiza solo cuando hay cambios
-- (los eventos respetan RLS: admin recibe todos, gerente los de su sucursal)
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.comprobantes;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.proveedores;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Datos iniciales
-- ---------------------------------------------------------------------
insert into public.sucursales (nombre) values
  ('Farmacia Argus 1'),
  ('Farmacia Argus 2')
on conflict (nombre) do nothing;

-- =====================================================================
-- DESPUÉS DE CREAR LOS USUARIOS (Authentication > Users > Add user),
-- asignales rol y sucursal. Reemplazá los emails y ejecutá:
-- =====================================================================
-- update public.perfiles set rol = 'admin'
--   where email = 'admin@ejemplo.com';
--
-- Gerente (necesita también sucursal_id):
-- update public.perfiles set rol = 'gerente'
--   where email = 'gerente@ejemplo.com';
--
-- update public.perfiles
--   set sucursal_id = (select id from public.sucursales where nombre = 'Farmacia Argus 1')
--   where email = 'argus1@ejemplo.com';
--
-- update public.perfiles
--   set sucursal_id = (select id from public.sucursales where nombre = 'Farmacia Argus 2')
--   where email = 'argus2@ejemplo.com';

-- ---------------------------------------------------------------------
-- Fecha no posterior a hoy y sigla de quien cargó (migración 010)
-- ---------------------------------------------------------------------
-- Sigla de cada usuario: admin = AD; el resto, lo que va antes de la @ (a2@... = A2)
alter table public.perfiles add column if not exists sigla text;
update public.perfiles
  set sigla = case when rol::text = 'admin' then 'AD' else upper(split_part(email, '@', 1)) end
  where sigla is null;

alter table public.comprobantes add column if not exists cargado_por text;

create or replace function public.comprobantes_antes_de_guardar()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.fecha is distinct from old.fecha)
     and new.fecha > (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception 'La fecha no puede ser posterior a hoy.';
  end if;
  if tg_op = 'INSERT' then
    new.cargado_por := (select p.sigla from public.perfiles p where p.id = auth.uid());
  else
    new.cargado_por := old.cargado_por;   -- corregir no cambia quién lo cargó
  end if;
  return new;
end;
$$;

drop trigger if exists comprobantes_antes_de_guardar on public.comprobantes;
create trigger comprobantes_antes_de_guardar
  before insert or update on public.comprobantes
  for each row execute function public.comprobantes_antes_de_guardar();

-- Completar los ya cargados con la sigla actual (si corregís una sigla, volvé a ejecutar este archivo).
-- El trigger conserva cargado_por en UPDATE, así que se desactiva un momento.
alter table public.comprobantes disable trigger comprobantes_antes_de_guardar;
update public.comprobantes c set cargado_por = p.sigla
  from public.perfiles p where p.id = c.created_by;
alter table public.comprobantes enable trigger comprobantes_antes_de_guardar;

-- ---------------------------------------------------------------------
-- Ventas: resumen por sucursal + día + punto de venta (migración 011)
-- ---------------------------------------------------------------------
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
