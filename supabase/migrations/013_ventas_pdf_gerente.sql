-- =====================================================================
-- El gerente también sube el PDF de ventas de SU sucursal (además de la carga manual).
-- Ejecutar después de 012_ventas_manual_gerente.sql.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- El gerente carga y borra ventas (del PDF o manuales) solo de su sucursal
drop policy if exists ventas_gerente_insert on public.ventas_diarias;
create policy ventas_gerente_insert on public.ventas_diarias
  for insert to authenticated
  with check ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

drop policy if exists ventas_gerente_delete on public.ventas_diarias;
create policy ventas_gerente_delete on public.ventas_diarias
  for delete to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

-- Guardar el PDF: el administrador en cualquier sucursal, el gerente solo en la suya
create or replace function public.guardar_ventas(p_sucursal uuid, p_desde date, p_hasta date, p_filas jsonb)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare n integer;
begin
  if not ((select public.es_admin()) or ((select public.es_gerente()) and p_sucursal = (select public.mi_sucursal()))) then
    raise exception 'Solo podés guardar ventas de tu sucursal.';
  end if;
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
select policyname from pg_policies where tablename = 'ventas_diarias' order by 1;
