/**
 * Standalone vaporview host — drives the existing vaporview parsing layer
 * (document.ts + wasm_handler.ts + the wellen wasm worker) outside of VSCode,
 * speaking the SAME message protocol the webview already uses, but over stdio
 * NDJSON instead of VSCode's postMessage bus.
 *
 *   stdin  : webview → host messages (ready, fetchDataFromFile, …), one JSON/line
 *   stdout : host → webview messages (initViewport, update-waveform-chunk*, …)
 *   stderr : diagnostics only
 *
 * The Crisp Desktop app injects an `acquireVsCodeApi()` shim into the webview
 * (running in QtWebEngine) and relays its postMessage traffic to/from this
 * process verbatim — so neither the webview nor the parser needs to change.
 *
 * Scope: the VCD/FST/GHW (wellen wasm) path. fsdb is intentionally not wired
 * here (it needs the proprietary Verdi addon); see PROTOCOL notes.
 *
 * Build: esbuild `standaloneConfig` aliases `vscode` → ./vscodeShims and emits
 * dist/standalone-host.js (CJS, Node).
 */
import { createInterface } from "readline";
import { readFile } from "fs/promises";
import * as nodePath from "path";

import { Uri } from "./vscodeShims";
import { WasmFormatHandler } from "../extension_core/wasm_handler";
import { VaporviewDocument } from "../extension_core/document";

/** Default signal colour palette (the webview falls back to these when no VSCode theme is available). */
const DEFAULT_COLOR_PALETTE = [
	"#4e9a06", "#3465a4", "#75507b", "#c4a000",
	"#06989a", "#cc0000", "#ce5c00", "#73d216",
];
const DEFAULT_ERROR_PALETTE = ["#cc0000", "#ef2929"];

function emit(message: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(message) + "\n");
}

function logErr(message: string): void {
	process.stderr.write(message + "\n");
}

function parseArgs(argv: string[]): { file?: string } {
	const out: { file?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--file") {
			out.file = argv[++i];
		}
	}
	return out;
}

