-- =====================================================================
-- Rol 'gerente': ve listado, totales y reportes SOLO de su sucursal.
-- Carga comprobantes solo en su sucursal y no puede eliminar.
--
-- Supabase Dashboard > SQL Editor. Se ejecuta en DOS PASOS, porque
-- Postgres no deja usar un valor nuevo de enum en la misma ejecución
-- en que se crea. Se puede repetir sin romper nada.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PASO 1 — seleccioná solo esta línea y Run
-- ---------------------------------------------------------------------
alter type public.rol_usuario add value if not exists 'gerente';


-- ---------------------------------------------------------------------
-- PASO 2 — seleccioná desde acá hasta el final y Run
-- ---------------------------------------------------------------------
create or replace function public.es_gerente()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and rol::text = 'gerente'
  );
$$;

-- El gerente ve los comprobantes de su sucursal (el admin ya ve todos)
drop policy if exists comprobantes_gerente_select on public.comprobantes;
create policy comprobantes_gerente_select on public.comprobantes
  for select to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

-- Asignar el rol
update public.perfiles set rol = 'gerente'
  where lower(email) = 'a2@gmail.com';

-- El gerente necesita una sucursal. Si la verificación de abajo la muestra vacía,
-- descomentá esto con la sucursal correcta y ejecutalo:
-- update public.perfiles
--   set sucursal_id = (select id from public.sucursales where nombre = 'Farmacia Argus 2')
--   where lower(email) = 'a2@gmail.com';

-- Verificación
select p.email, p.rol, s.nombre as sucursal
from public.perfiles p left join public.sucursales s on s.id = p.sucursal_id
where lower(p.email) = 'a2@gmail.com';
