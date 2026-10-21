-- =====================================================================
-- Estado de resultados para el gerente (mismo criterio que Ventas):
--  - ve la lista de gastos (no la modifica: eso es del administrador)
--  - ve, carga, corrige y borra los gastos operativos de SU sucursal
--  - de los gastos generales recibe solo SU parte, ya repartida según las ventas
--    (sin ver las ventas ni los gastos de la otra sucursal)
-- Ejecutar después de 015_gastos_operativos.sql.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- Lista de gastos: el gerente la lee
drop policy if exists gastos_conceptos_gerente_select on public.gastos_conceptos;
create policy gastos_conceptos_gerente_select on public.gastos_conceptos
  for select to authenticated using ((select public.es_gerente()));

-- Gastos de su sucursal
drop policy if exists costos_fijos_gerente_all on public.costos_fijos;
create policy costos_fijos_gerente_all on public.costos_fijos
  for all to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()))
  with check ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

-- Guardar un importe: el administrador en cualquier sucursal (o general), el gerente solo en la suya
create or replace function public.guardar_gasto(p_mes date, p_sucursal uuid, p_categoria text, p_monto numeric)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not ((select public.es_admin()) or ((select public.es_gerente()) and p_sucursal = (select public.mi_sucursal()))) then
    raise exception 'Solo podés cargar gastos de tu sucursal.';
  end if;
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

-- Parte de los gastos generales que le toca a la sucursal del usuario, mes por mes:
-- lo que vendió la sucursal / lo que vendieron todas (si nadie vendió, partes iguales).
-- Devuelve solo los importes ya repartidos.
create or replace function public.mis_gastos_generales(p_desde date, p_hasta date)
returns table (mes date, monto numeric)
language sql stable security definer set search_path = ''
as $$
  with suc as (select public.mi_sucursal() as id),
  gen as (
    select c.mes, sum(c.monto) as total
    from public.costos_fijos c
    where c.sucursal_id is null
      and c.mes between date_trunc('month', p_desde)::date and date_trunc('month', p_hasta)::date
    group by c.mes
  ),
  vtas as (
    select date_trunc('month', v.fecha)::date as mes,
           coalesce(sum(v.total) filter (where v.sucursal_id = (select id from suc)), 0) as propia,
           sum(v.total) as todas
    from public.ventas_diarias v
    where v.fecha >= date_trunc('month', p_desde)::date
      and v.fecha < (date_trunc('month', p_hasta) + interval '1 month')::date
    group by 1
  )
  select g.mes,
         round(g.total * case when coalesce(v.todas, 0) > 0 then v.propia / v.todas
                              else 1.0 / greatest(1, (select count(*) from public.sucursales)) end, 2)
  from gen g left join vtas v on v.mes = g.mes
  where (select id from suc) is not null and (select public.es_gerente());
$$;
grant execute on function public.mis_gastos_generales(date, date) to authenticated;

-- Verificación
select policyname from pg_policies where tablename in ('costos_fijos', 'gastos_conceptos') order by 1;
