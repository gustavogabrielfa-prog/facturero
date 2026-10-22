-- =====================================================================
-- Gerente y gastos operativos:
--  - puede AGREGAR gastos a la lista (renombrar, ordenar y quitar sigue siendo del administrador)
--  - carga importes de SU sucursal, pero una vez guardados NO los puede cambiar ni borrar
--    (si se equivocó, lo corrige el administrador)
-- Ejecutar después de 016_resultados_gerente.sql.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- Lista de gastos: el gerente agrega (entra activo)
drop policy if exists gastos_conceptos_gerente_insert on public.gastos_conceptos;
create policy gastos_conceptos_gerente_insert on public.gastos_conceptos
  for insert to authenticated
  with check ((select public.es_gerente()) and activo);

-- Importes de su sucursal: ver y cargar, no cambiar ni borrar
drop policy if exists costos_fijos_gerente_all on public.costos_fijos;
drop policy if exists costos_fijos_gerente_select on public.costos_fijos;
create policy costos_fijos_gerente_select on public.costos_fijos
  for select to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));
drop policy if exists costos_fijos_gerente_insert on public.costos_fijos;
create policy costos_fijos_gerente_insert on public.costos_fijos
  for insert to authenticated
  with check ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

-- Guardar un importe: el administrador cambia o borra; el gerente solo carga lo que todavía no está
create or replace function public.guardar_gasto(p_mes date, p_sucursal uuid, p_categoria text, p_monto numeric)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare v_mes date := date_trunc('month', p_mes)::date;
begin
  if coalesce(p_monto, 0) < 0 then raise exception 'El importe no puede ser negativo.'; end if;
  if (select public.es_admin()) then
    delete from public.costos_fijos
      where mes = v_mes and sucursal_id is not distinct from p_sucursal and categoria = p_categoria;
  elsif (select public.es_gerente()) and p_sucursal = (select public.mi_sucursal()) then
    if exists (select 1 from public.costos_fijos where mes = v_mes and sucursal_id = p_sucursal and categoria = p_categoria) then
      raise exception 'Ese gasto ya está cargado. Para cambiarlo, pedíselo al administrador.';
    end if;
  else
    raise exception 'Solo podés cargar gastos de tu sucursal.';
  end if;
  if coalesce(p_monto, 0) > 0 then
    insert into public.costos_fijos (mes, sucursal_id, categoria, monto)
    values (v_mes, p_sucursal, p_categoria, p_monto);
  end if;
end;
$$;
grant execute on function public.guardar_gasto(date, uuid, text, numeric) to authenticated;

-- Verificación
select policyname, cmd from pg_policies where tablename in ('costos_fijos', 'gastos_conceptos') order by 1;
