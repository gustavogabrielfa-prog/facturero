// Crea el repo en GitHub vía API (si no existe) y sube dos ramas:
//   GITHUB_BRANCH_PROD (Producción) y GITHUB_BRANCH_DEV (Desarrollo).
// Uso: npm run github:publish
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnv } from './env.mjs'

const env = loadEnv()

const token = env.GITHUB_TOKEN
const owner = env.GITHUB_OWNER
const repo = env.GITHUB_REPO || 'facturero'
const isPrivate = (env.GITHUB_PRIVATE ?? 'true') !== 'false'
const prod = env.GITHUB_BRANCH_PROD || 'main'
const dev = env.GITHUB_BRANCH_DEV || 'develop'

if (!token || !owner) {
  console.error('Faltan GITHUB_TOKEN y/o GITHUB_OWNER en .env')
  process.exit(1)
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body && JSON.stringify(body),
  })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, data }
}

const git = (...args) => execFileSync('git', args, { stdio: 'inherit' })
const gitOut = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

// 1. Repo
const me = await api('GET', '/user')
if (me.status !== 200) {
  console.error('Token inválido:', me.data?.message)
  process.exit(1)
}

let r = await api('GET', `/repos/${owner}/${repo}`)
if (r.status === 404) {
  const isUser = me.data.login.toLowerCase() === owner.toLowerCase()
  r = await api('POST', isUser ? '/user/repos' : `/orgs/${owner}/repos`, {
    name: repo,
    private: isPrivate,
    description: 'Carga de comprobantes de compra para Farmacia Argus',
  })
  if (r.status !== 201) {
    console.error('No se pudo crear el repo:', r.data?.message, r.data?.errors ?? '')
    process.exit(1)
  }
  console.log(`Repo creado: ${r.data.html_url}`)
} else if (r.status === 200) {
  console.log(`Repo existente: ${r.data.html_url}`)
} else {
  console.error('Error consultando el repo:', r.data?.message)
  process.exit(1)
}

// 2. Git local
if (!existsSync('.git')) git('init', '-b', prod)
const hasConfig = (key) => { try { return !!gitOut('config', key) } catch { return false } }
if (!hasConfig('user.name')) git('config', 'user.name', me.data.name || me.data.login)
if (!hasConfig('user.email')) git('config', 'user.email', `${me.data.id}+${me.data.login}@users.noreply.github.com`)
const hasCommits = (() => {
  try { gitOut('rev-parse', 'HEAD'); return true } catch { return false }
})()
if (!hasCommits || gitOut('status', '--porcelain')) {
  git('add', '-A')
  git('commit', '-m', hasCommits ? 'Actualización' : 'Versión inicial')
}
const current = gitOut('rev-parse', '--abbrev-ref', 'HEAD')
if (current !== prod) git('branch', '-M', prod)
if (!gitOut('branch', '--list', dev)) git('branch', dev)

// 3. Push (el token va solo en esta URL, no queda guardado en el remote)
const cleanUrl = `https://github.com/${owner}/${repo}.git`
const authUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
try { gitOut('remote', 'get-url', 'origin'); git('remote', 'set-url', 'origin', cleanUrl) }
catch { git('remote', 'add', 'origin', cleanUrl) }

const gitAuth = (...args) => {
  try {
    execFileSync('git', args, { stdio: ['ignore', 'inherit', 'pipe'] })
  } catch (e) {
    console.error(String(e.stderr ?? e.message).replaceAll(token, '***'))
    process.exit(1)
  }
}
gitAuth('push', authUrl, `${prod}:${prod}`, `${dev}:${dev}`)
gitAuth('fetch', authUrl,
  `+refs/heads/${prod}:refs/remotes/origin/${prod}`,
  `+refs/heads/${dev}:refs/remotes/origin/${dev}`)
git('branch', '--set-upstream-to', `origin/${prod}`, prod)
git('branch', '--set-upstream-to', `origin/${dev}`, dev)

// 4. Rama por defecto = Producción
await api('PATCH', `/repos/${owner}/${repo}`, { default_branch: prod })

console.log(`\nListo: ${prod} (Producción) y ${dev} (Desarrollo) en https://github.com/${owner}/${repo}`)
