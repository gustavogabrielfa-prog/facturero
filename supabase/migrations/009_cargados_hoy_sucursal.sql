-- =====================================================================
-- "Cargados hoy": cada usuario ve lo que se cargó HOY en SU sucursal
-- (por cualquier usuario), no solo lo suyo. A las 00:00 deja de verse.
-- El admin ya ve todo y el gerente ya ve toda su sucursal.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

drop policy if exists comprobantes_sucursal_hoy on public.comprobantes;
create policy comprobantes_sucursal_hoy on public.comprobantes
  for select to authenticated
  using (
    sucursal_id = (select public.mi_sucursal())
    and created_at >= (date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                       at time zone 'America/Argentina/Buenos_Aires')
  );
