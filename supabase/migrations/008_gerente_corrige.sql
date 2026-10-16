-- =====================================================================
-- El gerente puede corregir y eliminar comprobantes de SU sucursal.
-- (No puede pasarlos a otra sucursal: el WITH CHECK exige la suya.)
-- Pegar en: Supabase Dashboard > SQL Editor > New query > Run
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

drop policy if exists comprobantes_gerente_update on public.comprobantes;
create policy comprobantes_gerente_update on public.comprobantes
  for update to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()))
  with check ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));

drop policy if exists comprobantes_gerente_delete on public.comprobantes;
create policy comprobantes_gerente_delete on public.comprobantes
  for delete to authenticated
  using ((select public.es_gerente()) and sucursal_id = (select public.mi_sucursal()));
