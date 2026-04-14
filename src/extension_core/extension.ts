// Description: This file contains the extension logic for the VaporView extension
import * as vscode from 'vscode';

import { TimestampLinkProvider, NetlistLinkProvider } from './terminal_links';
import { registerVaporviewCommands } from './commands';
import { WaveformViewerProvider, VaporviewDocumentCollection } from './viewer_provider';
import { updateWCPServerFromConfiguration, WCPServer } from './wcp_server';
import type {
  VaporviewApi,
  OpenFileArgs,
  VariableActionArgs,
  SetMarkerArgs,
  GetViewerStateArgs,
  GetValuesAtTimeArgs,
  AddVariableByPathArgs,
} from '../../packages/vaporview-api/types';

// #region activate()
export async function activate(context: vscode.ExtensionContext): Promise<VaporviewApi> {

  const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
  const _dfsdb = process.env.CRISP_DEV_DEBUG_FSDB === '1';

  // Load the Wasm module
  if (_dwf) { console.log('[WF:activate] loading WASM module...'); }
  let wasmModule: WebAssembly.Module;
  try {
    const binaryFile = vscode.Uri.joinPath(context.extensionUri, 'target', 'wasm32-unknown-unknown', 'release', 'filehandler.wasm');
    if (_dwf) { console.log('[WF:activate] WASM path: ' + binaryFile.toString()); }
    const binaryData = await vscode.workspace.fs.readFile(binaryFile);
    if (_dwf) { console.log('[WF:activate] WASM binary read, size=' + binaryData.byteLength); }
    wasmModule = await WebAssembly.compile(new Uint8Array(binaryData));
    if (_dwf) { console.log('[WF:activate] WASM compiled successfully'); }
  } catch (err: any) {
    console.error('[WF:activate] WASM load/compile FAILED:', err?.message ?? err);
    throw err;
  }

  // create an output channel for logging
  const outputLog = vscode.window.createOutputChannel('Vaporview', { log: true });
  context.subscriptions.push(outputLog);

  // Register Custom Editor Provider (The viewer window)
  // See package.json for more details
  if (_dwf) { console.log('[WF:activate] creating WaveformViewerProvider...'); }
  const documentCollection = new VaporviewDocumentCollection(outputLog);
  const viewerProvider     = new WaveformViewerProvider(context, outputLog, wasmModule, documentCollection);
  if (_dwf) { console.log('[WF:activate] WaveformViewerProvider created'); }

  vscode.window.registerCustomEditorProvider(
    'vaporview.waveformViewer',
    viewerProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    }
  );

  // Initialize WCP Server
  let wcpServer: WCPServer | null = null;
  updateWCPServerFromConfiguration(wcpServer, viewerProvider, context);

  // Store wcpServer reference for cleanup
  context.subscriptions.push({
    dispose: () => {
      if (wcpServer) {
        wcpServer.stop();
        wcpServer = null;
      }
    }
  });

  // Listen for configuration changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('vaporview.wcp.enabled') || e.affectsConfiguration('vaporview.wcp.port')) {
      updateWCPServerFromConfiguration(wcpServer, viewerProvider, context);
    }

    if (e.affectsConfiguration('workbench.colorTheme')) {
      documentCollection.getTokenColorsForTheme();
    }

    // TODO: Check if configuration changes affect vaporview
    documentCollection.updateConfiguration(e);
  }));

  vscode.window.registerTerminalLinkProvider(new TimestampLinkProvider(viewerProvider));

  //vscode.workspace.onDidChangeConfiguration((e) => {viewerProvider.updateConfiguration(e);});
  const markerSetEvent = WaveformViewerProvider.markerSetEventEmitter.event;
  const signalSelectEvent = WaveformViewerProvider.signalSelectEventEmitter.event;
  const addVariableEvent = WaveformViewerProvider.addVariableEventEmitter.event;
  const removeVariableEvent = WaveformViewerProvider.removeVariableEventEmitter.event;
  const externalDropEvent = WaveformViewerProvider.externalDropEventEmitter.event;

  // Register commands (there are a lot of commands, so we register them in a separate file for cleanliness)
  registerVaporviewCommands(context, outputLog, viewerProvider, documentCollection, wcpServer);

  outputLog.appendLine('Vaporview Activated');

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getMetadata', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getMetadata' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e?.uri);
    if (!document) {
      if (_dfsdb) { console.log('[FSDB:cmd] getMetadata: no document found'); }
      return null;
    }
    const result = document.getMetadataInfo();
    if (_dfsdb) { console.log('[FSDB:cmd] getMetadata result:', JSON.stringify(result)); }
    return result;
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getScopeChildren', async (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getScopeChildren' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e?.uri);
    if (!document) {
      if (_dfsdb) { console.log('[FSDB:cmd] getScopeChildren: no document found'); }
      return null;
    }
    if (_dfsdb) { console.log('[FSDB:cmd] getScopeChildren scopePath=' + (e?.scopePath || '(root)')); }
    const result = await document.getScopeChildrenSerialized(e?.scopePath);
    if (_dfsdb) { console.log('[FSDB:cmd] getScopeChildren returned ' + result.length + ' children'); }
    return result;
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getValueChanges', async (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getValueChanges' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e?.uri);
    if (!document) {
      if (_dfsdb) { console.log('[FSDB:cmd] getValueChanges: no document found'); }
      return null;
    }
    if (_dfsdb) { console.log('[FSDB:cmd] getValueChanges instancePath=' + e.instancePath); }
    const result = await document.getValueChangesForPath(e.instancePath);
    if (_dfsdb) { console.log('[FSDB:cmd] getValueChanges returned ' + (result ? `${result.valueChanges?.length ?? 0} transitions` : 'null')); }
    return result;
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.setViewWindow', async (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.setViewWindow' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e?.uri);
    if (!document) { return null; }
    await document.setViewWindow(e.startTime, e.endTime);
    return { success: true };
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getVarInfo', async (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getVarInfo' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e?.uri);
    if (!document) { return null; }
    return document.getVarInfo(e.signalId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.searchNetlistCommand', async (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.searchNetlistCommand' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e?.uri);
    if (!document) {
      if (_dfsdb) { console.log('[FSDB:cmd] searchNetlistCommand: no document found'); }
      return null;
    }
    if (_dfsdb) { console.log('[FSDB:cmd] searchNetlistCommand query="' + e.query + '"'); }
    const result = await document.searchNetlist(e.query);
    if (_dfsdb) { console.log('[FSDB:cmd] searchNetlistCommand returned ' + result.totalResults + ' results'); }
    return result;
  }));
  // #region Open Source
  // Simple cache to avoid repeating heavy resolution for the same instancePath
  let lastOpenCache: { instancePath: string; uri: vscode.Uri; range: vscode.Range } | null = null;
  // Scope-level cache: remember the module file for the last resolved instance hierarchy (scopePath)
  let lastScopeCache: { scopePath: string; moduleUri: vscode.Uri } | null = null;

  // Open source for a given instance path (scope-aware resolution)
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openSource', async (e) => {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Opening source...', cancellable: false }, async (progress) => {
      // Accept instancePath directly (from dblclick) or derive from webview context (right-click menu)
      let instancePath: string | undefined = e?.instancePath;
      if (!instancePath && e?.scopePath && e?.signalName) {
        instancePath = e.scopePath ? `${e.scopePath}.${e.signalName}` : e.signalName;
      }
      if (!instancePath || instancePath.trim() === '') { return; }

      // Normalize the key we use for caching (collapse repeated dots and trim edges)
      const normalizedKey = instancePath.replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');

      // Fast-path: cache hit by normalized instancePath
      if (lastOpenCache && lastOpenCache.instancePath === normalizedKey) {
        const existing = findOpenTabForUri(lastOpenCache.uri);
        if (existing) {
          await focusTabGroup(existing.group);
          const doc = await vscode.workspace.openTextDocument(lastOpenCache.uri);
          const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: existing.group.viewColumn });
          ed.selection = new vscode.Selection(lastOpenCache.range.start, lastOpenCache.range.end);
          ed.revealRange(lastOpenCache.range, vscode.TextEditorRevealType.InCenter);
        } else {
          const doc = await vscode.workspace.openTextDocument(lastOpenCache.uri);
          const sideColumn = await getOrCreateSideGroupColumn();
          const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: sideColumn ?? vscode.ViewColumn.Beside });
          ed.selection = new vscode.Selection(lastOpenCache.range.start, lastOpenCache.range.end);
          ed.revealRange(lastOpenCache.range, vscode.TextEditorRevealType.InCenter);
        }
        return;
      }

      progress.report({ message: 'Resolving scope...', increment: 10 });

      // Parse scope and leaf signal from instancePath
      const normalized = normalizedKey;
      const parts = normalized.split('.').filter(Boolean);
      const leaf = parts.pop() || normalized; // signal name
      const scopePath = parts.join('.');      // hierarchical instance path without leaf

      // If previous open had the same scope, reuse its document
      if (lastOpenCache && scopePath) {
        const prevParts = (lastOpenCache.instancePath || '').split('.').filter(Boolean);
        prevParts.pop();
        const prevScope = prevParts.join('.');
        const sameScope = prevScope === scopePath;
        if (sameScope) {
          const leafLoc = await findFirstTextMatchInFile(leaf, lastOpenCache.uri);
          if (leafLoc) {
            lastOpenCache = { instancePath: normalizedKey, uri: leafLoc.uri, range: leafLoc.range };
            const doc = await vscode.workspace.openTextDocument(leafLoc.uri);
            const sideColumn = await getOrCreateSideGroupColumn();
            const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: sideColumn ?? vscode.ViewColumn.Beside });
            ed.selection = new vscode.Selection(leafLoc.range.start, leafLoc.range.end);
            ed.revealRange(leafLoc.range, vscode.TextEditorRevealType.InCenter);
            return;
          }
        }
      }

      // Try to resolve the module file for the most specific scope first, then walk up
      const includeGlobs = '**/*.{sv,svh,v,vh,verilog,svt,vhdl,vhd}';
      let resolved: { uri: vscode.Uri, range: vscode.Range } | null = null;
      let moduleUri: vscode.Uri | null = null;

      const tryResolveModuleForInstance = async (instName: string): Promise<vscode.Uri | null> => {
        const instRegex = new RegExp(`\\b([A-Za-z_][\\w$]*)\\s*(?:#\\s*\\([\\s\\S]*?\\))?\\s+${escapeRegExp(instName)}\\s*\\(`, 'm');
        const files = await vscode.workspace.findFiles(includeGlobs, '{**/node_modules/**,**/dist/**,**/out/**}', 1500);
        for (const uri of files) {
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText();
            const m = instRegex.exec(text);
            if (m && m[1]) {
              const moduleName = m[1];
              const modDecl = await findModuleDeclaration(moduleName, includeGlobs);
              if (modDecl) { return modDecl.uri; }
            }
          } catch {/* ignore file errors */}
        }
        return null;
      };

      // If scope matches the last resolved scope, reuse its module file
      if (lastScopeCache && scopePath && lastScopeCache.scopePath === scopePath) {
        moduleUri = lastScopeCache.moduleUri;
      }

      // Try resolve using most specific instance first
      for (let i = parts.length - 1; i >= 0 && !moduleUri; i--) {
        const inst = parts[i];
        progress.report({ message: `Resolving instance '${inst}'...`, increment: 10 });
        moduleUri = await tryResolveModuleForInstance(inst);
      }

      // Fallback: basename heuristic
      if (!moduleUri) {
        for (let i = parts.length - 1; i >= 0 && !moduleUri; i--) {
          const assumedModuleName = parts[i];
          progress.report({ message: `Searching module '${assumedModuleName}'...`, increment: 10 });
          const decl = await findModuleDeclaration(assumedModuleName, includeGlobs);
          if (decl) { moduleUri = decl.uri; }
        }
      }

      // Search leaf in module file, or global fallback
      if (moduleUri) {
        if (scopePath) { lastScopeCache = { scopePath, moduleUri }; }
        const leafLoc = await findFirstTextMatchInFile(leaf, moduleUri);
        if (leafLoc) {
          resolved = leafLoc;
        } else {
          const modDecl = await findModuleDeclarationInFile(moduleUri);
          if (modDecl) { resolved = modDecl; }
        }
      }

      if (!resolved) {
        const locations = await findFirstTextMatchSimple(leaf, includeGlobs);
        if (locations) { resolved = locations; }
      }

      if (!resolved) {
        vscode.window.showInformationMessage(`Could not find source for ${leaf}`);
        return;
      }

      const { uri, range } = resolved;
      const doc = await vscode.workspace.openTextDocument(uri);
      lastOpenCache = { instancePath: normalizedKey, uri, range };

      // Open in side group
      const existing = findOpenTabForUri(uri);
      if (existing) {
        await focusTabGroup(existing.group);
        const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: existing.group.viewColumn });
        ed.selection = new vscode.Selection(range.start, range.end);
        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
      } else {
        const sideColumn = await getOrCreateSideGroupColumn();
        const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: sideColumn ?? vscode.ViewColumn.Beside });
        ed.selection = new vscode.Selection(range.start, range.end);
        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
      });
    } catch (err) {
      console.error(err);
    }
  }));

  const api: VaporviewApi = {
    // Events
    onDidSetMarker: markerSetEvent,
    onDidSelectSignal: signalSelectEvent,
    onDidAddVariable: addVariableEvent,
    onDidRemoveVariable: removeVariableEvent,
    onDidDropInWaveformViewer: externalDropEvent,

    // Commands
    async openFile(args: OpenFileArgs) {
      if (!args.uri) {return;}
      await vscode.commands.executeCommand('vscode.openWith', args.uri, 'vaporview.waveformViewer');
      if (args.loadAll) {viewerProvider.loadAllVariablesFromFile(args.uri.toString(), args.maxSignals || 64);}
    },
    async addVariable(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "add");
    },
    async removeVariable(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "remove");
    },
    async revealInNetlistView(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "reveal");
    },
    async addSignalValueLink(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "addLink");
    },
    setMarker(args: SetMarkerArgs) {
      viewerProvider.markerCommandHandler(args);
    },
    async getOpenDocuments() {
      return viewerProvider.getAllDocumentUris();
    },
    async getViewerState(args?: GetViewerStateArgs) {
      const document = viewerProvider.getDocumentFromOptionalUri(args?.uri);
      if (!document) {return undefined;}
      return document.getSettings();
    },
    async getValuesAtTime(args: GetValuesAtTimeArgs) {
      const document = viewerProvider.getDocumentFromOptionalUri(args.uri);
      if (!document) {return [];}
      return document.getValuesAtTime(args);
    },
    async addVariableByInstancePath(args: AddVariableByPathArgs) {
      viewerProvider.addVariableByInstancePathToDocument(args);
    },
  };
  return api;
}

