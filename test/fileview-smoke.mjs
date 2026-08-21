// Offline smoke test for dsh-fileview host half — no server needed.
// Drives the prefix-route handler with fake req/res objects.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const mod = await import(new URL('../index.js', import.meta.url))
const plugin = mod.default

let registered = null
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  get: (name) => (name === 'webServer'
    ? { register: (route) => { registered = route; return () => {} } }
    : undefined),
}

const tempRoot = mkdtempSync(join(tmpdir(), 'dfv-smoke-'))
const dispose = plugin.apply(ctx, { roots: [tempRoot] })

function fakeRes() {
  const res = {
    code: 0, body: '',
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(text) { this.body = text ?? '' },
  }
  return res
}

async function call(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req = {
    method, url,
    headers: { host: 'dsh.example.com', ...headers },
    on(event, fn) {
      if (event === 'data') for (const c of chunks) fn(c)
      if (event === 'end') fn()
      if (event === 'error') fn(new Error('noop'))
    },
    destroy() {},
  }
  const res = fakeRes()
  registered.handler(req, res)
  await new Promise((r) => setTimeout(r, 30))
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch {}
  return { code: res.code, body: parsed }
}

const results = []
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <<< ' + extra}`)
}

// ── meta ──
{
  const r = await call('GET', '/dsh-fileview/meta')
  check('meta returns roots', r.code === 200 && r.body.ok === true && r.body.roots[0] === tempRoot, JSON.stringify(r))
}

// ── file read: whole ──
const samplePath = join(tempRoot, '章节.md')
writeFileSync(samplePath, '第一行\r\n第二行\r\n第三行\r\n', 'utf8')
{
  const r = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(samplePath)}`)
  check('file whole read ok', r.code === 200 && r.body.ok === true && r.body.whole === true, JSON.stringify(r))
  check('content exact (trailing newline kept)', r.body.content === '第一行\r\n第二行\r\n第三行\r\n', JSON.stringify(r.body.content))
  check('totalLines = 3', r.body.totalLines === 3, String(r.body.totalLines))
  check('binary = false', r.body.binary === false)
}

// ── file window ──
{
  const r = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(samplePath)}&offset=2&limit=1`)
  check('window slice line 2 (CR stripped)', r.body.whole === false && r.body.content === '第二行', JSON.stringify(r.body))
}

// ── PUT: CRLF + content round-trip ──
{
  const r = await call('PUT', '/dsh-fileview/file', JSON.stringify({ path: samplePath, content: '改一\n改二\n' }))
  check('put ok', r.code === 200 && r.body.ok === true, JSON.stringify(r))
  const disk = readFileSync(samplePath, 'utf8')
  check('put preserves CRLF', disk === '改一\r\n改二\r\n', JSON.stringify(disk))
}

// ── binary sniff ──
{
  const binPath = join(tempRoot, 'blob.bin')
  writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03]))
  const r = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(binPath)}`)
  check('binary detected', r.body.binary === true && r.body.content === '', JSON.stringify(r))
}

// ── traversal / allowlist ──
{
  // A sibling directory OUTSIDE the configured root (platform-independent
  // stand-in for "D:\Windows" on Windows).
  const outsideDir = mkdtempSync(join(dirname(tempRoot), 'dfv-outside-'))
  const outsideFile = join(outsideDir, 'secret.txt')
  writeFileSync(outsideFile, 'top secret', 'utf8')
  const r = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(outsideFile)}`)
  check('outside root -> 403', r.code === 403, `${r.code} ${JSON.stringify(r.body)}`)
  const r2 = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(join(tempRoot, '..', '..', 'tmp', 'dfv-outside-' + (outsideDir.split(/[\\/]/).pop() ?? ''), 'secret.txt'))}`)
  check('traversal -> 403', r2.code === 403, `${r2.code} ${JSON.stringify(r2.body)}`)
  const r3 = await call('GET', `/dsh-fileview/file?path=relative.md`)
  check('relative path -> 400', r3.code === 400, `${r3.code}`)
  rmSync(outsideDir, { recursive: true, force: true })
}

// ── cross-origin fence ──
{
  const r = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(samplePath)}`, undefined, { origin: 'https://evil.example.com' })
  check('cross-origin -> 403', r.code === 403, `${r.code}`)
  const r2 = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(samplePath)}`, undefined, { origin: 'https://dsh.example.com' })
  check('same-origin passes', r2.code === 200, `${r2.code}`)
}

// ── dir ──
{
  writeFileSync(join(tempRoot, 'z-note.md'), 'x', 'utf8')
  const sub = join(tempRoot, 'sub')
  await import('node:fs').then((fs) => fs.mkdirSync(sub))
  const r = await call('GET', `/dsh-fileview/dir?path=${encodeURIComponent(tempRoot)}`)
  const names = (r.body.entries || []).map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`)
  check('dir lists entries with types', r.body.ok === true && names.includes('d:sub') && names.includes('f:章节.md'), names.join(','))
  check('dirs sort first', (r.body.entries || [])[0]?.name === 'sub', names.join(','))
  check('parent null at root', r.body.parent === null, JSON.stringify(r.body.parent))
}

// ── 404 unknown ──
{
  const r = await call('GET', '/dsh-fileview/nope')
  check('unknown endpoint -> 404', r.code === 404, `${r.code}`)
}

