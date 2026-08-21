// dsh-fileview — host half: HTTP endpoints so the remote Web GUI can read,
// edit, and browse workspace files in the browser.
//
// Why this exists: `host.openPath` is in the api layer's PRIVILEGED_METHODS
// set — pinned to loopback even on a trusted-host deployment — so clicking a
// file link from a Tailscale-served page 403s before anything opens. Remote
// review needs a GUI-native viewer, and the HTTP plane has no generic file
// content endpoint. This plugin adds one, fenced the same way the rest of the
// surface is: same-origin check (cross-site pages cannot ride the user's
// tailnet session from a browser) plus an absolute-path allowlist from the
// composition row config (`config.roots`; `config.writeRoots` narrows saves).
//
// Endpoints (all JSON, no-store):
//   GET  /dsh-fileview/meta                 -> { roots }
//   GET  /dsh-fileview/file?path=&offset=&limit=
//        Whole UTF-8 text when size <= WHOLE_FILE_BYTES, else a line window
//        (1-based offset, default 1; limit default WINDOW_LINES). Binary files
//        answer binary:true with no content.
//   PUT  /dsh-fileview/file  { path, content }
//        Atomic save; preserves the on-disk BOM and dominant EOL.
//   GET  /dsh-fileview/dir?path=            -> one directory level with types
//
// Pure-local plugin: no @deepseek-ai imports, safe as a link: dependency.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

// NOTE: prefix routes must NOT end with '/' — the webserver matches
// `pathname === prefix || pathname.startsWith(prefix + '/')`, so a trailing
// slash ("/dsh-fileview/") matches only "/dsh-fileview//x" and every real
// request falls through to the SPA fallback (a past production incident).
const PREFIX = '/dsh-fileview'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_CONTENT_BYTES = 6 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024
const WHOLE_FILE_BYTES = 2 * 1024 * 1024
const WINDOW_LINES = 800
const MAX_LIMIT = 10000

function send(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function fail(res, code, message) {
  send(res, code, { ok: false, error: message })
}

/** Normalize an incoming absolute path; null when malformed. */
function normalizePath(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  if (raw.includes('\0')) return null
  if (!isAbsolute(raw)) return null
  return resolve(raw)
}

/** Case-insensitive containment check (Windows paths). */
function underRoots(path, roots) {
  const pl = path.toLowerCase()
  for (const root of roots) {
    const rl = root.toLowerCase()
    if (pl === rl || pl.startsWith(rl.endsWith(sep) ? rl : rl + sep)) return true
  }
  return false
}

/**
 * CSRF fence: when a browser sends an Origin it must name the same host the
 * request reached (hostname compare — proxies such as Tailscale serve may
 * rewrite the port, and a registrant controls every port on its hostname).
 * Origin-less callers (curl on the tailnet) pass, matching the /api posture.
 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (origin === undefined || origin === 'null') return true
  try {
    const originHost = new URL(String(origin)).hostname
    const hostHeader = String(req.headers?.host || '')
    const hostName = new URL(`http://${hostHeader}`).hostname
    return originHost !== '' && hostName !== '' && originHost === hostName
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error('request body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', rejectBody)
  })
}

/**
 * Decode a whole file buffer to text with an encoding ladder. Sniffing a
 * head window is WRONG: a codepoint lead byte sitting exactly at the window
 * edge decodes to U+FFFD and flags clean UTF-8 as binary (a real incident:
 * an 11.3 KB review file was misdetected). Always decode the full buffer.
 *
 * Ladder: BOM (utf-8 / utf-16le / utf-16be) -> NUL means binary -> strict
 * UTF-8 -> lossy UTF-8 tolerating isolated corruption (<=1 bad rune per
 * 1000 chars) -> GB18030 for legacy Chinese files (view-only) -> binary.
 *
 * @returns {text, encoding, bom} or null when the buffer is binary.
 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8', bom: true }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le', bom: true }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be', bom: true }
  }
  if (buf.includes(0)) return null
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', bom: false }
  } catch {
    /* fall through */
  }
  const lossy = new TextDecoder('utf-8').decode(buf)
  if (lossy.length > 0 && countReplacement(lossy) <= Math.max(2, Math.floor(lossy.length / 1000))) {
    return { text: lossy, encoding: 'utf-8', bom: false }
  }
  try {
    const gb = new TextDecoder('gb18030').decode(buf)
    if (gb.length > 0 && countReplacement(gb) <= Math.max(2, Math.floor(gb.length / 500))) {
      return { text: gb, encoding: 'gb18030', bom: false }
    }
  } catch {
    /* ICU without gb18030 — treat as binary */
  }
  return null
}

function countReplacement(text) {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) n += 1
  return n
}

/** Inline-image extension map; svg stays text (it is UTF-8 source). */
const IMAGE_MIMES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
])

function imageMimeOf(path) {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null
  return IMAGE_MIMES.get(path.slice(dot).toLowerCase()) ?? null
}

