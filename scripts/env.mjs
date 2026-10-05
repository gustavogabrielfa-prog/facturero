import { readFileSync } from 'node:fs'

// Lee .env sin dependencias (KEY=valor, ignora comentarios)
export const loadEnv = (file = '.env') =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]),
  )
