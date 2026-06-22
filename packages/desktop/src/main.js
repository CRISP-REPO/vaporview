// Electron main process — the "extension side" of the real VaporView webview.
//
// It loads the actual waveform canvas (media/webview.html + dist/webview.js +
// style.css + codicons), shims the VS Code host via preload, and speaks the same
// message protocol the extension uses (initViewport / add-variable /
// fetchDataFromFile / update-waveform-chunk) — but backed by the native engine
// addon instead of the VS Code extension host.

const { app, BrowserWindow, Menu, dialog, clipboard, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

// apps/vaporview root (assets live here): src -> desktop -> packages -> vaporview
const VAPORVIEW_ROOT = path.resolve(__dirname, "..", "..", "..");

function loadNativeAddon() {
  const candidates = [
    path.join(__dirname, "..", "..", "desktop-native"),
    path.join(process.resourcesPath || "", "desktop-native", "index.node"),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* next */ }
  }
  throw new Error("vaporview-desktop-native addon not found (build it first)");
}
const native = loadNativeAddon();

// ---- session state (single waveform, like the extension) -------------------
const state = { ready: false, loaded: false, metadata: null, uri: "", topScopes: [], topVars: [] };
let win = null;
const MAX_AUTO_SIGNALS = 64;

// ---- HTML generation: real webview.html with local asset URLs --------------
function fileUrl(...parts) {
  return pathToFileURL(path.join(VAPORVIEW_ROOT, ...parts)).href;
}

function buildIndexHtml() {
  const template = fs.readFileSync(path.join(VAPORVIEW_ROOT, "media", "webview.html"), "utf8");
  const assets = {
    codiconsUri: fileUrl("node_modules", "@vscode", "codicons", "dist", "codicon.css"),
    cssFileUri: fileUrl("media", "style.css"),
    svgIconsUri: fileUrl("src", "webview", "icons.svg"),
    jsFileUri: fileUrl("dist", "webview.js"),
  };
  let html = template.replace(/\$\{webAssets\.(\w+)\}/g, (_m, key) => assets[key] || "");
  // Inject our theme shim before the stylesheet so --vscode-* vars resolve.
  const themeLink = `<link rel="stylesheet" href="${pathToFileURL(path.join(__dirname, "theme.css")).href}">`;
  html = html.replace("</head>", `  ${themeLink}\n</head>`);
  const outPath = path.join(app.getPath("temp"), "vaporview-index.html");
  fs.writeFileSync(outPath, html);
  return outPath;
}

// ---- protocol helpers ------------------------------------------------------
function toWebview(msg) {
  win?.webContents.send("vp:toWebview", msg);
}

function buildMetadata(info) {
  return {
    timeTableLoaded: true,
    scopeCount: info.scopeCount,
    netlistIdCount: info.varCount,
    signalIdCount: info.varCount,
    timeTableCount: info.timeTableLength,
    timeEnd: info.timeEnd,
    minTimeStep: info.chunkSize || 1,
    timeScale: info.timescale,
    timeUnit: info.timeUnit,
  };
}

// Walk the netlist collecting leaf signals (depth-first, capped).
function collectSignals(scopeId, scopePath, acc) {
  if (acc.length >= MAX_AUTO_SIGNALS) return;
  let start = 0;
  let remaining = Infinity;
  let guard = 256;
  while (remaining > 0 && acc.length < MAX_AUTO_SIGNALS && guard-- > 0) {
    const j = JSON.parse(native.getChildren(scopeId, start));
    remaining = j.remainingItems;
    start += j.totalReturned;
    for (const v of j.vars || []) {
      acc.push({
        signalId: v.signalId,
        signalWidth: v.width,
        signalName: v.name,
        scopePath,
        netlistId: v.netlistId,
        type: v.type,
        encoding: (v.encoding || "").split("(")[0],
        enumType: v.enumType || "",
      });
      if (acc.length >= MAX_AUTO_SIGNALS) return;
    }
    for (const s of j.scopes || []) {
      collectSignals(s.id, scopePath.concat([s.name]), acc);
      if (acc.length >= MAX_AUTO_SIGNALS) return;
    }
    if (j.totalReturned === 0) break;
  }
}