export default WaveformViewerProvider;

export function deactivate() {
  // WCP server cleanup is handled by context subscriptions
  // All resources registered with context.subscriptions are automatically disposed
}

// #region openSource helper functions

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findOpenTabForUri(uri: vscode.Uri): { group: vscode.TabGroup; tab: vscode.Tab } | undefined {
  const groups = vscode.window.tabGroups?.all ?? [];
  for (const group of groups) {
    for (const tab of group.tabs) {
      const input: any = (tab as any).input;
      if (input instanceof (vscode as any).TabInputText) {
        if (sameResource(input.uri, uri)) {
          return { group, tab };
        }
      } else if (input && input.uri && typeof input.uri.toString === 'function') {
        if (sameResource(input.uri, uri)) {
          return { group, tab };
        }
      }
    }
  }
  return undefined;
}

async function focusTabGroup(target: vscode.TabGroup): Promise<void> {
  const groups = vscode.window.tabGroups?.all ?? [];
  if (groups.length === 0) { return; }
  const targetIndex = groups.findIndex(g => g.viewColumn === target.viewColumn);
  if (targetIndex < 0) { return; }
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  const activeIndex = groups.findIndex(g => g.viewColumn === activeGroup.viewColumn);
  if (activeIndex === -1 || activeIndex === targetIndex) { return; }
  const step = targetIndex > activeIndex ? 1 : -1;
  const moves = Math.abs(targetIndex - activeIndex);
  for (let i = 0; i < moves; i++) {
    if (step > 0) {
      await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    } else {
      await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
    }
  }
}

