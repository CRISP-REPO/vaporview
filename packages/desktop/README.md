# VaporView Desktop (Electron shell)

Standalone desktop build of the **real** VaporView waveform viewer — it loads the
actual `dist/webview.js` canvas and drives it from the native Rust engine (no VS
Code, no WASM).

```
real webview.js canvas  (media/webview.html + style.css + codicons)
   │  acquireVsCodeApi shim + message relay   (src/preload.js)
   ▼
extension-side protocol  (src/main.js: initViewport / add-variable / fetchDataFromFile)
   │
   ▼
vaporview-desktop-native  (N-API addon)  →  filehandler engine (Rust, native)
```

## Run on Linux (test build)

Needs Node 18+ and a display. From `apps/vaporview`:

```bash
# 1. Build the native engine addon
cd packages/desktop-native && npm run build        # cargo build --release + copy → index.node

# 2. Launch the app
cd ../desktop && npm install && npm start
# or open a file directly:
npm start -- /path/to/dump.vcd
```

`File ▸ Open Waveform…` (Ctrl+O) loads a `.vcd` / `.fst` / `.ghw`. On load it
walks the netlist and auto-adds up to 64 signals so real waveforms render
immediately; the canvas controls (zoom, edge nav, search, markers) are live.

> First GUI bring-up note: this was assembled without a display to test against,
> so if the window is blank or a signal doesn't draw, the DevTools console
> (View ▸ Toggle Developer Tools) shows the webview ↔ engine message errors —
> report them and they're quick to fix.

## Package as a Linux app

```bash
npm run dist:linux        # electron-builder → AppImage + .deb in dist/
```

`extraResources` bundles `media/`, `dist/webview.js`, and codicons. Packaged-mode
asset path resolution in `main.js` (`VAPORVIEW_ROOT`) may need a tweak for the
`resources/` layout — verify after the first AppImage.

## Known gaps (vs. the VS Code extension)

- No netlist **browser sidebar** yet (signals are auto-added on open). It's the
  next addition — a tree from the `getChildren` API.
- Enum signals: the addon doesn't expose `getEnumData` yet (skipped in fetch).
- Surfer remote streaming is WASM-only (not in the native build).
