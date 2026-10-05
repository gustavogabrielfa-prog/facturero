// Compila y sube la app a Cloudflare Pages.
//   npm run deploy:prod  -> rama GITHUB_BRANCH_PROD -> https://<proyecto>.pages.dev
//   npm run deploy:dev   -> rama GITHUB_BRANCH_DEV  -> https://<rama-dev>.<proyecto>.pages.dev
// Variables de la app: .env y, si existen, .env.production / .env.development (pisan a .env).
import { execFileSync } from 'node:child_process'
import { loadEnv } from './env.mjs'

const target = process.argv[2]
if (!['dev', 'prod'].includes(target)) {
  console.error('Uso: node scripts/cloudflare-deploy.mjs <dev|prod>')
  process.exit(1)
}

const env = loadEnv()
const token = env.CLOUDFLARE_API_TOKEN
const account = env.CLOUDFLARE_ACCOUNT_ID
const project = env.CLOUDFLARE_PROJECT || 'facturero'
const prod = env.GITHUB_BRANCH_PROD || 'main'
const dev = env.GITHUB_BRANCH_DEV || 'develop'
const branch = target === 'prod' ? prod : dev

if (!token || !account) {
  console.error('Faltan CLOUDFLARE_API_TOKEN y/o CLOUDFLARE_ACCOUNT_ID en .env')
  process.exit(1)
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const errMsg = (r) => r.data?.errors?.map((e) => e.message).join(', ') || `HTTP ${r.status}`

// 1. Proyecto de Pages (se crea una vez, con la rama de Producción)
let r = await api('GET', `/pages/projects/${project}`)
if (r.status === 404) {
  r = await api('POST', '/pages/projects', { name: project, production_branch: prod })
  if (!r.data?.success) {
    console.error('No se pudo crear el proyecto:', errMsg(r))
    process.exit(1)
  }
  console.log(`Proyecto creado: https://${r.data.result.subdomain}`)
} else if (!r.data?.success) {
  console.error('Error consultando el proyecto:', errMsg(r))
  process.exit(1)
}
// Si el nombre ya está tomado en pages.dev, Cloudflare agrega un sufijo
const subdomain = r.data.result.subdomain

// 2. Build (modo production o development de Vite)
const run = (cmd, args, extraEnv = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, ...extraEnv } })

run('npx', ['vite', 'build', '--mode', target === 'prod' ? 'production' : 'development'])

// 3. Deploy
run('npx', ['wrangler', 'pages', 'deploy', 'dist',
  `--project-name=${project}`, `--branch=${branch}`, '--commit-dirty=true'],
  { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account })

const url = target === 'prod'
  ? `https://${subdomain}`
  : `https://${branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.${subdomain}`
console.log(`\n${target === 'prod' ? 'Producción' : 'Desarrollo'} publicado en ${url}`)
