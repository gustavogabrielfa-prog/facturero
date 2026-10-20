-- =====================================================================
-- Ventas:
--  1) Punto de venta en blanco de cada sucursal (detecta sola la sucursal al subir el PDF).
--  2) Carga manual por día (blanco / negro) además del PDF.
--  3) El gerente carga a mano y ve solo las ventas de SU sucursal; el PDF sigue siendo del administrador.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- 1) Punto de venta en blanco de cada sucursal
alter table public.sucursales add column if not exists pv_blanco text check (pv_blanco is null or pv_blanco ~ '^\d{4,5}$');
update public.sucursales set pv_blanco = '0006' where nombre = 'Farmacia Argus 1' and pv_blanco is null;
update public.sucursales set pv_blanco = '0007' where nombre = 'Farmacia Argus 2' and pv_blanco is null;

-- 2) Filas manuales: pv = 'MANUAL', una para blanco y otra para negro del mismo día
alter table public.ventas_diarias add column if not exists origen text not null default 'pdf' check (origen in ('pdf', 'manual'));
alter table public.ventas_diarias drop constraint if exists ventas_diarias_pv_check;
alter table public.ventas_diarias add constraint ventas_diarias_pv_check check (pv ~ '^\d{4,5}$' or pv = 'MANUAL');
alter table public.ventas_diarias drop constraint if exists ventas_diarias_unico;
alter table public.ventas_diarias add constraint ventas_diarias_unico unique (sucursal_id, fecha, pv, lado);

-- 3) Gerente: ve su sucursal; carga, corrige y borra solo lo manual de su sucursal
drop policy if exists ventas_gerente_select on public.ventas_diarias;
create policy ventas_gerente_select on public.ventas_diarias
  for select to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

drop policy if exists ventas_gerente_insert on public.ventas_diarias;
create policy ventas_gerente_insert on public.ventas_diarias
  for insert to authenticated
  with check ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()) and origen = 'manual');

drop policy if exists ventas_gerente_delete on public.ventas_diarias;
create policy ventas_gerente_delete on public.ventas_diarias
  for delete to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()) and origen = 'manual');

-- Carga manual de un día (reemplaza la carga manual anterior de ese día). Si el día ya vino del PDF, no se pisa.
create or replace function public.guardar_venta_manual(p_sucursal uuid, p_fecha date, p_blanco numeric, p_negro numeric, p_iva numeric)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not ((select public.es_admin()) or ((select public.es_gerente()) and p_sucursal = (select public.mi_sucursal()))) then
    raise exception 'Solo podés cargar ventas de tu sucursal.';
  end if;
  if p_fecha > (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception 'La fecha no puede ser posterior a hoy.';
  end if;
  if coalesce(p_blanco, 0) < 0 or coalesce(p_negro, 0) < 0 or coalesce(p_iva, 0) < 0 then
    raise exception 'Los importes no pueden ser negativos.';
  end if;
  if exists (select 1 from public.ventas_diarias where sucursal_id = p_sucursal and fecha = p_fecha and origen = 'pdf') then
    raise exception 'Ese día ya tiene ventas cargadas desde el PDF del sistema.';
  end if;
  delete from public.ventas_diarias where sucursal_id = p_sucursal and fecha = p_fecha and origen = 'manual';
  insert into public.ventas_diarias (sucursal_id, fecha, pv, lado, origen, comprobantes, total, iva21)
  values (p_sucursal, p_fecha, 'MANUAL', 'blanco', 'manual', 0, coalesce(p_blanco, 0), coalesce(p_iva, 0)),
         (p_sucursal, p_fecha, 'MANUAL', 'negro',  'manual', 0, coalesce(p_negro, 0), 0);
end;
$$;
grant execute on function public.guardar_venta_manual(uuid, date, numeric, numeric, numeric) to authenticated;

-- Verificación
select nombre, pv_blanco from public.sucursales order by nombre;
