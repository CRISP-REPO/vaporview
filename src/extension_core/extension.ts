// Description: This file contains the extension logic for the VaporView extension
import * as vscode from 'vscode';

import { TimestampLinkProvider, NetlistLinkProvider } from './terminal_links';
import { WaveformViewerProvider } from './viewer_provider';
import { updateWCPServerFromConfiguration, WCPServer, wcpDefaultPort } from './wcp_server';
import * as path from 'path';
import * as fs from 'fs';
import { SignalGroupContextMenuEvent } from '../common/types';

// #region activate()
export async function activate(context: vscode.ExtensionContext) {

  const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';

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

  // Register Custom Editor Provider (The viewer window)
  // See package.json for more details
  if (_dwf) { console.log('[WF:activate] creating WaveformViewerProvider...'); }
  const viewerProvider = new WaveformViewerProvider(context, wasmModule);
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

    // TODO: Check if configuration changes affect vaporview
    viewerProvider.updateConfiguration(e);
  }));

  vscode.window.registerTerminalLinkProvider(new TimestampLinkProvider(viewerProvider));

  // I want to get semantic tokens for the current theme
  // The API is not available yet, so I'm just going to log the theme
  vscode.window.onDidChangeActiveColorTheme((e) => {viewerProvider.updateColorTheme(e);});
  //vscode.workspace.onDidChangeConfiguration((e) => {viewerProvider.updateConfiguration(e);});

  const markerSetEvent = WaveformViewerProvider.markerSetEventEmitter.event;
  const signalSelectEvent = WaveformViewerProvider.signalSelectEventEmitter.event;
  const addVariableEvent = WaveformViewerProvider.addVariableEventEmitter.event;
  const removeVariableEvent = WaveformViewerProvider.removeVariableEventEmitter.event;
  const externalDropEvent = WaveformViewerProvider.externalDropEventEmitter.event;

  // #region External Commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openFile', async (e) => {
    viewerProvider.log.appendLine("Command called: 'vaporview.openFile ' + " + e.uri.toString());
    if (!e.uri) {return;}
    await vscode.commands.executeCommand('vscode.openWith', e.uri, 'vaporview.waveformViewer');
    if (e.loadAll) {viewerProvider.loadAllVariablesFromFile(e.uri.toString(), e.maxSignals || 64);}
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.addVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "add");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.removeVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.removeVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "remove");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.revealInNetlistView', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.revealInNetlistView' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "reveal");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addSignalValueLink', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.addSignalValueLink' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "addLink");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.setMarker', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.setMarker' " + JSON.stringify(e));
    viewerProvider.markerCommandHandler(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getOpenDocuments', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getOpenDocuments' " + JSON.stringify(e));
    return viewerProvider.getAllDocumentUris();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getViewerState', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getViewerState' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getSettings();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getValuesAtTime', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getValuesAtTime' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getValuesAtTime(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.vaporView');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.clickNetlistItem', (e) => {
    viewerProvider.netlistTreeDataProvider.clickNetlistItem(e.uri, e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.searchNetlist', () => {
    viewerProvider.searchNetlist();
  }));

  // Add or remove signal commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariableByInstancePath', (e) => {
    viewerProvider.addVariableByInstancePathToDocument(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariable', async (e) => {
    viewerProvider.filterAddSignalsInNetlist([e], true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSignal', (e) => {
    if (e && e.rowId !== undefined) {
      viewerProvider.removeSignalFromDocument(undefined, e.rowId, true);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSignalGroup', (e) => {
    if (e) {viewerProvider.newSignalGroup(e.name, e.groupPath, e.parentGroupId, e.rowId, false);}
    else {viewerProvider.newSignalGroup(undefined, undefined, undefined, undefined, false);}
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newGroupFromSelection', (e) => {
    viewerProvider.newSignalGroup(e?.name, e?.groupPath, e?.parentGroupId, e?.rowId, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.ungroupSignals', (e: SignalGroupContextMenuEvent) => {
    viewerProvider.deleteSignalGroup(e, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.deleteGroup', (e: SignalGroupContextMenuEvent) => {
    viewerProvider.deleteSignalGroup(e, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSeparator', (e) => {
    viewerProvider.newSeparator(e.name, e.groupPath, e.parentGroupId, e.rowId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSeparator', (e) => {
    viewerProvider.removeSeparator(e.rowId, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSignalFromBitRange', (e) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the bit range (e.g. 7:0 for bits 0 to 7, or 7 for a single bit)',
      value: '0'
    }).then((bitRangeString) => {
      if (!bitRangeString) {return;}
      viewerProvider.newSignalFromBitRange(e.name, e.groupPath, e.parentGroupId, e.rowId, bitRangeString);
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllBits', (e) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 1);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllNibbles', (e) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 4);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllBytes', (e) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 8);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllWords', (e) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 16);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllDoubleWords', (e) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 32);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllQuadWords', (e) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 64);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllCustomLength', (e) => {
    // Show input box for custom length
    vscode.window.showInputBox({prompt: 'Enter the custom length in bits', value: '1'
    }).then((customLength) => {
      if (!customLength) {return;}
      const length = parseInt(customLength);
      if (isNaN(length) || length <= 0) {
        vscode.window.showErrorMessage('Invalid custom length. Please enter a positive integer.');
        return;
      }
      viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, length);
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renameSignalGroup', (e) => {
    viewerProvider.renameSignalGroup(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addSelected', (e) => {
    viewerProvider.filterAddSignalsInNetlist(viewerProvider.netlistTreeDataProvider.selectedSignals, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeShallow', (e) => {
    viewerProvider.addAllInScopeToDocument(e, false, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeRecursive', (e) => {
    viewerProvider.addAllInScopeToDocument(e, true, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedNetlist', (e) => {
    viewerProvider.removeSignalList(viewerProvider.netlistTreeDataProvider.selectedSignals);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeAllInScope', (e) => {
    if (e.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    viewerProvider.removeSignalList(e.children);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInNetlistView', (e) => {
      viewerProvider.showInNetlistView(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInViewer', (e) => {
    viewerProvider.revealSignalInWebview(e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyName', (e) => {
    let result = "";
    if (e.scopePath !== "") {result += e.scopePath + ".";}
    if (e.name) {result += e.name;}
    if (e.signalName) {result += e.signalName;}
    vscode.env.clipboard.writeText(result);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyValueAtMarker', (e) => {
    viewerProvider.copyValueAtMarker(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.saveViewerSettings', async (e) => {
    const document = viewerProvider.getDocumentFromId(e.documentId);
    if (!document) {return;}
    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);
    const saveFileName = fileName.replace(/\.[^/.]+$/, '') + '.json' || 'untitled.json';
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Save settings',
      filters: {JSON: ['json']},
      defaultUri: vscode.Uri.file(path.join(filePath, saveFileName)),
    });
    if (uri) {
      viewerProvider.saveSettingsToFile(document, uri);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.loadViewerSettings', (e) => {
    viewerProvider.loadSettingsFromFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.reloadFile', (e) => {
    viewerProvider.reloadFile(e);
  }));

  // #region Keybindings
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.nextEdge', (e) => {
    viewerProvider.handleKeyBinding(e, "nextEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.previousEdge', (e) => {
    viewerProvider.handleKeyBinding(e, "previousEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.zoomToFit', (e) => {
    viewerProvider.handleKeyBinding(e, "zoomToFit");
  }));

  // #region Marker and Timing
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnits', (e) => {
    viewerProvider.updateTimeUnits("");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsSeconds', (e) => {
    viewerProvider.updateTimeUnits("s");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMilliseconds', (e) => {
    viewerProvider.updateTimeUnits("ms");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMicroseconds', (e) => {
    viewerProvider.updateTimeUnits("µs");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsNanoseconds', (e) => {
    viewerProvider.updateTimeUnits("ns");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsPicoseconds', (e) => {
    viewerProvider.updateTimeUnits("ps");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsFemtoseconds', (e) => {
    viewerProvider.updateTimeUnits("fs");
  }));

  // #region WaveDrom
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyWaveDrom', (e) => {
    viewerProvider.copyWaveDrom();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockRising', (e) => {
    viewerProvider.setWaveDromClock('1', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockFalling', (e) => {
    viewerProvider.setWaveDromClock('0', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.unsetWaveDromClock', (e) => {
    viewerProvider.setWaveDromClock('1', null);
  }));

  // #region Value Format
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBinary', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "binary"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsHexadecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "hexadecimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "decimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimalSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "signed"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsOctal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "octal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFloat', (e) => {
    switch (e.width) {
      case 8:  viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float8"}); break;
      case 16: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float16"}); break;
      case 32: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float32"}); break;
      case 64: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float64"}); break;
      default: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "binary"}); break;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderMultiBit', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "multiBit"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinear', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "linear"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderStepped', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "stepped"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinearSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "linearSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderSteppedSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "steppedSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "bfloat16"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsTFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "tensorfloat32"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsAscii', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "ascii"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsEnum', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId,  {valueFormat: "enum"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFixedPoint', (e) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the fixed point offset',
      value: '0'
    }).then((offset) => {
      if (!offset) {return;}
      viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "fixedpoint_u_" + offset.toString()});
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFixedPointSigned', (e) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the fixed point offset',
      value: '0'
    }).then((offset) => {
      if (!offset) {return;}
      viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "fixedpoint_s_" + offset.toString()});
    });
  }));

  // #region Annotate Edges
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotatePosedge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: ["1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNegedge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: ["0"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateAllEdge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: ["0", "1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNone', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: []});
  }));

  // #region Custom Color
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 0});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 3});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 5});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 6});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 7});
  }));

  // #region Row Height
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight1x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight2x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight4x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight8x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 8});
  }));

  // #region Vertical Scale
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.increaseVerticalScale', (e) => {
    viewerProvider.handleKeyBinding(e, "increaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.decreaseVerticalScale', (e) => {
    viewerProvider.handleKeyBinding(e, "decreaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.resetVerticalScale', (e) => {
    viewerProvider.handleKeyBinding(e, "resetVerticalScale");
  }));

  // #region Name Type
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeFullPath', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {nameType: "fullPath"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeSignalName', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {nameType: "signalName"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeCustom', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {nameType: "custom"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showRulerLines', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.hideRulerLines', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.fillBitVector', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('fillMultiBitValues', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.outlineBitVector', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('fillMultiBitValues', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.enableAnimations', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('enableAnimations', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.disableAnimations', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('enableAnimations', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setMouseScrollingMode', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Mouse", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTouchpadScrollingMode', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Touchpad", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setAutoScrollingMode', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Auto", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSettings', (e) => {
    // Open VScode Settings to the Vaporview Section
    vscode.commands.executeCommand('workbench.action.openSettings', "vaporview");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.dummy', (e) => {
    viewerProvider.log.appendLine("Command called: 'vaporview.dummy' " + JSON.stringify(e));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openRemoteViewer', async (e) => {
    if (e && e.url) {
      viewerProvider.openRemoteViewer(e.url, e.bearerToken);
      return;
    }
    const serverUrl = await vscode.window.showInputBox({
      prompt: 'Enter the Surfer server URL',
      value: ''
    });
    
    if (!serverUrl) {
      return;
    }
    
    const bearerToken = await vscode.window.showInputBox({
      prompt: 'Enter bearer token (optional)',
      password: true,
      value: ''
    });
    
    viewerProvider.openRemoteViewer(serverUrl, bearerToken);
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

  // WCP Server commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.wcp.start', async () => {
    if (wcpServer && wcpServer.getIsRunning()) {
      vscode.window.showInformationMessage(`WCP server is already running on port ${wcpServer.getPort()}`);
      return;
    }
    
    const port = vscode.workspace.getConfiguration('vaporview').get<number>('wcp.port', wcpDefaultPort);
    wcpServer = new WCPServer(viewerProvider, context, port);
    try {
      const actualPort = await wcpServer.start();
      vscode.window.showInformationMessage(`WCP server started on port ${actualPort}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to start WCP server: ${error.message}`);
      wcpServer = null;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.wcp.stop', async () => {
    if (!wcpServer || !wcpServer.getIsRunning()) {
      vscode.window.showInformationMessage('WCP server is not running');
      return;
    }
    
    wcpServer.stop();
    wcpServer = null;
    await vscode.workspace.getConfiguration('vaporview').update('wcp.enabled', false, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('WCP server stopped');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.wcp.status', () => {
    if (wcpServer && wcpServer.getIsRunning()) {
      const connectionCount = wcpServer.getConnectionCount();
      const message = `WCP server is running on TCP port ${wcpServer.getPort()} (${connectionCount} connection${connectionCount !== 1 ? 's' : ''})`;
      vscode.window.showInformationMessage(message);
    } else {
      vscode.window.showInformationMessage('WCP server is not running');
    }
  }));

  return {
    onDidSetMarker: markerSetEvent,
    onDidSelectSignal: signalSelectEvent,
    onDidAddVariable: addVariableEvent,
    onDidRemoveVariable: removeVariableEvent,
    onDidDropInWaveformViewer: externalDropEvent
  };
}

export default WaveformViewerProvider;

export function deactivate() {
  // WCP server cleanup is handled by context subscriptions
  // All resources registered with context.subscriptions are automatically disposed
}

export function getTokenColorsForTheme(themeName: string) {
  const tokenColors = new Map();
  let currentThemePath;
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON.contributes && extension.packageJSON.contributes.themes;
    const currentTheme = themes && themes.find((theme: any) => theme.id === themeName);
    if (currentTheme) {
      currentThemePath = path.join(extension.extensionPath, currentTheme.path);
      break;
    }
  }
  const themePaths = [];
  if (currentThemePath) { themePaths.push(currentThemePath); }
  while (themePaths.length > 0) {
    const themePath: any = themePaths.pop();
    const theme: any = JSON.parse(fs.readFileSync(themePath, 'utf8'));
    if (theme) {
      if (theme.include) {
        themePaths.push(path.join(path.dirname(themePath), theme.include));
      }
      if (theme.tokenColors) {
        theme.tokenColors.forEach((rule: any) => {
          if (typeof rule.scope === "string" && !tokenColors.has(rule.scope)) {
            tokenColors.set(rule.scope, rule.settings);
          } else if (rule.scope instanceof Array) {
            rule.scope.forEach((scope: any) => {
              if (!tokenColors.has(rule.scope)) {
                tokenColors.set(scope, rule.settings);
              }
            });
          }
        });
      }
    }
  }
  return tokenColors;
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
  } catch { }
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
  } catch { }
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
