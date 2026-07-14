import * as vscode from 'vscode';
import * as fs from 'fs';

import type { VaporviewDocument } from './document';

// Editor-pane Netlist Explorer.
//
// Replaces the old sidebar Netlist TreeView. VS Code cannot host a TreeView in
// the editor area, so this renders the design scope tree in a WebviewPanel opened
// in a split BESIDE the waveform. Signals are added by double-click, by
// multi-select + Add, or by dragging with a CUSTOM MIME (`application/x-vaporview-netlist`)
// which — unlike the tree's resourceUri/`codeeditors` drag — does NOT require the
// user to hold Shift.
//
// The tree data reuses `document.getScopeChildrenSerialized(scopePath)` (lazy, fsdb-safe)
// and adding reuses `document.renderSignals(...)`.

const CONTEXT_KEY = 'vaporview.netlistExplorerOpen';

export class NetlistExplorerPanel {
  private panel: vscode.WebviewPanel | undefined;
  private activeDocument: VaporviewDocument | undefined;
  // URI of the document currently loaded in the webview tree. Used to avoid
  // reloading (and collapsing) the tree when the same document reactivates.
  private currentUri: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {}

  // ─── Public API used by WaveformViewerProvider ───

  /** Point the explorer at a waveform document; open beside it if it isn't already open. */
  setActiveDocument(document: VaporviewDocument) {
    const changed = document.uri.toString() !== this.currentUri;
    this.activeDocument = document;
    if (!this.panel) {
      this.createOrShow();
      return; // 'ready' from the fresh webview will pull the document
    }
    // Only reload the tree when the document actually changes. Reloading on every
    // re-activation would wipe the user's expanded scopes — e.g. adding a signal
    // (renderSignals → updateViews → setActiveDocument) must NOT collapse the tree.
    if (changed) {
      this.postDocument();
    }
  }

  /** Detach from the current document (waveform hidden). */
  clear() {
    this.activeDocument = undefined;
    this.currentUri = undefined;
    this.panel?.webview.postMessage({ command: 'clearDocument' });
  }

  /** Open the explorer beside the waveform (or focus it if already open). */
  createOrShow() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vaporview.netlistExplorer',
      'Signal Explorer',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      },
    );
    this.panel = panel;
    panel.webview.html = this.getExplorerHtmlContent(panel.webview);

    panel.webview.onDidReceiveMessage((e) => this.onMessage(e), undefined, this.context.subscriptions);
    panel.onDidDispose(() => {
      this.panel = undefined;
      vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    }, undefined, this.context.subscriptions);

    vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
  }

  /** Toggle for the title-bar button: open beside if closed, close if open. */
  toggle() {
    if (this.panel) {
      this.panel.dispose();
    } else {
      this.createOrShow();
    }
  }

  /** Reveal (expand ancestors + scroll to) a signal by netlistId. */
  reveal(netlistId: number | undefined | null) {
    if (netlistId === undefined || netlistId === null) { return; }
    this.createOrShow();
    const item = this.activeDocument?.netlistIdTable[netlistId];
    if (!item) { return; }
    this.panel?.webview.postMessage({ command: 'revealPath', instancePath: item.instancePath() });
  }

  // ─── Webview message handling ───

  private async onMessage(e: { command?: string; scopePath?: string; items?: Array<{ netlistId?: number; instancePath?: string }>; query?: string; message?: string }) {
    switch (e?.command) {
      case 'ready': {
        this.postDocument();
        break;
      }
      case 'getScopeChildren': {
        const children = this.activeDocument ? await this.activeDocument.getScopeChildrenSerialized(e.scopePath) : [];
        this.panel?.webview.postMessage({ command: 'scopeChildren', scopePath: e.scopePath ?? null, children });
        break;
      }
      case 'addSignals': {
        const items = Array.isArray(e.items) ? e.items : [];
        const ids: number[] = [];
        for (const it of items) {
          if (it.netlistId !== undefined && it.netlistId !== null) {
            ids.push(it.netlistId);
          } else if (it.instancePath && this.activeDocument) {
            // Search results carry only an instancePath — resolve it to a netlistId.
            const node = await this.activeDocument.findTreeItem(it.instancePath, undefined, undefined);
            if (node && node.netlistId !== undefined && node.netlistId !== null) { ids.push(node.netlistId); }
          }
        }
        if (ids.length > 0 && this.activeDocument) {
          // One render call preserves the user's selection order.
          await this.activeDocument.renderSignals(ids, [], undefined);
        }
        break;
      }
      case 'search': {
        const query = (e.query ?? '').trim();
        let results: any[] = [];
        if (query && this.activeDocument) {
          try {
            const res = await this.activeDocument.searchNetlist(query);
            results = (res.searchResults || []).filter((r) => r.isVar).slice(0, 1000);
          } catch (err) {
            this.log.appendLine('[NetlistExplorer] search failed: ' + String(err));
          }
        }
        this.panel?.webview.postMessage({ command: 'searchResults', query, results });
        break;
      }
      case 'logOutput': {
        this.log.appendLine('[NetlistExplorer] ' + e.message);
        break;
      }
      default: break;
    }
  }

  private postDocument() {
    if (!this.panel) { return; }
    if (this.activeDocument) {
      this.currentUri = this.activeDocument.uri.toString();
      this.panel.webview.postMessage({ command: 'setDocument', metadata: this.activeDocument.getMetadataInfo() });
    } else {
      this.currentUri = undefined;
      this.panel.webview.postMessage({ command: 'clearDocument' });
    }
  }

  private getExplorerHtmlContent(webview: vscode.Webview): string {
    const extensionUri = this.context.extensionUri;
    const htmlFile    = vscode.Uri.joinPath(extensionUri, 'media', 'netlist_explorer.html');
    const svgIconsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'icons.svg'));
    const jsFileUri   = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'netlist_explorer.js'));
    const cssFileUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));

    let htmlContent = fs.readFileSync(htmlFile.fsPath, 'utf8');
    htmlContent = htmlContent.replace('${webAssets.svgIconsUri}', svgIconsUri.toString());
    htmlContent = htmlContent.replace('${webAssets.jsFileUri}', jsFileUri.toString());
    htmlContent = htmlContent.replace('${webAssets.cssFileUri}', cssFileUri.toString());
    htmlContent = htmlContent.replace('${webAssets.codiconsUri}', codiconsUri.toString());
    return htmlContent;
  }
}
