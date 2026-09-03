// Offline client regression for DSH 0.1.2 remote.session.openWorkspacePath wrapping.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let plugin
let failures = 0

function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS ${name}`)
  else {
    failures += 1
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function node(tag = 'div') {
  const listeners = new Map()
  return {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    dataset: {},
    parentNode: null,
    children: [],
    classList: { add() {}, remove() {} },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child },
    removeChild(child) { this.children = this.children.filter((x) => x !== child); child.parentNode = null },
    addEventListener(name, handler) { listeners.set(name, handler) },
    removeEventListener(name) { listeners.delete(name) },
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null },
  }
}

const body = node('body')
const head = node('head')
const documentListeners = new Map()
const document = {
  body,
  head,
  createElement: (tag) => node(tag),
  getElementById() { return null },
  querySelector() { return null },
  addEventListener(name, handler) { documentListeners.set(name, handler) },
  removeEventListener(name) { documentListeners.delete(name) },
}
const fetches = []
const fixtureRoot = 'C:/workspace'
const fixturePath = `${fixtureRoot}/docs/example.md`
const sandbox = {
  console,
  Promise,
  Symbol,
  JSON,
  Error,
  String,
  Date,
  Math,
  URL,
  encodeURIComponent,
  decodeURIComponent,
  document,
  navigator: {},
  localStorage: { getItem() { return null }, setItem() {} },
  fetch: async (url) => {
    fetches.push(String(url))
    if (String(url).includes('/meta')) {
      return { ok: true, json: async () => ({ ok: true, roots: [fixtureRoot], writeRoots: [fixtureRoot] }) }
    }
    if (String(url).includes('/file')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          path: fixturePath,
          binary: false,
          whole: true,
          content: 'ok',
          totalLines: 1,
          sizeText: '2 B',
          mtimeMs: 1,
          saveable: true,
        }),
      }
    }
    return { ok: true, json: async () => ({ ok: true, entries: [], count: 0, path: fixtureRoot, parent: null }) }
  },
  setTimeout,
  clearTimeout,
}
sandbox.window = {
  __ModuleLoader__: { load(definition) { plugin = definition.factory(() => { throw new Error('unexpected require') }) } },
  confirm: () => true,
  localStorage: sandbox.localStorage,
}

vm.runInNewContext(source, sandbox, { filename: 'dsh-fileview/client.js' })
check('client module loaded', plugin && typeof plugin.apply === 'function')
check(
  'declares DSH 0.1.2 Remote dependencies',
  JSON.stringify(plugin.inject) === JSON.stringify(['connection', 'remote', 'remote.session']),
  JSON.stringify(plugin.inject),
)

async function runCase(isLoopback) {
  const nativeCalls = []
  const nativeMethod = async (request, signal) => {
    nativeCalls.push({ request, signal })
    return { ok: true, value: { opened: true } }
  }
  const remoteSession = {}
  Object.defineProperty(remoteSession, 'openWorkspacePath', {
    configurable: true,
    enumerable: true,
    get() { return nativeMethod },
  })
  const originalDescriptor = Object.getOwnPropertyDescriptor(remoteSession, 'openWorkspacePath')
  const cleanups = []
  const ctx = {
    connection: { isLoopback },
    remote: { session: remoteSession },
    effect(install) {
      const cleanup = install()
      if (cleanup) cleanups.push(cleanup)
    },
  }
  plugin.apply(ctx)
  await Promise.resolve()
  await Promise.resolve()
  return { remoteSession, nativeMethod, nativeCalls, cleanups, originalDescriptor }
}

const remote = await runCase(false)
const remoteResult = await remote.remoteSession.openWorkspacePath({ path: fixturePath })
await Promise.resolve()
await Promise.resolve()
check('remote call returns RemoteResult success', remoteResult?.ok === true && remoteResult?.value?.opened === true, JSON.stringify(remoteResult))
check('remote call bypasses native privileged opener', remote.nativeCalls.length === 0, `calls=${remote.nativeCalls.length}`)
check('remote call loads fileview endpoint', fetches.some((url) => url.includes('/dsh-fileview/file?path=')), JSON.stringify(fetches))
for (const cleanup of remote.cleanups) cleanup()
const restoredDescriptor = Object.getOwnPropertyDescriptor(remote.remoteSession, 'openWorkspacePath')
check('dispose restores getter-only native descriptor', restoredDescriptor?.get === remote.originalDescriptor?.get && !('value' in restoredDescriptor))
check('dispose restores exact native method', remote.remoteSession.openWorkspacePath === remote.nativeMethod)

const local = await runCase(true)
const signal = { marker: true }
const localResult = await local.remoteSession.openWorkspacePath({ path: fixturePath }, signal)
check('loopback call preserves native result', localResult?.ok === true)
check(
  'loopback call delegates request and signal',
  local.nativeCalls.length === 1 && local.nativeCalls[0].request.path === fixturePath && local.nativeCalls[0].signal === signal,
)
for (const cleanup of local.cleanups) cleanup()

console.log(failures === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures} CLIENT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