// ── encoding ladder (past incident: clean UTF-8 flagged binary) ──
{
  // The incident shape: valid CJK whose 8192-byte sniff boundary used to fall
  // on a lead byte. Whole-buffer strict decode must call it plain UTF-8.
  const boundaryPath = join(tempRoot, 'boundary.md')
  writeFileSync(boundaryPath, Buffer.from('旧'.repeat(2731), 'utf8'))
  const r = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(boundaryPath)}`)
  check('boundary-CJK file is text, not binary', r.body.binary === false && r.body.whole === true, JSON.stringify({ binary: r.body.binary, whole: r.body.whole }))
  check('boundary-CJK encoding utf-8 + saveable', r.body.encoding === 'utf-8' && r.body.saveable === true, JSON.stringify(r.body.encoding))

  // GBK (GB18030) legacy Chinese file: viewable, save refused
  const gbkPath = join(tempRoot, 'legacy-gbk.txt')
  writeFileSync(gbkPath, Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]))
  const rg = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(gbkPath)}`)
  check('gbk file decodes', rg.body.binary === false && rg.body.content === '你好', JSON.stringify(rg.body.content))
  check('gbk marked gb18030 + not saveable', rg.body.encoding === 'gb18030' && rg.body.saveable === false, JSON.stringify(rg.body.encoding))
  const pg = await call('PUT', '/dsh-fileview/file', JSON.stringify({ path: gbkPath, content: 'x' }))
  check('gbk save refused with 409', pg.code === 409, `${pg.code}`)

  // UTF-16LE with BOM: round-trip save preserves encoding + BOM
  const lePath = join(tempRoot, 'utf16le.txt')
  writeFileSync(lePath, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('你好', 'utf16le')]))
  const rl = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(lePath)}`)
  check('utf16le decodes', rl.body.binary === false && rl.body.content === '你好', JSON.stringify(rl.body.content))
  await call('PUT', '/dsh-fileview/file', JSON.stringify({ path: lePath, content: '新文\n' }))
  const leDisk = readFileSync(lePath)
  check('utf16le save round-trips with BOM',
    leDisk[0] === 0xFF && leDisk[1] === 0xFE && leDisk.subarray(2).equals(Buffer.from('新文\n', 'utf16le')),
    leDisk.toString('hex'))

  // UTF-16BE with BOM: decode + round-trip
  const beBuf = Buffer.from('你好', 'utf16le'); beBuf.swap16()
  const bePath = join(tempRoot, 'utf16be.txt')
  writeFileSync(bePath, Buffer.concat([Buffer.from([0xFE, 0xFF]), beBuf]))
  const rb = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(bePath)}`)
  check('utf16be decodes', rb.body.binary === false && rb.body.content === '你好', JSON.stringify(rb.body.content))
  await call('PUT', '/dsh-fileview/file', JSON.stringify({ path: bePath, content: '甲\n' }))
  const beDisk = readFileSync(bePath)
  const beExpect = Buffer.from('甲\n', 'utf16le'); beExpect.swap16()
  check('utf16be save round-trips with BOM',
    beDisk[0] === 0xFE && beDisk[1] === 0xFF && beDisk.subarray(2).equals(beExpect),
    beDisk.toString('hex'))

  // image: binary but displayable
  const pngPath = join(tempRoot, 'pic.png')
  writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  const ri = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(pngPath)}`)
  check('png is binary + image with data', ri.body.binary === true && ri.body.image?.mime === 'image/png' && ri.body.image.data.length > 0, JSON.stringify(ri.body.image?.mime))
}

// ── large clean-UTF-8 file end-to-end (the incident shape: an 11.3 KB
// review document that head-window sniffing used to misdetect as binary) ──
{
  const bigPath = join(tempRoot, 'big-review.md')
  const heading = '> 待审提案\n\n'
  const bodyLines = []
  for (let i = 1; bodyLines.join('\n').length + heading.length < 11_300; i++) {
    bodyLines.push(`- 第 ${i} 条评审意见：内容足够长以撑起 11.3 KB 的干净 UTF-8 文档。`)
  }
  writeFileSync(bigPath, heading + bodyLines.join('\n') + '\n', 'utf8')
  const rb = await call('GET', `/dsh-fileview/file?path=${encodeURIComponent(bigPath)}`)
  check('large review doc opens as text', rb.body.ok === true && rb.body.binary === false && rb.body.whole === true, JSON.stringify({ ok: rb.body.ok, binary: rb.body.binary, whole: rb.body.whole }))
  check('large review doc content readable', typeof rb.body.content === 'string' && rb.body.content.startsWith('> 待审提案'), String(rb.body.content?.slice(0, 40)))
}

// ── router-shape guard (past incident: trailing-slash prefix never matched) ──
{
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const m = src.match(/const PREFIX = '([^']+)'/)
  const prefix = m ? m[1] : null
  check('PREFIX declared without trailing slash', prefix === '/dsh-fileview', String(prefix))
  // replicate the webserver's rule: pathname === prefix || startsWith(prefix + '/')
  const matches = (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  check('router rule matches /dsh-fileview/meta', matches('/dsh-fileview/meta'))
  check('router rule does NOT match /dsh-fileviewX', !matches('/dsh-fileviewX'))
  const r = await call('GET', '/dsh-fileviewX')
  check('handler rejects /dsh-fileviewX', r.code === 404, `${r.code}`)
}

dispose()
rmSync(tempRoot, { recursive: true, force: true })
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
