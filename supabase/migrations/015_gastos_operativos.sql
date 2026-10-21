-- =====================================================================
-- Gastos operativos: lista editable de conceptos (Alquiler, Luz, Plex, CAPROSA…) y
-- un solo importe por concepto + mes + sucursal (se carga en una grilla como la planilla).
-- Ejecutar después de 014_costos_fijos.sql.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- 1) Lista de conceptos (el administrador agrega, renombra, ordena o quita)
create table if not exists public.gastos_conceptos (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique check (length(trim(nombre)) > 0),
  activo      boolean not null default true,   -- "quitar" lo oculta de la grilla; los importes viejos se conservan
  orden       int not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.gastos_conceptos enable row level security;
drop policy if exists gastos_conceptos_admin_all on public.gastos_conceptos;
create policy gastos_conceptos_admin_all on public.gastos_conceptos
  for all to authenticated
  using ((select public.es_admin())) with check ((select public.es_admin()));

insert into public.gastos_conceptos (nombre, orden) values
  ('Alquiler', 1), ('Luz', 2), ('Impuesto Municipal', 3), ('Internet', 4), ('Plex', 5),
  ('CAPROSA', 6), ('Contador', 7), ('Limpieza', 8), ('Empleado', 9), ('Banco Macro', 10),
  ('Carga de saldo celu', 11), ('Monotributo', 12), ('Bolsas', 13), ('Colegio Farmacéutico', 14), ('Papel de la fiscal', 15)
on conflict (nombre) do nothing;

-- Lo que ya se haya cargado con otro nombre pasa a ser un concepto más
insert into public.gastos_conceptos (nombre, orden)
select distinct categoria, 100 from public.costos_fijos
on conflict (nombre) do nothing;

-- 2) Un importe por concepto + mes + sucursal: si había varios, se suman en uno
with g as (
  select (array_agg(id order by created_at))[1] as queda, sum(monto) as total, mes, sucursal_id, categoria
  from public.costos_fijos group by mes, sucursal_id, categoria having count(*) > 1
)
update public.costos_fijos c set monto = g.total from g where c.id = g.queda;

delete from public.costos_fijos c
using (
  select (array_agg(id order by created_at))[1] as queda, mes, sucursal_id, categoria
  from public.costos_fijos group by mes, sucursal_id, categoria having count(*) > 1
) g
where c.mes = g.mes and c.sucursal_id is not distinct from g.sucursal_id and c.categoria = g.categoria and c.id <> g.queda;

create unique index if not exists costos_fijos_unico
  on public.costos_fijos (mes, coalesce(sucursal_id, '00000000-0000-0000-0000-000000000000'::uuid), categoria);

-- 3) Renombrar un concepto renombra también sus importes
create or replace function public.gastos_conceptos_renombrar()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.nombre is distinct from old.nombre then
    update public.costos_fijos set categoria = new.nombre where categoria = old.nombre;
  end if;
  return new;
end;
$$;

drop trigger if exists gastos_conceptos_renombrar on public.gastos_conceptos;
create trigger gastos_conceptos_renombrar
  after update on public.gastos_conceptos
  for each row execute function public.gastos_conceptos_renombrar();

-- 4) Guardar una celda de la grilla: importe 0 o vacío la borra
create or replace function public.guardar_gasto(p_mes date, p_sucursal uuid, p_categoria text, p_monto numeric)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not (select public.es_admin()) then raise exception 'Solo el administrador carga gastos.'; end if;
  if coalesce(p_monto, 0) < 0 then raise exception 'El importe no puede ser negativo.'; end if;
  delete from public.costos_fijos
    where mes = date_trunc('month', p_mes)::date and sucursal_id is not distinct from p_sucursal and categoria = p_categoria;
  if coalesce(p_monto, 0) > 0 then
    insert into public.costos_fijos (mes, sucursal_id, categoria, monto)
    values (date_trunc('month', p_mes)::date, p_sucursal, p_categoria, p_monto);
  end if;
end;
$$;
grant execute on function public.guardar_gasto(date, uuid, text, numeric) to authenticated;

-- Verificación
select nombre, activo, orden from public.gastos_conceptos order by orden, nombre;
