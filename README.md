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

## Copia de respaldo

Un `.zip` liviano con un `.csv` por tabla (se abren con Excel o con el Bloc de notas): unos 80 KB cada 10.000 comprobantes.
Requiere la migración [`018_respaldo.sql`](supabase/migrations/018_respaldo.sql).

- **Descargar / restaurar a mano:** Listado → 🛠 Herramientas del administrador → *Copia de respaldo (liviana)*.
  Al restaurar muestra antes qué va a agregar y solo agrega lo que falta (no duplica ni pisa nada).

### Respaldo automático a Google Drive

Corre en tu cuenta de Google (no en Supabase): una consulta por noche y solo guarda si hubo cambios.
Cada copia es completa. Deja las de los últimos 7 días, una por mes de los últimos 12 meses y una por cada año anterior (la del cierre del año) en la carpeta *Facturero - Respaldos*.

1. Entrar a [script.google.com](https://script.google.com) → *Nuevo proyecto* → pegar todo [`scripts/respaldo-drive.gs`](scripts/respaldo-drive.gs) y guardar.
2. ⚙ *Configuración del proyecto* → *Propiedades de la secuencia de comandos* → agregar:
   - `SUPABASE_URL`: la misma que `VITE_SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys → clave **secret** (o la `service_role`).
     Es una clave con acceso total: va solo acá, nunca en la app ni en `.env` de Vite.
3. Elegir la función `instalar` → *Ejecutar* → aceptar los permisos (Drive y conexión externa).
   Hace la primera copia y deja programada una por noche (3 a 4 h).
