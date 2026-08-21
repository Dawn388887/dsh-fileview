# dsh-fileview

> English | [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets **remote browsers** (devices reaching the DSH Web UI over LAN/VPN) view, edit and browse workspace files right in the GUI.

## Why it exists

DSH's `host.openPath` is pinned to loopback-only in `PRIVILEGED_METHODS`, so clicking a file link on a remote page 403s before anything opens — and the HTTP plane has no generic file-content endpoint. This plugin fills that gap, fenced the same way the rest of the surface is: **same-origin check + absolute-path allowlist**.

## Features

- Clicking a file link on a remote page opens an in-GUI overlay viewer (full text, scrollable, selectable, editable, savable, touch-friendly)
- A slim "文件" (Files) handle on the left edge opens a directory browser (multi-root switcher, breadcrumbs, parent level)
- Loopback pages keep the native OS-open behavior untouched
- Encoding ladder: BOM (UTF-8 / UTF-16LE / UTF-16BE) → UTF-8 → GB18030; saves preserve the original encoding, BOM and EOL style (CRLF/LF)
- Binary files: images (PNG/JPG/GIF/WebP/BMP) display inline, everything else gets a hint
- Large files (> 2 MB) open in read-only paginated windows
- Atomic saves (temp file + rename)

## Install & Configure

`config.roots` is the **required** read+write path allowlist (absolute directories; subpaths allowed, everything else 403). `config.writeRoots` optionally narrows saves to a subset. Unconfigured, the plugin degrades safely (registers nothing) — it will not crash `dsh web`.

```yaml
- insert:
    - id: fileview
      name: dsh-fileview
      inject: [webServer]   # required: wait for the webServer service before registering routes
      config:
        roots:
          - 'D:\workspace'
          - 'C:\Users\me\projects'
        writeRoots:          # optional: only allow saves under D:\workspace
          - 'D:\workspace'
```

Restart `dsh web` after changing the composition (bundle-layer patches do not hot-reload); client-only `client.js` changes apply on page refresh.

## Security design

- **Same-origin guard**: when a browser sends an Origin it must match the Host the request reached (hostname compare, tolerating proxies that rewrite ports); Origin-less callers (e.g. curl on the tailnet) pass, matching the `/api` posture
- **Path allowlist**: absolute paths with a case-insensitive containment check; out-of-root and traversal requests get 403
- **Save limits**: 6 MB content cap; GBK/GB18030 files refuse online save (cannot round-trip losslessly) and open read-only

## Compatibility

- Path semantics target Windows; the encoding ladder relies on Node's ICU (gb18030 decoding)
- Developed/tested against DSH rc.8

## Testing

```bash
node test/fileview-smoke.mjs
```

34 offline regression checks (mock req/res, no server): meta/file/dir endpoints, window pagination, CRLF preservation, binary sniffing, out-of-root/traversal 403, same-origin guard, encoding ladder (UTF-8 boundary, GBK refusal, UTF-16LE/BE round-trips), large files, router-shape guard.

## License

MIT © 2026 Dawn388887