async function getOrCreateSideGroupColumn(): Promise<vscode.ViewColumn | undefined> {
  try {
    const crispCfg = vscode.workspace.getConfiguration('crisp');
    const vaporCfg = vscode.workspace.getConfiguration('vaporview');
    const targetGroupCfg = crispCfg.get<number>('openSource.targetGroup', vaporCfg.get<number>('openSource.targetGroup', 0));
    const splitDirection = crispCfg.get<'left' | 'right' | 'beside'>('openSource.splitDirection', vaporCfg.get<'left' | 'right' | 'beside'>('openSource.splitDirection', 'left'));
    const groups = vscode.window.tabGroups?.all ?? [];
    const active = vscode.window.tabGroups?.activeTabGroup;
    if (typeof targetGroupCfg === 'number' && targetGroupCfg >= 1) {
      const target = groups.find(g => g.viewColumn === targetGroupCfg);
      if (target) { return target.viewColumn; }
      if (targetGroupCfg > (active?.viewColumn ?? 1)) {
        await vscode.commands.executeCommand('workbench.action.newGroupRight');
        const after = vscode.window.tabGroups?.all ?? [];
        const created = after.find(g => g.viewColumn === targetGroupCfg) || after.find(g => g.viewColumn !== active?.viewColumn);
        if (created) { return created.viewColumn; }
      }
      return undefined;
    }
    if (groups.length >= 2) {
      if (splitDirection === 'left') {
        const left = groups.find(g => g.viewColumn === vscode.ViewColumn.One && g.viewColumn !== active?.viewColumn);
        if (left) { return left.viewColumn; }
        const other = groups.find(g => g.viewColumn !== active?.viewColumn);
        return other?.viewColumn;
      } else if (splitDirection === 'right') {
        const right = groups.find(g => g.viewColumn && g.viewColumn !== vscode.ViewColumn.One && g.viewColumn !== active?.viewColumn);
        if (right) { return right.viewColumn; }
        const other = groups.find(g => g.viewColumn !== active?.viewColumn);
        return other?.viewColumn;
      } else {
        return undefined;
      }
    }
    if (splitDirection === 'left') {
      try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
        return vscode.ViewColumn.One;
      } catch (moveErr) {
        console.warn('moveEditorToRightGroup failed, attempting splitEditorRight then focus left:', moveErr);
      }
      try {
        await vscode.commands.executeCommand('workbench.action.splitEditorRight');
        await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
        const newActive = vscode.window.tabGroups?.activeTabGroup;
        return newActive?.viewColumn;
      } catch (splitErr) {
        console.warn('splitEditorRight failed, falling back to Beside:', splitErr);
      }
    } else if (splitDirection === 'right') {
      try {
        await vscode.commands.executeCommand('workbench.action.splitEditorRight');
        const newActive = vscode.window.tabGroups?.activeTabGroup;
        return newActive?.viewColumn;
      } catch (splitErr) {
        console.warn('splitEditorRight failed, falling back to Beside:', splitErr);
      }
    } else {
      return undefined;
    }
    return undefined;
  } catch (e) {
    console.warn('getOrCreateSideGroupColumn failed, falling back to Beside:', e);
    return undefined;
  }
}