function statOrNull(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default {
  name: 'dsh-fileview',
  apply(ctx, rawConfig) {
    const cfg = rawConfig ?? {}
    const rawRoots = Array.isArray(cfg.roots) && cfg.roots.length > 0
      ? cfg.roots
      : []
    const roots = rawRoots
      .map((r) => (typeof r === 'string' && r !== '' ? resolve(r) : null))
      .filter(Boolean)
    const writeRootsRaw = Array.isArray(cfg.writeRoots) && cfg.writeRoots.length > 0
      ? cfg.writeRoots
      : rawRoots
    const writeRoots = writeRootsRaw
      .map((r) => (typeof r === 'string' && r !== '' ? resolve(r) : null))
      .filter(Boolean)
    if (roots.length === 0) {
      // Unconfigured is a safe no-op, never a crash: the profile must keep
      // booting so the user can read the hint and add config.roots.
      ctx.logger?.warn?.('[dsh-fileview] config.roots 未配置——本插件未注册任何路由。请在 cordis.patch.yml 的 config.roots 指定至少一个绝对路径目录（例：D:\\workspace）。')
      return () => {}
    }

    const webServer = ctx.get('webServer')
    if (webServer === undefined) {
      throw new Error('dsh-fileview: webServer service unavailable (missing inject: [webServer]?)')
    }

    function allowedRead(path) {
      return underRoots(path, roots)
    }

    function allowedWrite(path) {
      return underRoots(path, writeRoots)
    }

    // ── GET /meta ───────────────────────────────────────────────────────
    async function handleMeta(req, res) {
      send(res, 200, { ok: true, roots, writeRoots })
    }

    // ── GET/PUT /file ───────────────────────────────────────────────────
    async function handleFile(req, res, query) {
      if (req.method === 'PUT') {
        let body
        try {
          body = JSON.parse((await readBody(req)).toString('utf8'))
        } catch (err) {
          return fail(res, err?.statusCode === 413 ? 413 : 400, `bad JSON body: ${err?.message ?? err}`)
        }
        const path = normalizePath(body?.path)
        if (path === null) return fail(res, 400, 'path must be absolute')
        if (!allowedWrite(path)) return fail(res, 403, `write outside allowlist: ${path}`)
        const content = body?.content
        if (typeof content !== 'string') return fail(res, 400, 'content must be a string')
        if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
          return fail(res, 413, `content exceeds ${formatBytes(MAX_CONTENT_BYTES)}`)
        }
        const existing = statOrNull(path)
        if (existing !== null && !existing.isFile()) return fail(res, 400, 'path is a directory')

        // Preserve the on-disk encoding, BOM, and dominant EOL of the file
        // being replaced. Saves re-encode with the SAME encoding — a silent
        // conversion would corrupt downstream toolchains that expect it.
        let out = content
        let encoding = 'utf-8'
        let bom = false
        if (existing !== null) {
          const prev = readFileSync(path)
          const prevDecoded = decodeText(prev)
          if (prevDecoded === null) {
            return fail(res, 409, 'existing file is binary or unknown encoding — refusing to overwrite from the web viewer')
          }
          if (prevDecoded.encoding === 'gb18030') {
            return fail(res, 409, 'GBK/GB18030 编码文件暂不支持在线保存（无法无损转回），请在本机编辑此文件')
          }
          encoding = prevDecoded.encoding
          bom = prevDecoded.bom
          const crlf = (prevDecoded.text.match(/\r\n/g) || []).length
          const lf = (prevDecoded.text.match(/\n/g) || []).length
          if (crlf * 2 > lf) out = out.replace(/\r?\n/g, '\r\n')
          else out = out.replace(/\r\n/g, '\n')
        }
        let data
        if (encoding === 'utf-16le' || encoding === 'utf-16be') {
          data = Buffer.from(out, 'utf16le')
          if (encoding === 'utf-16be') data.swap16()
          if (bom) {
            const bomBuf = encoding === 'utf-16le'
              ? Buffer.from([0xff, 0xfe])
              : Buffer.from([0xfe, 0xff])
            data = Buffer.concat([bomBuf, data])
          }
        } else {
          const parts = []
          if (bom) parts.push(Buffer.from([0xef, 0xbb, 0xbf]))
          parts.push(Buffer.from(out, 'utf8'))
          data = Buffer.concat(parts)
        }
        const tmp = join(dirname(path), `.dsh-fileview-${process.pid}.tmp`)
        try {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(tmp, data)
          renameSync(tmp, path)
        } catch (err) {
          return fail(res, 500, `save failed: ${err?.message ?? err}`)
        }
        ctx.logger?.info?.(`[dsh-fileview] saved ${path} (${formatBytes(data.length)})`)
        return send(res, 200, { ok: true, path, bytes: data.length })
      }

      if (req.method !== 'GET') return fail(res, 405, 'method not allowed')

      const path = normalizePath(query.get('path'))
      if (path === null) return fail(res, 400, 'path must be absolute')
      if (!allowedRead(path)) return fail(res, 403, `path outside allowlist: ${path}`)

      const st = statOrNull(path)
      if (st === null) return fail(res, 404, 'file not found')
      if (!st.isFile()) return fail(res, 400, 'path is a directory')
      if (st.size > MAX_FILE_BYTES) {
        return fail(res, 413, `file larger than ${formatBytes(MAX_FILE_BYTES)}; use the read tool`)
      }
      const buf = readFileSync(path)
      const decoded = decodeText(buf)
      const meta = {
        path,
        size: st.size,
        sizeText: formatBytes(st.size),
        mtimeMs: Math.round(st.mtimeMs),
      }
      if (decoded === null) {
        const mime = imageMimeOf(path)
        if (mime !== null) {
          return send(res, 200, {
            ok: true,
            ...meta,
            binary: true,
            image: { mime, data: buf.toString('base64') },
            content: '',
          })
        }
        return send(res, 200, { ok: true, ...meta, binary: true, content: '' })
      }
      meta.binary = false
      meta.encoding = decoded.encoding
      meta.bom = decoded.bom
      meta.saveable = decoded.encoding !== 'gb18030'

      const text = decoded.text
      const lines = text.split('\n')
      let trailingNewline = false
      if (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop()
        trailingNewline = true
      }
      const totalLines = lines.length
      meta.totalLines = totalLines
      meta.binary = false

      const wantWhole = query.get('offset') === null && query.get('limit') === null
      if (wantWhole && st.size <= WHOLE_FILE_BYTES) {
        return send(res, 200, {
          ok: true,
          ...meta,
          whole: true,
          trailingNewline,
          offset: 1,
          limit: Math.max(totalLines, 1),
          content: text,
        })
      }

      let offset = Number(query.get('offset'))
      if (!Number.isInteger(offset) || offset < 1) offset = 1
      let limit = Number(query.get('limit'))
      if (!Number.isInteger(limit) || limit < 1) limit = WINDOW_LINES
      if (limit > MAX_LIMIT) limit = MAX_LIMIT
      if (offset > Math.max(totalLines, 1)) return fail(res, 400, `offset ${offset} beyond total ${totalLines}`)
      const slice = lines.slice(offset - 1, offset - 1 + limit).map((line) => line.replace(/\r$/, ''))
      send(res, 200, {
        ok: true,
        ...meta,
        whole: false,
        trailingNewline,
        offset,
        limit: slice.length,
        content: slice.join('\n'),
      })
    }

    // ── GET /dir ────────────────────────────────────────────────────────
    async function handleDir(req, res, query) {
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed')
      const raw = query.get('path')
      const dir = raw === null || raw === '' ? roots[0] : normalizePath(raw)
      if (dir === null) return fail(res, 400, 'path must be absolute')
      if (!allowedRead(dir)) return fail(res, 403, `path outside allowlist: ${dir}`)
      const st = statOrNull(dir)
      if (st === null) return fail(res, 404, 'directory not found')
      if (!st.isDirectory()) return fail(res, 400, 'path is a file')

      const dirents = readdirSync(dir, { withFileTypes: true })
      const entries = []
      for (const d of dirents) {
        const child = join(dir, d.name)
        const cst = statOrNull(child)
        entries.push({
          name: d.name,
          path: child,
          dir: d.isDirectory(),
          hidden: d.name.startsWith('.'),
          size: d.isDirectory() || cst === null ? null : cst.size,
          sizeText: d.isDirectory() || cst === null ? '' : formatBytes(cst.size),
          mtimeMs: cst === null ? null : Math.round(cst.mtimeMs),
        })
      }
      entries.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      })
      const parent = dirname(dir)
      send(res, 200, {
        ok: true,
        path: dir,
        parent: parent !== dir && allowedRead(parent) ? parent : null,
        entries,
        count: entries.length,
      })
    }

    // ── prefix route ────────────────────────────────────────────────────
    const dispose = webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler(req, res) {
        Promise.resolve()
          .then(async () => {
            if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request rejected')
            const url = new URL(req.url, 'http://dsh-fileview.internal')
            const pathname = url.pathname
            if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return fail(res, 404, 'not found')
            const sub = pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
            const query = url.searchParams
            if (sub === 'meta') return handleMeta(req, res)
            if (sub === 'file') return handleFile(req, res, query)
            if (sub === 'dir') return handleDir(req, res, query)
            return fail(res, 404, `unknown endpoint /${sub}`)
          })
          .catch((err) => {
            const code = err?.statusCode ?? 500
            try {
              fail(res, code, String(err?.message ?? err))
            } catch {
              /* response already gone */
            }
            ctx.logger?.warn?.(`[dsh-fileview] ${req.method} ${req.url} -> ${code}: ${err?.message ?? err}`)
          })
      },
    })

    ctx.logger?.info?.(`[dsh-fileview] routes ready under ${PREFIX} (roots: ${roots.join('; ')})`)
    return () => {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  },
}
