// Preload: shims the VS Code webview API the real `webview.js` expects, and
// relays its postMessage traffic to/from the Electron main process (which holds
// the native engine). contextIsolation is off for this local test app so the
// preload shares the page's window — `acquireVsCodeApi()` must be a real global
// the bundled webview can call.
const { ipcRenderer } = require("electron");

let savedState = {};

window.acquireVsCodeApi = function acquireVsCodeApi() {
  return {
    postMessage: (message) => ipcRenderer.send("vp:toExt", message),
    setState: (newState) => {
      savedState = newState;
    },
    getState: () => savedState,
  };
};

// Messages from the "extension side" (main) → deliver as a window 'message'
// event, exactly like VS Code's webview host does.
ipcRenderer.on("vp:toWebview", (_event, message) => {
  window.postMessage(message, "*");
});
