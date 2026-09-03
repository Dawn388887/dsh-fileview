// dsh-fileview client half — in-GUI file viewer/editor for remote browsers.
//
// On a non-loopback page (VPN, LAN, tablet, or another remote browser) the
// shipped file links cannot use the privileged Host workspace opener. DSH
// 0.1.2 routes those links through ctx.remote.session.openWorkspacePath(), so
// this half wraps that Remote method and opens the same path in a DOM overlay
// served by /dsh-fileview instead: full text, scrollable, selectable, editable
// and savable, touch-friendly. Loopback pages keep the native OS-open behavior
// untouched.
//
// A slim "文件" handle on the left edge opens a directory browser over the
// same endpoints, so the user can pull up any workspace file without
// waiting for the agent to read it first.

window.__ModuleLoader__.load({
  id: "dsh-fileview",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const API = "/dsh-fileview";
    const LS_LAST_DIR = "dsh-fileview:lastDir";

    // ── tiny helpers ────────────────────────────────────────────────────
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function fmtTime(ms) {
      try { return new Date(ms).toLocaleString(); } catch (e) { return ""; }
    }

    function clockNow() {
      return new Date().toTimeString().slice(0, 8);
    }

    async function httpGet(url) {
      const res = await fetch(url, { cache: "no-store" });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
      if (!res.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || `HTTP ${res.status}`);
      }
      return body;
    }

    async function httpPut(url, payload) {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
      if (!res.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || `HTTP ${res.status}`);
      }
      return body;
    }

    function lsGet(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function lsSet(key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
    }

    // ── overlay DOM (built once) ────────────────────────────────────────
    let overlay = null;
    let mode = "hidden"; // 'viewer' | 'browser' | 'hidden'
    let savedBodyOverflow = "";

    function ensureStyle() {
      if (document.getElementById("dsh-fileview-style")) return;
      const style = el("style");
      style.id = "dsh-fileview-style";
      style.textContent = `
.dfv-root,.dfv-root *,.dfv-entry{box-sizing:border-box}
.dfv-root{position:fixed;inset:0;z-index:2147483000;display:none;font-family:var(--ds-font-family-body,system-ui,sans-serif)}
.dfv-root.dfv-open{display:block}
.dfv-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45)}
.dfv-panel{position:absolute;left:50%;top:0;transform:translateX(-50%);width:min(1100px,100vw);height:100%;display:flex;flex-direction:column;background:#fdfcf9;color:#1f2328;box-shadow:0 0 40px rgba(0,0,0,.5)}
.dfv-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #e7e4db;flex:none}
.dfv-titleWrap{flex:1;min-width:0;cursor:pointer}
.dfv-name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfv-path{font-size:12px;color:#8a8578;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace)}
.dfv-btn{flex:none;height:34px;min-width:34px;padding:0 12px;border-radius:8px;border:1px solid #d8d4c9;background:transparent;color:#3a3f45;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px}
.dfv-btn:hover{background:#f1efe9}
.dfv-btn:disabled{opacity:.45;cursor:default}
.dfv-btn.dfv-primary{border-color:#2f6fd6;color:#2f6fd6}
.dfv-body{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}
.dfv-textarea{flex:1;width:100%;min-width:0;border:0;outline:0;resize:none;padding:14px 18px;background:#fbfaf6;color:#1f2328;caret-color:#1f2328;font:14px/1.85 var(--ds-font-family-body,system-ui,"Microsoft YaHei",sans-serif);white-space:pre-wrap;word-break:break-word;overflow-x:hidden;overflow-y:auto;tab-size:4}
.dfv-textarea::selection{background:#b8d2f8}
.dfv-textarea::-webkit-scrollbar-thumb{background:#c9c5bb;border-radius:6px}
.dfv-textarea::-webkit-scrollbar-track{background:transparent}
.dfv-notice{flex:1;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:14px;padding:24px;text-align:center}
.dfv-imgBox{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:#f2f0ea}
.dfv-imgBox img{max-width:100%;max-height:100%;object-fit:contain}
.dfv-list{flex:1;overflow-y:auto;padding:4px 0}
.dfv-list::-webkit-scrollbar-thumb{background:#d4d0c6;border-radius:6px}
.dfv-list::-webkit-scrollbar-track{background:transparent}
.dfv-row{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;font-size:14px}
.dfv-row:hover{background:#f1efe9}
.dfv-rowName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfv-rowName.dfv-dim{color:#9a958a}
.dfv-rowMeta{flex:none;font-size:12px;color:#9a958a}
.dfv-crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:8px 14px 2px;font-size:12px;color:#8a8578;flex:none}
.dfv-crumb{cursor:pointer;padding:2px 4px;border-radius:4px}
.dfv-crumb:hover{background:#f1efe9}
.dfv-crumbCur{color:#1f2328;cursor:default}
.dfv-select{flex:none;height:30px;border-radius:8px;border:1px solid #d8d4c9;background:#fdfcf9;color:#1f2328;font-size:12px;max-width:220px}
.dfv-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:8px 14px;border-top:1px solid #e7e4db;font-size:12px;color:#6b7280;flex:none}
.dfv-footErr{color:#d64541}
.dfv-footSpacer{flex:1}
.dfv-pager{display:flex;align-items:center;gap:8px}
.dfv-entry{position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:9000;writing-mode:vertical-rl;letter-spacing:3px;padding:14px 5px;border-radius:0 10px 10px 0;border:1px solid var(--dsw-alias-border-l1,#3a3f47);border-left:0;background:var(--dsw-alias-bg-elevated,#202329);color:var(--dsw-alias-label-secondary,#aab0b8);font-size:12px;cursor:pointer;user-select:none}
.dfv-entry:hover{color:var(--dsw-alias-label-primary,#e8eaed)}
@media (max-width:640px){.dfv-panel{width:100vw}.dfv-btn{padding:0 9px}.dfv-name{font-size:14px}}
`;
      document.head.appendChild(style);
    }

    function ensureOverlay() {
      ensureStyle();
      if (overlay) return overlay;
      const root = el("div", "dfv-root");
      root.innerHTML = "";
      const backdrop = el("div", "dfv-backdrop");
      const panel = el("div", "dfv-panel");
      root.appendChild(backdrop);
      root.appendChild(panel);

      const head = el("div", "dfv-head");
      const titleWrap = el("div", "dfv-titleWrap");
      titleWrap.title = "点击复制完整路径";
      const name = el("div", "dfv-name", "");
      const pathLine = el("div", "dfv-path", "");
      titleWrap.appendChild(name);
      titleWrap.appendChild(pathLine);
      titleWrap.addEventListener("click", () => {
        const p = mode === "viewer" ? viewer.path : browser.dir;
        if (!p) return;
        navigator.clipboard?.writeText(p).then(
          () => setFoot("路径已复制：" + p),
          () => setFoot(p),
        );
      });
      const crumbs = el("div", "dfv-crumbs");
      crumbs.style.display = "none";
      const rootSelect = el("select", "dfv-select");
      rootSelect.style.display = "none";
      const btnDir = el("button", "dfv-btn", "📂");
      btnDir.title = "在浏览器中显示所在目录";
      const btnReload = el("button", "dfv-btn", "⟳");
      btnReload.title = "重新加载";
      const btnSave = el("button", "dfv-btn dfv-primary", "保存");
      btnSave.title = "保存修改 (Ctrl+S)";
      btnSave.disabled = true;
      const btnClose = el("button", "dfv-btn", "✕");
      btnClose.title = "关闭 (Esc)";
      head.appendChild(titleWrap);
      head.appendChild(rootSelect);
      head.appendChild(btnDir);
      head.appendChild(btnReload);
      head.appendChild(btnSave);
      head.appendChild(btnClose);

      const body = el("div", "dfv-body");
      const textarea = document.createElement("textarea");
      textarea.className = "dfv-textarea";
      textarea.spellcheck = false;
      textarea.setAttribute("wrap", "soft");
      const notice = el("div", "dfv-notice");
      notice.style.display = "none";
      const imgBox = el("div", "dfv-imgBox");
      const img = document.createElement("img");
      img.alt = "";
      imgBox.appendChild(img);
      imgBox.style.display = "none";
      const list = el("div", "dfv-list");
      list.style.display = "none";
      body.appendChild(textarea);
      body.appendChild(imgBox);
      body.appendChild(notice);
      body.appendChild(list);
      body.appendChild(crumbs);

      const foot = el("div", "dfv-foot");
      const footStatus = el("span", "", "");
      const footSpacer = el("span", "dfv-footSpacer");
      const pager = el("div", "dfv-pager");
      pager.style.display = "none";
      const btnPrev = el("button", "dfv-btn", "◀ 上一页");
      const pageLabel = el("span", "", "");
      const btnNext = el("button", "dfv-btn", "下一页 ▶");
      pager.appendChild(btnPrev);
      pager.appendChild(pageLabel);
      pager.appendChild(btnNext);
      foot.appendChild(footStatus);
      foot.appendChild(footSpacer);
      foot.appendChild(pager);

      panel.appendChild(head);
      panel.appendChild(body);
      panel.appendChild(foot);
      document.body.appendChild(root);

      overlay = {
        root, panel, backdrop,
        name, pathLine, crumbs, rootSelect,
        btnDir, btnReload, btnSave, btnClose,
        textarea, imgBox, img, notice, list,
        footStatus, pager, btnPrev, btnNext, pageLabel,
      };

      btnClose.addEventListener("click", () => closeOverlay());
      btnReload.addEventListener("click", () => {
        if (mode === "viewer" && viewer.path) openViewer(viewer.path, { force: true });
        if (mode === "browser" && browser.dir) loadDir(browser.dir);
      });
      btnDir.addEventListener("click", () => {
        if (mode === "viewer" && viewer.path) {
          const dir = viewer.path.replace(/[/\\][^/\\]*$/, "");
          openBrowser(dir);
        }
      });
      btnSave.addEventListener("click", () => saveViewer());
      btnPrev.addEventListener("click", () => {
        if (viewer.windowed && viewer.offset > 1) {
          loadWindow(viewer.path, Math.max(1, viewer.offset - viewer.limit), viewer.limit);
        }
      });
      btnNext.addEventListener("click", () => {
        if (viewer.windowed && viewer.offset + viewer.limit <= viewer.totalLines) {
          loadWindow(viewer.path, viewer.offset + viewer.limit, viewer.limit);
        }
      });
      textarea.addEventListener("input", () => markDirty());
      textarea.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
          ev.preventDefault();
          saveViewer();
        }
      });
      rootSelect.addEventListener("change", () => {
        const value = rootSelect.value;
        if (value) openBrowser(value);
      });
      document.addEventListener("keydown", onGlobalKey, true);

      return overlay;
    }

    function onGlobalKey(ev) {
      if (mode === "hidden" || !overlay) return;
      if (ev.key === "Escape") {
        ev.stopPropagation();
        closeOverlay();
      }
    }

    function showOverlay(nextMode) {
      ensureOverlay();
      mode = nextMode;
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      overlay.root.classList.add("dfv-open");
    }

    function closeOverlay() {
      if (mode === "viewer" && viewer.dirty) {
        if (!window.confirm("有未保存的修改，确定关闭？")) return;
      }
      mode = "hidden";
      if (overlay) {
        overlay.root.classList.remove("dfv-open");
        overlay.textarea.value = "";
        overlay.img.removeAttribute("src");
        viewer = emptyViewer();
      }
      document.body.style.overflow = savedBodyOverflow;
    }

    // ── viewer mode ─────────────────────────────────────────────────────
    function emptyViewer() {
      return {
        path: null, meta: null, baseline: "", dirty: false,
        windowed: false, offset: 1, limit: 0, totalLines: 0,
      };
    }
    let viewer = emptyViewer();

    function markDirty() {
      if (mode !== "viewer" || viewer.windowed) return;
      const dirty = overlay.textarea.value !== viewer.baseline;
      if (dirty !== viewer.dirty) {
        viewer.dirty = dirty;
        overlay.btnSave.disabled = !dirty;
        setFoot(dirty ? "● 有未保存修改" : `已保存 · 共 ${viewer.totalLines} 行 · ${viewer.meta ? viewer.meta.sizeText : ""}`, dirty);
      }
    }

    function setFoot(text, isError) {
      overlay.footStatus.textContent = text;
      overlay.footStatus.className = isError ? "dfv-footErr" : "";
    }

    function layoutViewer() {
      const o = overlay;
      o.crumbs.style.display = "none";
      o.rootSelect.style.display = "none";
      o.list.style.display = "none";
      o.btnDir.style.display = "";
      o.btnSave.style.display = "";
      o.pager.style.display = "none";
    }

    async function openViewer(path, opts) {
      if (mode === "viewer" && viewer.dirty && (viewer.path !== path || opts?.force)) {
        if (!window.confirm("有未保存的修改，确定放弃？")) return;
      }
      showOverlay("viewer");
      layoutViewer();
      viewer = emptyViewer();
      viewer.path = path;
      overlay.name.textContent = path.replace(/^.*[/\\]/, "") || path;
      overlay.pathLine.textContent = path;
      overlay.textarea.style.display = "none";
      overlay.imgBox.style.display = "none";
      overlay.notice.style.display = "flex";
      overlay.notice.textContent = "加载中…";
      overlay.btnSave.disabled = true;
      setFoot("");
      try {
        const meta = await httpGet(`${API}/file?path=${encodeURIComponent(path)}`);
        if (mode !== "viewer" || viewer.path !== path) return;
        applyViewerData(meta);
      } catch (err) {
        if (mode !== "viewer") return;
        overlay.notice.textContent = `打开失败：${err.message}`;
        setFoot(`打开失败：${err.message}`, true);
      }
    }

    function applyViewerData(meta) {
      const o = overlay;
      viewer.meta = meta;
      viewer.totalLines = meta.totalLines || 0;
      o.notice.style.display = "none";
      o.imgBox.style.display = "none";
      if (meta.binary) {
        o.textarea.style.display = "none";
        if (meta.image && meta.image.data) {
          o.imgBox.style.display = "";
          o.img.src = `data:${meta.image.mime};base64,${meta.image.data}`;
          o.btnSave.disabled = true;
          setFoot(`图片 · ${meta.image.mime} · ${meta.sizeText}`);
          return;
        }
        o.notice.style.display = "flex";
        o.notice.textContent = `二进制文件（${meta.sizeText}），无法在线查看——可让主控转出文本，或在本机页面用系统默认程序打开`;
        o.btnSave.disabled = true;
        setFoot(`二进制 · ${meta.sizeText}`);
        return;
      }
      o.textarea.style.display = "";
      if (meta.whole) {
        viewer.windowed = false;
        viewer.offset = 1;
        viewer.limit = Math.max(viewer.totalLines, 1);
        const canEdit = meta.saveable !== false;
        o.textarea.readOnly = !canEdit;
        o.textarea.value = meta.content;
        viewer.baseline = meta.content;
        viewer.dirty = false;
        o.btnSave.disabled = true;
        if (canEdit) {
          setFoot(`共 ${viewer.totalLines} 行 · ${meta.sizeText} · ${fmtTime(meta.mtimeMs)}`);
        } else {
          setFoot(`${meta.encoding || ''} 编码——仅预览，在线保存未开放（避免编码损坏） · ${meta.sizeText}`);
        }
      } else {
        viewer.windowed = true;
        viewer.offset = meta.offset;
        viewer.limit = meta.limit;
        o.textarea.readOnly = true;
        o.textarea.value = meta.content;
        o.btnSave.disabled = true;
        o.pager.style.display = "flex";
        o.btnPrev.disabled = meta.offset <= 1;
        o.btnNext.disabled = meta.offset + meta.limit > viewer.totalLines;
        o.pageLabel.textContent = `第 ${meta.offset}–${Math.min(meta.offset + meta.limit - 1, viewer.totalLines)} 行 / 共 ${viewer.totalLines} 行`;
        setFoot(`文件较大（${meta.sizeText}），分页只读浏览`);
      }
    }

    async function loadWindow(path, offset, limit) {
      try {
        const meta = await httpGet(
          `${API}/file?path=${encodeURIComponent(path)}&offset=${offset}&limit=${limit}`,
        );
        if (mode === "viewer" && viewer.path === path) applyViewerData(meta);
      } catch (err) {
        setFoot(`加载失败：${err.message}`, true);
      }
    }

    async function saveViewer() {
      if (mode !== "viewer" || viewer.windowed || !viewer.path || viewer.dirty === false) return;
      if (viewer.meta && viewer.meta.saveable === false) return;
      const content = overlay.textarea.value;
      overlay.btnSave.disabled = true;
      setFoot("保存中…");
      try {
        await httpPut(`${API}/file`, { path: viewer.path, content });
        viewer.baseline = content;
        viewer.dirty = false;
        setFoot(`已保存 · ${clockNow()}`);
      } catch (err) {
        viewer.dirty = true;
        overlay.btnSave.disabled = false;
        setFoot(`保存失败：${err.message}`, true);
      }
    }

    // ── browser mode ────────────────────────────────────────────────────
    const browser = { dir: null, roots: [] };

    function layoutBrowser() {
      const o = overlay;
      o.textarea.style.display = "none";
      o.imgBox.style.display = "none";
      o.notice.style.display = "none";
      o.btnDir.style.display = "none";
      o.btnSave.style.display = "none";
      o.pager.style.display = "none";
      o.crumbs.style.display = "flex";
      o.list.style.display = "";
      o.rootSelect.style.display = "";
    }

    async function ensureRoots() {
      if (browser.roots.length > 0) return;
      try {
        const meta = await httpGet(`${API}/meta`);
        browser.roots = Array.isArray(meta.roots) ? meta.roots : [];
      } catch (err) {
        browser.roots = [];
      }
      overlay.rootSelect.innerHTML = "";
      for (const root of browser.roots) {
        const opt = el("option", "", root);
        opt.value = root;
        overlay.rootSelect.appendChild(opt);
      }
    }

    async function openBrowser(dirPath) {
      showOverlay("browser");
      layoutBrowser();
      overlay.name.textContent = "文件浏览";
      setFoot("加载中…");
      await ensureRoots();
      const target = dirPath || browser.roots[0] || lsGet(LS_LAST_DIR);
      if (!target) {
        overlay.list.innerHTML = "";
        setFoot("没有可浏览的根目录（插件未配置 roots）", true);
        return;
      }
      await loadDir(target);
    }

    function renderCrumbs(dir, rootUsed) {
      const o = overlay;
      o.crumbs.innerHTML = "";
      const rootName = rootUsed.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || rootUsed;
      const rel = dir.toLowerCase().startsWith(rootUsed.toLowerCase())
        ? dir.slice(rootUsed.length).replace(/^[/\\]+/, "")
        : "";
      const home = el("span", "dfv-crumb", `📁 ${rootName}`);
      home.addEventListener("click", () => loadDir(rootUsed));
      o.crumbs.appendChild(home);
      if (rel) {
        let acc = rootUsed;
        for (const seg of rel.split(/[/\\]+/).filter(Boolean)) {
          acc = acc + (acc.endsWith("\\") || acc.endsWith("/") ? "" : "\\") + seg;
          const crumb = el("span", "dfv-crumb", ` › ${seg}`);
          const target = acc;
          crumb.addEventListener("click", () => loadDir(target));
          o.crumbs.appendChild(crumb);
        }
      }
      o.pathLine.textContent = dir;
    }

    async function loadDir(dir) {
      if (mode !== "browser") return;
      setFoot("加载中…");
      overlay.list.innerHTML = "";
      try {
        const data = await httpGet(`${API}/dir?path=${encodeURIComponent(dir)}`);
        if (mode !== "browser") return;
        browser.dir = data.path;
        lsSet(LS_LAST_DIR, data.path);
        overlay.rootSelect.value = matchingRoot(data.path) || browser.roots[0] || "";
        renderCrumbs(data.path, matchingRoot(data.path) || data.path);
        const list = overlay.list;
        list.innerHTML = "";
        if (data.parent) {
          const up = el("div", "dfv-row");
          up.appendChild(el("span", "", "⬆️"));
          up.appendChild(el("span", "dfv-rowName dfv-dim", ".."));
          up.appendChild(el("span", "dfv-rowMeta", "上一级"));
          up.addEventListener("click", () => loadDir(data.parent));
          list.appendChild(up);
        }
        for (const entry of data.entries) {
          if (entry.hidden) continue;
          const row = el("div", "dfv-row");
          row.appendChild(el("span", "", entry.dir ? "📁" : "📄"));
          row.appendChild(el("span", "dfv-rowName", entry.name));
          row.appendChild(el(
            "span",
            "dfv-rowMeta",
            entry.dir ? "" : `${entry.sizeText}${entry.mtimeMs ? " · " + new Date(entry.mtimeMs).toLocaleDateString() : ""}`,
          ));
          row.addEventListener("click", () => {
            if (entry.dir) return loadDir(entry.path);
            // Loopback pages keep the OS-default-app behavior everywhere
            // (the pre-plugin contract); the viewer is the remote affordance.
            if (!isRemotePage() && nativeOpenPath) {
              Promise.resolve(nativeOpenPath(entry.path)).catch(() => {});
              return;
            }
            openViewer(entry.path);
          });
          list.appendChild(row);
        }
        if (data.count === 0 && !data.parent) {
          list.appendChild(el("div", "dfv-notice", "空目录"));
        }
        setFoot(`${data.path} · ${data.count} 项`);
      } catch (err) {
        const fallback = browser.roots[0];
        if (fallback && dir !== fallback) {
          setFoot(`${dir} 打不开（${err.message}），回到根目录`, true);
          loadDir(fallback);
        } else {
          setFoot(`打开失败：${err.message}`, true);
        }
      }
    }

    function matchingRoot(dir) {
      let best = null;
      for (const root of browser.roots) {
        if (dir.toLowerCase().startsWith(root.toLowerCase())) {
          if (best === null || root.length > best.length) best = root;
        }
      }
      return best;
    }

    // ── entry handle ────────────────────────────────────────────────────
    let entryBtn = null;
    let nativeOpenPath = null; // captured native Remote opener; loopback pages keep OS-open everywhere
    let connectionHandle = null;

    function isRemotePage() {
      try {
        return connectionHandle !== null && connectionHandle !== undefined && connectionHandle.isLoopback === false;
      } catch (e) {
        return false;
      }
    }

    function ensureEntry() {
      if (entryBtn || typeof document === "undefined") return;
      ensureStyle();
      entryBtn = el("div", "dfv-entry", "文件");
      entryBtn.title = "浏览工作区文件";
      entryBtn.addEventListener("click", () => openBrowser(lsGet(LS_LAST_DIR) || undefined));
      document.body.appendChild(entryBtn);
    }

    /** Run init now, or as soon as <body> exists (module scripts may beat DOM parse). */
    function onBodyReady(fn) {
      if (document.body) {
        fn();
        return;
      }
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    }

    // ── plugin: patch the 0.1.2 Remote workspace opener ────────────────
    var inject = ["connection", "remote", "remote.session"];

    function apply(ctx) {
      const remoteSession = ctx.remote.session;
      connectionHandle = ctx.connection;

      const cleanups = [];
      let disposed = false;

      if (typeof remoteSession.openWorkspacePath === "function" && !remoteSession.openWorkspacePath.__dshFileviewNative) {
        const nativeDescriptor = Object.getOwnPropertyDescriptor(remoteSession, "openWorkspacePath");
        const nativeMethod = remoteSession.openWorkspacePath;
        const nativeOpen = nativeMethod.bind(remoteSession);
        nativeOpenPath = function (path) { return nativeOpen({ path: String(path) }); };
        const patchedOpen = function openWorkspacePath(request, signal) {
          if (!isRemotePage()) return nativeOpen(request, signal);
          const path = request && typeof request.path === "string" ? request.path : "";
          if (!path) return nativeOpen(request, signal);
          try {
            void openViewer(path);
            return Promise.resolve({ ok: true, value: { opened: true } });
          } catch (err) {
            console.error("[dsh-fileview] open viewer failed:", err);
            return Promise.reject(err);
          }
        };
        patchedOpen.__dshFileviewNative = nativeMethod;
        // DSH 0.1.2 installs Remote methods as configurable getter-only own
        // properties, so assignment is a no-op; replace the descriptor itself.
        Object.defineProperty(remoteSession, "openWorkspacePath", {
          configurable: true,
          enumerable: nativeDescriptor ? nativeDescriptor.enumerable : true,
          writable: true,
          value: patchedOpen,
        });
        cleanups.push(function () {
          if (remoteSession.openWorkspacePath === patchedOpen) {
            if (nativeDescriptor) Object.defineProperty(remoteSession, "openWorkspacePath", nativeDescriptor);
            else delete remoteSession.openWorkspacePath;
          }
          nativeOpenPath = null;
        });
      }

      try {
        onBodyReady(function () {
          if (disposed) return;
          try {
            ensureEntry();
            cleanups.push(function () {
              if (entryBtn && entryBtn.parentNode) entryBtn.parentNode.removeChild(entryBtn);
              entryBtn = null;
            });
            ensureOverlay();
            cleanups.push(function () {
              try { closeOverlay(); } catch (e) { /* ignore */ }
              if (overlay && overlay.root && overlay.root.parentNode) {
                overlay.root.parentNode.removeChild(overlay.root);
              }
              overlay = null;
              document.removeEventListener("keydown", onGlobalKey, true);
              const style = document.getElementById("dsh-fileview-style");
              if (style && style.parentNode) style.parentNode.removeChild(style);
            });
          } catch (err) {
            console.error("[dsh-fileview] UI init failed:", err);
          }
        });
      } catch (err) {
        console.error("[dsh-fileview] UI init failed:", err);
      }

      ctx.effect(function () {
        return function () {
          disposed = true;
          for (let i = 0; i < cleanups.length; i++) {
            try { cleanups[i](); } catch (e) { /* ignore */ }
          }
        };
      }, "dsh-fileview.clientLifecycle");

      console.log("[dsh-fileview] client half ready (remote pages open the in-GUI viewer)");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
