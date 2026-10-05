-- =====================================================================
-- Historial del día: cada usuario puede ver los comprobantes que ÉL cargó
-- HOY (hora de Argentina). A las 00:00 dejan de ser visibles para él;
-- los datos no se borran, el admin los sigue viendo en el Listado.
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

drop policy if exists comprobantes_propios_hoy on public.comprobantes;
create policy comprobantes_propios_hoy on public.comprobantes
  for select to authenticated
  using (
    created_by = (select auth.uid())
    and created_at >= (date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                       at time zone 'America/Argentina/Buenos_Aires')
  );