async function main() {
	// Keep stdout pristine for the protocol — the wasm worker's host-side
	// callbacks log via console.log, so route that to stderr.
	console.log = ((...a: unknown[]) => logErr(a.map(String).join(" "))) as typeof console.log;
	console.info = console.log;

	const { file } = parseArgs(process.argv.slice(2));
	if (!file) {
		logErr("standalone-host: missing --file <path>");
		process.exit(2);
	}

	const uri = Uri.file(file);
	const fileType = nodePath.extname(file).slice(1).toLowerCase();

	// Locate sibling build artifacts relative to this bundle (dist/).
	const wasmWorkerFile = nodePath.join(__dirname, "worker.js");
	const wasmPath = nodePath.join(__dirname, "..", "target", "wasm32-unknown-unknown", "release", "filehandler.wasm");

	let wasmModule: WebAssembly.Module;
	try {
		wasmModule = await WebAssembly.compile(new Uint8Array(await readFile(wasmPath)));
	} catch (e) {
		logErr(`standalone-host: failed to load wasm at ${wasmPath}: ${e instanceof Error ? e.message : e}`);
		process.exit(3);
	}

	// Minimal document delegate — the VSCode-coupled bits collapse to no-ops or
	// stderr; the webview gets its colours from the constant palette.
	const delegate = {
		addSignalByNameToDocument: () => {},
		logOutputChannel: (m: string) => logErr(m),
		updateViews: () => {},
		emitEvent: (e: unknown) => emit(e as Record<string, unknown>),
		removeFromCollection: () => {},
		getColorPalette: () => ({
			colorPalette: DEFAULT_COLOR_PALETTE,
			errorColorPalette: DEFAULT_ERROR_PALETTE,
			themeValid: false,
		}),
	};

	// Duck-typed stand-in for VaporviewDocumentCollection (document.create only
	// needs an id factory + add()).
	let docCounter = 0;
	const collection = {
		createUniqueDocumentId: () => `doc${++docCounter}`,
		add: () => {},
		get: () => undefined,
		remove: () => {},
		getColorPalette: delegate.getColorPalette,
	};

	let handler: WasmFormatHandler;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handler = await WasmFormatHandler.create(delegate as any, uri as any, fileType, wasmWorkerFile, wasmModule);
	} catch (e) {
		logErr(`standalone-host: failed to create handler: ${e instanceof Error ? e.message : e}`);
		process.exit(4);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const document = await VaporviewDocument.create(uri as any, handler as any, delegate as any, collection as any);

	// Parse the file (netlist + body). This sets metadata.timeTableLoaded.
	try {
		await document.load();
	} catch (e) {
		logErr(`standalone-host: failed to parse ${file}: ${e instanceof Error ? e.message : e}`);
		emit({ command: "showMessage", messageType: "error", message: `Failed to parse ${file}` });
		process.exit(5);
	}

	// A fake "webview panel" whose postMessage is our stdout. document and the
	// handler post host→webview messages through panel.webview.postMessage.
	const fakePanel = { webview: { postMessage: (msg: Record<string, unknown>) => emit(msg) } };

	// Minimal wire form of a NetlistItem for the desktop app's netlist tree.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const serializeNetlistItem = (item: any) => ({
		name: item.name ?? String(item.label ?? ""),
		type: item.type ?? "",
		encoding: item.encoding ?? "",
		width: item.width ?? 0,
		netlistId: item.netlistId ?? null,
		signalId: item.signalId ?? null,
		scopePath: item.scopePath ?? [],
		msb: item.msb ?? -1,
		lsb: item.lsb ?? -1,
		isScope: (item.collapsibleState ?? 0) !== 0,
	});

	logErr(`standalone-host: parsed ${file} (${fileType}); waiting for webview ready`);

	const rl = createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;

		let e: Record<string, unknown>;
		try {
			e = JSON.parse(trimmed);
		} catch {
			logErr(`standalone-host: malformed line: ${trimmed.slice(0, 120)}`);
			return;
		}

		switch (e.command) {
			case "ready":
				// metadata.timeTableLoaded is already true → posts initViewport
				// + setConfigSettings immediately.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				document.onWebviewReady(fakePanel as any);
				break;
			case "fetchDataFromFile":
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				document.fetchData(e.requestList as any);
				break;
			case "logOutput":
				logErr(String(e.message ?? ""));
				break;
			// Netlist browsing for the desktop app (no VSCode TreeView standalone):
			// resolve a scope's children and echo them back with the requestId.
			case "getScopeChildren": {
				const requestId = e.requestId;
				const scopePath = typeof e.scopePath === "string" ? e.scopePath : "";
				(async () => {
					const element = scopePath
						? await document.findTreeItem(scopePath, undefined, undefined)
						: undefined;
					const children = await document.getScopeChildren(element ?? undefined);
					emit({
						command: "scopeChildren",
						requestId,
						scopePath,
						items: children.map(serializeNetlistItem),
					});
				})().catch((err) =>
					logErr(`standalone-host: getScopeChildren(${scopePath}) failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
			// Netlist search (fuzzy, wasm-side) for the desktop search box.
			case "searchNetlist": {
				const requestId = e.requestId;
				const query = String(e.query ?? "");
				(async () => {
					const result = await document.searchNetlist(query, undefined);
					emit({
						command: "netlistSearchResult",
						requestId,
						query,
						totalResults: result.totalResults,
						items: result.searchResults.slice(0, 200),
					});
				})().catch((err) =>
					logErr(`standalone-host: searchNetlist(${query}) failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
			// Display a variable in the waveform (the desktop tree's double-click).
			// Accepts a netlistId (browse tree) or an instancePath (search hits,
			// which don't carry ids — resolved via findTreeItem).
			case "addVariable": {
				(async () => {
					let netlistId = typeof e.netlistId === "number" ? (e.netlistId as number) : undefined;
					if (netlistId === undefined && typeof e.instancePath === "string") {
						const item = await document.findTreeItem(e.instancePath as string, undefined, undefined);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						netlistId = (item as any)?.netlistId;
					}
					if (typeof netlistId === "number") {
						await document.renderSignals([netlistId], undefined, undefined);
					}
				})().catch((err) =>
					logErr(`standalone-host: addVariable failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
			case "removeVariable": {
				(async () => {
					let netlistId = typeof e.netlistId === "number" ? (e.netlistId as number) : undefined;
					if (netlistId === undefined && typeof e.instancePath === "string") {
						const item = await document.findTreeItem(e.instancePath as string, undefined, undefined);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						netlistId = (item as any)?.netlistId;
					}
					if (typeof netlistId === "number") {
						document.removeSignalFromWebview(netlistId, undefined, false);
					}
				})().catch((err) =>
					logErr(`standalone-host: removeVariable failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
			// Host-side concerns that don't apply standalone — accept and ignore.
			case "showMessage":
			case "copyToClipboard":
			case "executeCommand":
			case "updateConfiguration":
			case "restoreState":
			case "contextUpdate":
			case "emitEvent":
			case "handleDrop":
			case "close-webview":
				break;
			default:
				logErr(`standalone-host: unknown command: ${String(e.command)}`);
		}
	});

	rl.on("close", () => process.exit(0));
}

main().catch((e) => {
	logErr(`standalone-host: fatal: ${e instanceof Error ? e.stack : e}`);
	process.exit(1);
});
