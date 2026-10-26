-- =====================================================================
-- Respaldo liviano (ZIP de CSV) y restaurar desde copia
--  - respaldo_datos(): todas las tablas en UNA consulta (la usa el botón del admin
--    y el respaldo automático a Google Drive), así casi no le pesa a Supabase
--  - restaurar_respaldo(): vuelve a cargar una copia; solo agrega lo que falta
--    (no duplica ni pisa nada). Con p_simular = true no guarda: solo cuenta
-- Ejecutar después de 017_gerente_agrega_gastos.sql.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- 1) Todos los datos (sin usuarios ni contraseñas). Solo admin o la clave secreta del respaldo automático.
create or replace function public.respaldo_datos()
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if not ((select public.es_admin()) or (select auth.role()) = 'service_role') then
    raise exception 'Solo el administrador puede descargar la copia.';
  end if;
  return jsonb_build_object(
    'formato', 'facturero-respaldo-v1',
    'generado', now(),
    'sucursales',       (select coalesce(jsonb_agg(to_jsonb(t) order by t.nombre), '[]') from public.sucursales t),
    'proveedores',      (select coalesce(jsonb_agg(to_jsonb(t) order by t.nombre), '[]') from public.proveedores t),
    'tributos',         (select coalesce(jsonb_agg(to_jsonb(t) order by t.orden, t.nombre), '[]') from public.tributos t),
    'gastos_conceptos', (select coalesce(jsonb_agg(to_jsonb(t) order by t.orden, t.nombre), '[]') from public.gastos_conceptos t),
    'comprobantes',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha, t.created_at), '[]') from public.comprobantes t),
    'ventas_diarias',   (select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha, t.pv, t.lado), '[]') from public.ventas_diarias t),
    'costos_fijos',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.mes, t.categoria), '[]') from public.costos_fijos t)
  );
end;
$$;
revoke execute on function public.respaldo_datos() from public, anon;
grant execute on function public.respaldo_datos() to authenticated, service_role;

-- 2) Al restaurar se conserva quién cargó cada comprobante (en una carga normal lo pone la base)
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
    if not (coalesce(current_setting('facturero.restaurando', true), '') = '1' and new.cargado_por is not null) then
      new.cargado_por := (select p.sigla from public.perfiles p where p.id = auth.uid());
    end if;
  else
    new.cargado_por := old.cargado_por;   -- corregir no cambia quién lo cargó
  end if;
  return new;
end;
$$;

-- 3) Restaurar. Sucursales, proveedores, tributos y gastos de la lista se reconocen por código
--    o por nombre (proveedores también por CUIT), así la copia sirve aunque la base sea otra.
create or replace function public.restaurar_respaldo(p jsonb, p_simular boolean default true)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r jsonb;
  n_suc int; n_prov int; n_trib int; n_conc int; n_comp int; n_ven int; n_gas int;
