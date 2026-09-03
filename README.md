# dsh-fileview

> English | [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets **remote browsers** (devices reaching the DSH Web UI over LAN or VPN) view, edit, and browse workspace files directly in the GUI.

## Why it exists

DSH keeps its native workspace opener privileged and loopback-only. In DSH 0.1.2, file links call `ctx.remote.session.openWorkspacePath({ path })`; on a remote page, that native operation cannot open a desktop application for the remote device. This plugin wraps that Remote method on non-loopback pages and opens the requested path in a browser overlay backed by path-allowlisted HTTP endpoints. Loopback pages continue to use the native OS opener.

## Features

- Clicking a file link on a remote page opens an in-GUI overlay viewer (full text, scrollable, selectable, editable, savable, touch-friendly)
- A slim "文件" (Files) handle on the left edge opens a directory browser (multi-root switcher, breadcrumbs, parent level)
- Loopback pages keep the native OS-open behavior untouched
- Encoding ladder: BOM (UTF-8 / UTF-16LE / UTF-16BE) → UTF-8 → GB18030; saves preserve the original encoding, BOM, and EOL style (CRLF/LF)
- Binary files: images (PNG/JPG/GIF/WebP/BMP) display inline; everything else gets a hint
- Large files (> 2 MB) open in read-only paginated windows
- Atomic saves (temporary file + rename)

## How the client interception works

DSH 0.1.2 exposes `remote.session.openWorkspacePath` as a configurable, getter-only own property. Assignment does not replace it, so the client records the complete property descriptor and installs its wrapper with `Object.defineProperty`.

- On a remote page, a valid `{ path }` request opens the in-GUI viewer and returns a successful Remote result.
- On a loopback page, the wrapper forwards the original request and `AbortSignal` unchanged to the native method.
- When Cordis disposes or updates the plugin, cleanup restores the exact original descriptor.

The client dependencies used to obtain this API are declared in `package.json` as `@deepseek-ai/dsh-api-session-controller` and `@deepseek-ai/dsh-client-connection`.

## Install and configure

`config.roots` is the **required** read/write path allowlist (absolute directories; subpaths allowed, everything else receives 403). `config.writeRoots` optionally narrows saves to a subset. When no root is configured, the Host plugin safely registers no routes; it never falls back to a machine-specific directory or the whole disk.

```yaml
- insert:
    - id: fileview
      name: dsh-fileview
      inject: [webServer]   # wait for webServer before registering routes
      config:
        roots:
          - 'D:\workspace'
          - 'C:\Users\me\projects'
        writeRoots:          # optional: only allow saves under D:\workspace
          - 'D:\workspace'
```

Restart `dsh web` after changing the composition or Host code. Client-only `client.js` changes take effect after rebuilding/reloading the client plugin as required by your DSH installation and refreshing the page.

## Security design

- **Same-origin guard**: when a browser sends an Origin, it must match the Host the request reached (hostname comparison, tolerating proxies that rewrite ports); Origin-less callers follow the same posture as DSH's API plane
- **Path allowlist**: absolute paths with a case-insensitive containment check; out-of-root and traversal requests receive 403
- **Safe unconfigured state**: no `config.roots` means no file routes are registered
- **Save limits**: 6 MB content cap; GBK/GB18030 files refuse online save because they cannot be round-tripped losslessly and therefore open read-only

## Compatibility

- Release `v1.1.0` targets DSH `0.1.2` and its `ctx.remote.session.openWorkspacePath` contract
- The `v1.0.0` `workspaces.openPath` interception is not used on DSH 0.1.2
- Path semantics target Windows; the encoding ladder relies on Node.js ICU for GB18030 decoding

## Testing

```bash
node test/fileview-smoke.mjs
node test/fileview-client-test.mjs
```

- `fileview-smoke.mjs`: 34 portable offline Host checks (mock request/response, temporary fixtures, no server), covering meta/file/dir endpoints, pagination, CRLF preservation, binary sniffing, allowlist/traversal rejection, same-origin handling, UTF-8 boundaries, GB18030 refusal, UTF-16LE/BE round-trips, large files, and router shape.
- `fileview-client-test.mjs`: portable offline client regression for the DSH 0.1.2 Remote descriptor wrapper, remote interception, loopback delegation, and exact descriptor restoration.

## Support

If this plugin saves you time or a headache, a coffee is appreciated:

- **PayPal**: [paypal.me/dawn388887](https://paypal.me/dawn388887)

## License

MIT © 2026 Dawn388887
