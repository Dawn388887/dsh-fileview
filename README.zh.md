# dsh-fileview

> [English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：让**远程浏览器**（通过 LAN 或 VPN 访问 DSH Web 的设备）直接在 GUI 中查看、编辑和浏览工作区文件。

## 为什么需要它

DSH 将原生工作区文件打开器保留为仅回环可用的特权操作。DSH 0.1.2 的文件链接调用 `ctx.remote.session.openWorkspacePath({ path })`；远程页面无法借此在远程设备上启动宿主机桌面程序。本插件在非回环页面包装这个 Remote 方法，通过带路径白名单的 HTTP 端点，在浏览器浮层中打开目标路径；回环页面仍调用原生系统打开器。

## 功能

- 远程页面点击文件链接 → 打开 GUI 内浮层查看器（全文本、可滚动、可选中、可编辑、可保存，触摸友好）
- 左缘「文件」把手 → 目录浏览（多根切换、面包屑、上一级）
- 回环页面（本机）保持系统默认程序打开，行为不变
- 编码阶梯：BOM（UTF-8 / UTF-16LE / UTF-16BE）→ UTF-8 → GB18030；保存时保留原编码、BOM 与换行符（CRLF/LF）
- 二进制文件：图片（PNG/JPG/GIF/WebP/BMP）直接显示，其余给出提示
- 大文件（> 2 MB）分页只读浏览
- 原子保存（临时文件 + rename）

## 客户端接管原理

DSH 0.1.2 将 `remote.session.openWorkspacePath` 安装为一个可配置、仅 getter 的自有属性，普通赋值不能替换它。因此客户端先保存完整属性描述符，再通过 `Object.defineProperty` 安装包装函数。

- 远程页面收到合法的 `{ path }` 请求时，在 GUI 查看器中打开文件，并返回成功的 Remote 结果。
- 回环页面把原始请求和 `AbortSignal` 原样转交给原生方法。
- Cordis 停止或更新插件时，清理函数恢复完全相同的原始描述符。

用于获得这些 API 的客户端依赖已在 `package.json` 中声明为 `@deepseek-ai/dsh-api-session-controller` 和 `@deepseek-ai/dsh-client-connection`。

## 安装与配置

`config.roots` 是**必填**的读写路径白名单（绝对目录；子路径放行，其余返回 403）。`config.writeRoots` 可选，用于把保存权限收窄到部分根目录。未配置 root 时，Host 插件安全地不注册任何文件路由；不会回退到机器专属目录，也不会开放整块磁盘。

```yaml
- insert:
    - id: fileview
      name: dsh-fileview
      inject: [webServer]   # 等待 webServer 就绪后再注册路由
      config:
        roots:
          - 'D:\workspace'
          - 'C:\Users\me\projects'
        writeRoots:          # 可选：仅允许保存到 D:\workspace
          - 'D:\workspace'
```

修改 composition 或 Host 代码后需要重启 `dsh web`。只修改 `client.js` 时，根据你的 DSH 安装方式重新构建或重新加载客户端插件，然后刷新页面即可。

## 安全设计

- **同源守卫**：浏览器请求带 Origin 时必须与请求到达的 Host 一致（比较 hostname，容忍反向代理改写端口）；无 Origin 调用遵循与 DSH API 层一致的姿势
- **路径白名单**：绝对路径 + 大小写不敏感的包含检查；越权和遍历请求返回 403
- **安全的未配置状态**：没有 `config.roots` 就不注册文件路由
- **保存限制**：内容上限 6 MB；GBK/GB18030 文件无法无损回写，因此拒绝在线保存并以只读方式打开

## 兼容性

- `v1.1.0` 面向 DSH `0.1.2` 及其 `ctx.remote.session.openWorkspacePath` 契约
- DSH 0.1.2 不再使用 `v1.0.0` 的 `workspaces.openPath` 接管方式
- 路径语义面向 Windows；编码阶梯依赖 Node.js ICU 的 GB18030 解码能力

## 测试

```bash
node test/fileview-smoke.mjs
node test/fileview-client-test.mjs
```

- `fileview-smoke.mjs`：34 项可移植离线 Host 回归（mock req/res、临时夹具、无需服务器），覆盖 meta/file/dir 端点、分页、CRLF 保持、二进制嗅探、白名单/遍历拒绝、同源处理、UTF-8 边界、GB18030 拒存、UTF-16LE/BE 往返、大文件和路由形状。
- `fileview-client-test.mjs`：可移植离线客户端回归，覆盖 DSH 0.1.2 Remote 描述符包装、远程接管、回环委托和原始描述符精确恢复。

## 赞助

如果这个插件帮你省了时间或麻烦，欢迎请我喝杯咖啡：

- **PayPal**：[paypal.me/dawn388887](https://paypal.me/dawn388887)

## 许可

MIT © 2026 Dawn388887