begin
  if not (select public.es_admin()) then raise exception 'Solo el administrador puede restaurar una copia.'; end if;
  if p->>'formato' is distinct from 'facturero-respaldo-v1' then raise exception 'El archivo no es una copia de Facturero.'; end if;

  begin
    perform set_config('facturero.restaurando', '1', true);
    create temp table _m_suc  (viejo uuid primary key, nuevo uuid) on commit drop;
    create temp table _m_prov (viejo uuid primary key, nuevo uuid) on commit drop;
    create temp table _m_trib (viejo uuid primary key, nuevo uuid) on commit drop;

    -- Sucursales
    insert into _m_suc
      select b.id, coalesce(s1.id, s2.id)
      from jsonb_populate_recordset(null::public.sucursales, p->'sucursales') b
      left join public.sucursales s1 on s1.id = b.id
      left join public.sucursales s2 on lower(trim(s2.nombre)) = lower(trim(b.nombre))
      on conflict do nothing;
    insert into public.sucursales
      select b.* from jsonb_populate_recordset(null::public.sucursales, p->'sucursales') b
      join _m_suc m on m.viejo = b.id where m.nuevo is null
      on conflict do nothing;
    get diagnostics n_suc = row_count;
    update _m_suc set nuevo = viejo where nuevo is null;

    -- Proveedores
    insert into _m_prov
      select b.id, coalesce(p1.id, p2.id, p3.id)
      from jsonb_populate_recordset(null::public.proveedores, p->'proveedores') b
      left join public.proveedores p1 on p1.id = b.id
      left join public.proveedores p2 on b.cuit is not null and p2.cuit = b.cuit
      left join lateral (select x.id from public.proveedores x
                         where lower(trim(x.nombre)) = lower(trim(b.nombre)) limit 1) p3 on true
      on conflict do nothing;
    insert into public.proveedores
      select (jsonb_populate_record(null::public.proveedores, to_jsonb(b)
               || jsonb_build_object('created_by', (select u.id from auth.users u where u.id = b.created_by)))).*
      from jsonb_populate_recordset(null::public.proveedores, p->'proveedores') b
      join _m_prov m on m.viejo = b.id where m.nuevo is null
      on conflict do nothing;
    get diagnostics n_prov = row_count;
    update _m_prov set nuevo = viejo where nuevo is null;

    -- Otros tributos
    insert into _m_trib
      select b.id, coalesce(t1.id, t2.id)
      from jsonb_populate_recordset(null::public.tributos, p->'tributos') b
      left join public.tributos t1 on t1.id = b.id
      left join public.tributos t2 on lower(trim(t2.nombre)) = lower(trim(b.nombre))
      on conflict do nothing;
    insert into public.tributos
      select b.* from jsonb_populate_recordset(null::public.tributos, p->'tributos') b
      join _m_trib m on m.viejo = b.id where m.nuevo is null
      on conflict do nothing;
    get diagnostics n_trib = row_count;
    update _m_trib set nuevo = viejo where nuevo is null;

    -- Lista de gastos (los importes se guardan por nombre del gasto)
    insert into public.gastos_conceptos
      select b.* from jsonb_populate_recordset(null::public.gastos_conceptos, p->'gastos_conceptos') b
      where not exists (select 1 from public.gastos_conceptos c
                        where c.id = b.id or lower(trim(c.nombre)) = lower(trim(b.nombre)))
      on conflict do nothing;
    get diagnostics n_conc = row_count;

    -- Comprobantes (los repetidos por código o por proveedor + tipo + número se saltean)
    insert into public.comprobantes
      select (jsonb_populate_record(null::public.comprobantes, c || jsonb_build_object(
               'sucursal_id', ms.nuevo,
               'proveedor_id', mp.nuevo,
               'created_by', (select u.id from auth.users u where u.id = (c->>'created_by')::uuid),
               'tributos', (select coalesce(jsonb_object_agg(coalesce(mt.nuevo::text, e.key), e.value), '{}'::jsonb)
                            from jsonb_each(coalesce(c->'tributos', '{}'::jsonb)) e
                            left join _m_trib mt on mt.viejo::text = e.key)
             ))).*
      from jsonb_array_elements(p->'comprobantes') c
      join _m_suc ms on ms.viejo = (c->>'sucursal_id')::uuid
      join _m_prov mp on mp.viejo = (c->>'proveedor_id')::uuid
      on conflict do nothing;
    get diagnostics n_comp = row_count;

    -- Ventas
    insert into public.ventas_diarias
      select (jsonb_populate_record(null::public.ventas_diarias, v || jsonb_build_object(
               'sucursal_id', ms.nuevo,
               'created_by', (select u.id from auth.users u where u.id = (v->>'created_by')::uuid)))).*
      from jsonb_array_elements(p->'ventas_diarias') v
      join _m_suc ms on ms.viejo = (v->>'sucursal_id')::uuid
      on conflict do nothing;
    get diagnostics n_ven = row_count;

    -- Importes de gastos operativos (sucursal vacía = general)
    insert into public.costos_fijos
      select (jsonb_populate_record(null::public.costos_fijos, g || jsonb_build_object(
               'sucursal_id', ms.nuevo,
               'created_by', (select u.id from auth.users u where u.id = (g->>'created_by')::uuid)))).*
      from jsonb_array_elements(p->'costos_fijos') g
      left join _m_suc ms on ms.viejo = (g->>'sucursal_id')::uuid
      where g->>'sucursal_id' is null or ms.nuevo is not null
      on conflict do nothing;
    get diagnostics n_gas = row_count;

    r := jsonb_build_object(
      'agregados', jsonb_build_object('sucursales', n_suc, 'proveedores', n_prov, 'tributos', n_trib,
                                      'gastos_conceptos', n_conc, 'comprobantes', n_comp,
                                      'ventas_diarias', n_ven, 'costos_fijos', n_gas),
      'en_copia', jsonb_build_object('sucursales', jsonb_array_length(p->'sucursales'),
                                     'proveedores', jsonb_array_length(p->'proveedores'),
                                     'tributos', jsonb_array_length(p->'tributos'),
                                     'gastos_conceptos', jsonb_array_length(p->'gastos_conceptos'),
                                     'comprobantes', jsonb_array_length(p->'comprobantes'),
                                     'ventas_diarias', jsonb_array_length(p->'ventas_diarias'),
                                     'costos_fijos', jsonb_array_length(p->'costos_fijos')),
      'simulado', p_simular);

    -- Vista previa: se deshace todo lo de este bloque (los números ya quedaron en r)
    if p_simular then raise exception using errcode = 'FRSIM', message = 'simulacion'; end if;
  exception when sqlstate 'FRSIM' then
    null;
  end;
  return r;
end;
$$;
revoke execute on function public.restaurar_respaldo(jsonb, boolean) from public, anon;
grant execute on function public.restaurar_respaldo(jsonb, boolean) to authenticated;
