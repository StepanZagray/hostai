import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { javaEnvironment } from './java-env.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const desktop = process.argv[2] === 'desktop'
const dev = process.argv.includes('--dev')
const uiPort = 3000
const children = new Set()
let stopping = false
const delay = ms => new Promise(r => setTimeout(r, ms))

async function buildGuest() {
  const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', '@hostai/web', 'build:guest'], {
    cwd: root, stdio: 'inherit', env: process.env, detached: process.platform !== 'win32',
  })
  children.add(child)
  await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? accept() : reject(new Error('The client page could not be built.')))
  })
  children.delete(child)
}

function start(command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv }, detached: process.platform !== 'win32' })
  children.add(child)
  child.on('error', error => { console.error(error.message); void shutdown(1) })
  child.on('exit', code => { if (!stopping) void shutdown(code || 0) })
  return child
}
async function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode !== null) continue
    try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM') } catch { /* Already stopped. */ }
  }
  await Promise.race([Promise.all([...children].map(c => c.exitCode !== null ? Promise.resolve() : new Promise(r => c.once('exit', r)))), delay(5000)])
  for (const child of children) {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else if (child.exitCode === null) child.kill('SIGKILL') } catch { /* Group is gone. */ }
  }
  process.exit(code)
}
async function assertFree(port) {
  await new Promise((accept, reject) => {
    const socket = createServer()
    socket.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the existing workspace before using this launcher.`)))
    socket.listen(port, '127.0.0.1', () => socket.close(accept))
  })
}
async function waitFor(url, limit = 90000) {
  const until = Date.now() + limit
  while (Date.now() < until && !stopping) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return } catch { /* Still starting. */ }
    await delay(300)
  }
  throw new Error(`Service did not become ready: ${url}`)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0))

try {
  const javaEnv = javaEnvironment()
  await assertFree(uiPort)
  await assertFree(8080)
  if (dev) {
    await buildGuest()
    start('./mvnw', ['spring-boot:run'], resolve(root, 'backend'), javaEnv)
  } else {
    const target = resolve(root, 'backend/target')
    const jar = existsSync(target) && readdirSync(target).find(name => name.endsWith('.jar') && !name.includes('sources') && !name.includes('javadoc'))
    if (!jar || !existsSync(resolve(root, 'apps/web/dist/server/server.js'))) throw new Error('Build the app first with pnpm build:all.')
    const java = javaEnv.JAVA_HOME ? resolve(javaEnv.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
    start(java, ['-jar', resolve(target, jar)], root, javaEnv)
  }
  await waitFor('http://127.0.0.1:8080/actuator/health')
  if (dev) start(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', '@hostai/web', 'dev'], root)
  else start(process.execPath, ['server.mjs'], resolve(root, 'apps/web'), { HOSTAI_UI_PORT: String(uiPort) })
  const address = `http://127.0.0.1:${uiPort}`
  await waitFor(address)
  console.log(`HostAI is ready in your browser: ${address}`)
  if (desktop) {
    const { default: electron } = await import('../apps/desktop/node_modules/electron/index.js')
    start(electron, [resolve(root, 'apps/desktop')], root, { HOSTAI_UI_URL: address, ELECTRON_RUN_AS_NODE: '' })
  } else console.log('Press Ctrl+C to stop the workspace and Java gateway.')
} catch (error) { console.error(error.message); await shutdown(1) }
