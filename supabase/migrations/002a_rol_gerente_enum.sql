-- =====================================================================
-- Rol 'gerente' — PARTE 1 de 2
-- Ejecutar SOLO este archivo (Run). Después ejecutar 002b_rol_gerente.sql
-- en una consulta nueva. Van separados porque Postgres no deja usar un
-- valor nuevo de enum en la misma ejecución en que se crea.
-- =====================================================================

alter type public.rol_usuario add value if not exists 'gerente';
