# Facturero

Carga de comprobantes de compra (facturado / no facturado) para las sucursales de Farmacia Argus, con datos compartidos en Supabase.

## Puesta en marcha

1. **Base de datos:** en Supabase → SQL Editor, pegar y ejecutar [`supabase/schema.sql`](supabase/schema.sql).
2. **Usuarios:** Authentication → Users → *Add user* (uno por sucursal + uno admin, con "Auto Confirm").
   Desactivar el registro público en Authentication → Sign In / Providers → *Allow new users to sign up*.
3. **Roles:** ejecutar los `update public.perfiles ...` del final de `schema.sql` con los emails reales.
4. **Variables:** completar `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` en `.env`.
5. **Correr la app:**
   ```bash
   npm install
   npm run dev
   ```

## Roles

| Rol | Puede |
|---|---|
| `carga` | Cargar comprobantes solo en su sucursal, ver y agregar proveedores |
| `gerente` | Cargar solo en su sucursal y ver listado, totales, gráfico y PDF **de su sucursal**. No elimina ni importa |
| `admin` | Todo lo anterior en cualquier sucursal + listado, totales, PDF, eliminar e importar copias del Facturero anterior |

Los permisos los aplica la base (RLS), no solo la interfaz.

## Publicación

Completar las variables de GitHub y Cloudflare en `.env` (ver `.env.example`).

| Comando | Qué hace |
|---|---|
| `npm run github:publish` | Crea el repo en GitHub y sube `main` (Producción) y `develop` (Desarrollo) |
| `npm run deploy:prod` | Build + deploy a Cloudflare Pages → `https://<proyecto>.pages.dev` |
| `npm run deploy:dev` | Build + deploy a Cloudflare Pages → `https://develop.<proyecto>.pages.dev` |

Para usar otra base de Supabase en un entorno, crear `.env.production` o `.env.development` con las `VITE_*` que cambian (pisan a `.env`).
