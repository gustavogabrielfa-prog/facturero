-- =====================================================================
-- CUIT siempre con guiones: XX-XXXXXXXX-X
-- Corrige los que estén cargados sin guiones y exige el formato de ahora en más.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

update public.proveedores
  set cuit = regexp_replace(cuit, '^(\d{2})-?(\d{8})-?(\d)$', '\1-\2-\3')
  where cuit ~ '^\d{2}-?\d{8}-?\d$' and cuit !~ '^\d{2}-\d{8}-\d$';

alter table public.proveedores drop constraint if exists proveedores_cuit_check;
alter table public.proveedores
  add constraint proveedores_cuit_check check (cuit is null or cuit ~ '^\d{2}-\d{8}-\d$');

-- Verificación
select nombre, cuit from public.proveedores order by nombre;
