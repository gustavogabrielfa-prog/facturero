-- =====================================================================
-- 1) No se pueden cargar comprobantes con fecha posterior a hoy (hora Argentina).
--    Se controla al cargar y al cambiar la fecha; lo ya cargado no se toca.
-- 2) Cada comprobante guarda la sigla de quien lo cargó (AD, E1, E2, A1, A2...).
--    La sigla sale de perfiles.sigla; si cambia, lo ya cargado conserva la anterior.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

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

-- Verificación: revisá que cada usuario tenga la sigla correcta.
-- Para cambiar una:  update public.perfiles set sigla = 'E1' where lower(email) = 'xxx@gmail.com';
select email, rol, sigla from public.perfiles order by sigla;