function initAndPopulate() {
  // 1) config, then 2) init viewport (order matches the extension).
  toWebview({
    command: "setConfigSettings",
    touchpadPinchSensitivity: 18,
    rulerLines: true,
    fillMultiBitValues: false,
    multiBitFixedHeight: true,
    enableAnimations: true,
    animationDuration: 50,
    overrideDevicePixelRatio: false,
    userPixelRatio: 1,
  });
  toWebview({
    command: "initViewport",
    metadata: state.metadata,
    documentId: state.uri,
    uri: state.uri,
    colorPalette: [],
    errorColorPalette: [],
    themeValid: false,
    autoReload: false,
  });

  // 3) auto-add some signals so real waveforms render immediately.
  const signals = [];
  for (const s of state.topScopes) collectSignals(s.id, [s.name], signals);
  for (const v of state.topVars) {
    if (signals.length >= MAX_AUTO_SIGNALS) break;
    signals.push({
      signalId: v.signalId, signalWidth: v.width, signalName: v.name, scopePath: [],
      netlistId: v.netlistId, type: v.varType, encoding: (v.encoding || "").split("(")[0], enumType: v.enumType || "",
    });
  }
  if (signals.length > 0) {
    toWebview({ command: "add-variable", signalList: signals, groupPath: [], index: undefined });
  }
  console.log(`[vaporview] init: ${signals.length} signals added`);
}

function openFile(filePath) {
  try {
    const info = native.loadWaveform(filePath);
    state.metadata = buildMetadata(info);
    state.uri = pathToFileURL(filePath).href;
    state.topScopes = info.scopes;
    state.topVars = info.vars;
    state.loaded = true;
    win.setTitle(`VaporView — ${path.basename(filePath)}`);
    console.log(`[vaporview] loaded ${filePath}: scopes=${info.scopeCount} vars=${info.varCount} timeEnd=${info.timeEnd}`);
    if (state.ready) initAndPopulate();
  } catch (e) {
    dialog.showErrorBox("Failed to load waveform", String(e));
  }
}

async function openFileDialog() {
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Waveforms", extensions: ["vcd", "fst", "ghw"] }],
  });
  if (!res.canceled && res.filePaths[0]) openFile(res.filePaths[0]);
}

// ---- messages from the webview --------------------------------------------
function handleFromWebview(message) {
  switch (message.command) {
    case "ready": {
      state.ready = true;
      if (state.loaded) initAndPopulate();
      break;
    }
    case "fetchDataFromFile": {
      const signalIds = [];
      for (const req of message.requestList || []) {
        if (req.type === "signal") signalIds.push(req.signalId);
        // enum requests not yet supported by the addon
      }
      if (signalIds.length === 0) break;
      const sd = native.getSignalData(signalIds);
      for (const t of sd.transitions) {
        toWebview({
          command: "update-waveform-chunk",
          signalId: t.signalId, transitionDataChunk: t.data,
          totalChunks: t.totalChunks, chunkNum: t.chunkNum, min: t.min, max: t.max,
        });
      }
      for (const c of sd.compressed) {
        toWebview({
          command: "update-waveform-chunk-compressed",
          signalId: c.signalId, signalWidth: c.signalWidth,
          compressedDataChunk: Array.from(c.data),
          totalChunks: c.totalChunks, chunkNum: c.chunkNum, min: c.min, max: c.max,
          originalSize: c.originalSize,
        });
      }
      break;
    }
    case "logOutput":     console.log("[webview]", message.message); break;
    case "copyToClipboard": clipboard.writeText(message.text || ""); break;
    case "showMessage":   console.log("[webview message]", message.message); break;
    // contextUpdate / restoreState / emitEvent / executeCommand / updateConfiguration: no-op for the viewer
    default: break;
  }
}

// ---- app lifecycle ---------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(buildIndexHtml());

  const fileArg = process.argv.find((a) => /\.(vcd|fst|ghw)$/i.test(a));
  if (fileArg && fs.existsSync(fileArg)) openFile(path.resolve(fileArg));
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Open Waveform…", accelerator: "CmdOrCtrl+O", click: openFileDialog },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "viewMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  ipcMain.on("vp:toExt", (_e, message) => handleFromWebview(message));
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  native.unload?.();
  if (process.platform !== "darwin") app.quit();
});