async function findFirstTextMatchSimple(symbol: string, includeGlob: string): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const files = await vscode.workspace.findFiles(includeGlob, '{**/node_modules/**,**/dist/**,**/out/**}', 1000);
    const wordPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const match = wordPattern.exec(text);
        if (match) {
          const start = doc.positionAt(match.index);
          const end   = doc.positionAt(match.index + match[0].length);
          return { uri, range: new vscode.Range(start, end) };
        }
      } catch { /* ignore file errors */ }
    }
  } catch { /* ignore errors */ }
  return null;
}

async function findModuleDeclaration(moduleName: string, includeGlob: string): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const files = await vscode.workspace.findFiles(includeGlob, '{**/node_modules/**,**/dist/**,**/out/**}', 1500);
    const declPattern = new RegExp(`\\b(module|interface|package)\\s+${escapeRegExp(moduleName)}\\b`);
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const m = declPattern.exec(text);
        if (m) {
          const start = doc.positionAt(m.index);
          const end = doc.positionAt(m.index + m[0].length);
          return { uri, range: new vscode.Range(start, end) };
        }
      } catch { /* ignore file errors */ }
    }
  } catch { /* ignore errors */ }
  return null;
}

async function findModuleDeclarationInFile(uri: vscode.Uri): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const declPattern = /\b(module|interface|package)\s+([A-Za-z_][\w$]*)\b/;
    const m = declPattern.exec(text);
    if (m) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      return { uri, range: new vscode.Range(start, end) };
    }
  } catch { /* ignore */ }
  return null;
}

async function findFirstTextMatchInFile(symbol: string, uri: vscode.Uri): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const m = pattern.exec(text);
    if (m) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      return { uri, range: new vscode.Range(start, end) };
    }
  } catch { /* ignore */ }
  return null;
}

function sameResource(a: vscode.Uri | undefined, b: vscode.Uri | undefined): boolean {
  if (!a || !b) { return false; }
  if (a.scheme !== b.scheme) { return false; }
  if (a.scheme === 'file') {
    const norm = (u: vscode.Uri) => u.fsPath.replace(/\\/g, '/');
    return norm(a) === norm(b);
  }
  return a.toString() === b.toString();
}
