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
 * Formats: VCD/FST/GHW via the wellen wasm; FSDB via the Verdi FsdbReader
 * native addon (FsdbFormatHandler local-Linux path — reader libs resolved from
 * CRISP_FSDB_READER_LIBS / VERDI_HOME by the vscodeShims config, the
 * fsdb_worker forked with LD_LIBRARY_PATH augmented, and a prebuilt addon
 * honored via CRISP_FSDB_ADDON or the CLI's <cwd>/.crisp-fsdb build).
 *
 * Build: esbuild `standaloneConfig` aliases `vscode` → ./vscodeShims and emits
 * dist/standalone-host.js (CJS, Node).
 */
import { createInterface } from "readline";
import { readFile } from "fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import * as os from "os";
import * as nodePath from "path";

import { Uri } from "./vscodeShims";
import { WasmFormatHandler } from "../extension_core/wasm_handler";
import { FsdbFormatHandler } from "../extension_core/fsdb_handler";
import { VaporviewDocument } from "../extension_core/document";
import {
	activeTraceWalk,
	makeActiveTraceWalkState,
	makeRtlScanCache,
	toHexIfBinary,
	type ActiveTraceHop,
	type ActiveTraceWalkState,
	type RtlScanCache,
	type TraceBackend,
} from "@crisp/core/trace";

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

function parseArgs(argv: string[]): { file?: string; stateDir?: string } {
	const out: { file?: string; stateDir?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--file") {
			out.file = argv[++i];
		} else if (argv[i] === "--state-dir") {
			out.stateDir = argv[++i];
		}
	}
	return out;
}

async function main() {
	// Keep stdout pristine for the protocol — the wasm worker's host-side
	// callbacks log via console.log, so route that to stderr.
	console.log = ((...a: unknown[]) => logErr(a.map(String).join(" "))) as typeof console.log;
	console.info = console.log;

	const { file, stateDir: stateDirArg } = parseArgs(process.argv.slice(2));
	if (!file) {
		logErr("standalone-host: missing --file <path>");
		process.exit(2);
	}

	// --- Per-file viewer-session persistence ---------------------------------
	// The webview streams its full context (displayed signals, marker, zoom,
	// scroll) on every state change; VS Code keeps it via vscode.setState +
	// sidecar-side session files. Standalone: persist the latest context under
	// stateDir keyed by the dump's absolute path, and feed it back through
	// document.applySettings() when the webview asks to restoreState.
	const stateDir = stateDirArg ?? nodePath.join(os.tmpdir(), "crisp-waveform-states");
	const stateFile = nodePath.join(
		stateDir,
		createHash("sha1").update(nodePath.resolve(file)).digest("hex").slice(0, 16) + ".json");
	let lastContext: Record<string, unknown> | undefined;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	const flushState = () => {
		if (!lastContext) {
			return;
		}
		try {
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(stateFile, JSON.stringify(lastContext));
		} catch (e) {
			logErr(`standalone-host: viewer-state save failed: ${e instanceof Error ? e.message : e}`);
		}
	};
	process.on("SIGTERM", () => {
		flushState();
		process.exit(0);
	});

	const uri = Uri.file(file);
	const fileType = nodePath.extname(file).slice(1).toLowerCase();

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

	let handler: WasmFormatHandler | FsdbFormatHandler;
	if (fileType === "fsdb") {
		// Verdi FsdbReader path — no wasm needed. The handler resolves the
		// reader libs via the shimmed vaporview config (CRISP_FSDB_READER_LIBS
		// / VERDI_HOME) and forks dist/fsdb_worker.js next to this bundle.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handler = new FsdbFormatHandler(delegate as any, uri as any, async () => null);
	} else {
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
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			handler = await WasmFormatHandler.create(delegate as any, uri as any, fileType, wasmWorkerFile, wasmModule);
		} catch (e) {
			logErr(`standalone-host: failed to create handler: ${e instanceof Error ? e.message : e}`);
			process.exit(4);
		}
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

	// FsdbFormatHandler.loadNetlist reports failures via showErrorMessage and
	// RETURNS instead of throwing — a silent no-netlist document. Turn that
	// into an explicit, machine-readable failure for the desktop app.
	if (fileType === "fsdb" && !document.metadata.timeTableLoaded) {
		logErr("standalone-host: FSDB open failed — reader runtime unavailable (see messages above)");
		emit({
			command: "showMessage",
			messageType: "error",
			message:
				"FSDB open failed — the Verdi reader runtime did not initialize. " +
				"Check CRISP_FSDB_READER_LIBS, and make sure the native addon exists " +
				"(ask Crisp about this file once in chat to auto-build it, or set CRISP_FSDB_ADDON).",
		});
		process.exit(6);
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

	// Instance paths currently displayed in the viewer, from the last webview
	// context stream (groups are recursive). Used to avoid re-adding a signal on
	// an active-trace hop when it is already shown.
	const displayedInstancePaths = (): Set<string> => {
		const out = new Set<string>();
		const walk = (items: unknown) => {
			if (!Array.isArray(items)) return;
			for (const it of items as Array<Record<string, unknown>>) {
				if (!it || typeof it !== "object") continue;
				if (it.dataType === "netlist-variable" && typeof it.name === "string") out.add(it.name);
				else if (it.dataType === "signal-group") walk(it.children);
			}
		};
		walk((lastContext as Record<string, unknown> | undefined)?.displayedSignals);
		return out;
	};

	// Active-trace RTL scan cache: reused across hops and walks (bounded
	// staleness — an RTL edit is picked up on the next rebuild after the TTL).
	const RTL_CACHE_TTL_MS = 30_000;
	let rtlCacheEntry: { cwd: string; builtAt: number; cache: RtlScanCache } | undefined;
	const rtlCacheFor = (cwd: string): RtlScanCache => {
		const now = Date.now();
		if (!rtlCacheEntry || rtlCacheEntry.cwd !== cwd || now - rtlCacheEntry.builtAt > RTL_CACHE_TTL_MS) {
			rtlCacheEntry = { cwd, builtAt: now, cache: makeRtlScanCache() };
		}
		return rtlCacheEntry.cache;
	};

	// Active-trace walks: id → accumulated chain + walk state (visited set +
	// hop budget + the shared RTL cache). A walk survives across pause/resume
	// (decision points) until it reports done; capped to the most recent 20.
	interface HostWalk {
		state: ActiveTraceWalkState;
		chain: ActiveTraceHop[];
		time: number;
		cwd: string;
		done: boolean;
	}
	const walks = new Map<string, HostWalk>();
	let walkCounter = 0;

	// The tracer's waveform primitives, backed by the OPEN document — the same
	// value reads and netlist search the viewer itself uses.
	const traceBackend: TraceBackend = {
		async valuesAt(time, paths) {
			if (!paths.length) return [];
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const values = await (document as any).getValuesAtTime({ time, instancePaths: paths });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (values as any[]).map((v) => {
				const scalar = Array.isArray(v.value) ? v.value[v.value.length - 1] : v.value;
				return { instancePath: String(v.instancePath), value: scalar, valueHex: toHexIfBinary(scalar) };
			});
		},
		async searchSignals(fragment) {
			const res = await document.searchNetlist(fragment, undefined);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return ((res.searchResults as any[]) ?? [])
				.filter((h) => !h.isScope)
				.map((h) => String(h.instancePath ?? ""))
				.filter(Boolean);
		},
	};

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
			// Editor annotation: resolve leaf signal names in the netlist, then
			// fetch their values at `time`. One reply per request; names cap
			// keeps the per-name wasm searches bounded.
			case "annotateValues": {
				const requestId = e.requestId;
				const time = Number(e.time) || 0;
				const names = Array.isArray(e.names) ? (e.names as unknown[]).slice(0, 150).map(String) : [];
				(async () => {
					const nameForPath = new Map<string, string>();
					for (const name of names) {
						try {
							const res = await document.searchNetlist(name, undefined);
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const hits = (res.searchResults as any[]) ?? [];
							let best: string | undefined;
							for (const h of hits) {
								const p = String(h.instancePath ?? "");
								if ((p.split(".").pop() ?? "") !== name) continue;
								if (!best || p.length < best.length) best = p; // prefer top-most
							}
							if (best && !nameForPath.has(best)) nameForPath.set(best, name);
						} catch {
							/* unresolvable name — skip */
						}
					}
					const paths = [...nameForPath.keys()];
					const values = paths.length
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						? await (document as any).getValuesAtTime({ time, instancePaths: paths })
						: []
					emit({
						command: "annotationValues",
						requestId,
						time,
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						items: (values as any[]).map((v) => ({
							name: nameForPath.get(v.instancePath) ?? v.instancePath,
							instancePath: v.instancePath,
							value: Array.isArray(v.value) ? v.value[v.value.length - 1] : v.value,
						})),
					});
				})().catch((err) =>
					logErr(`standalone-host: annotateValues failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
			// Display a variable in the waveform (the desktop tree's double-click).
			// Accepts a netlistId (browse tree) or an instancePath (search hits,
			// which don't carry ids — resolved via findTreeItem). With select:true
			// (active-trace hop) the signal is only added when not already shown,
			// and the viewer selection is moved to it either way.
			case "addVariable": {
				(async () => {
					let netlistId = typeof e.netlistId === "number" ? (e.netlistId as number) : undefined;
					const instancePath = typeof e.instancePath === "string" ? (e.instancePath as string) : undefined;
					if (netlistId === undefined && instancePath) {
						const item = await document.findTreeItem(instancePath, undefined, undefined);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						netlistId = (item as any)?.netlistId;
					}
					if (typeof netlistId !== "number") {
						return;
					}
					const select = e.select === true;
					const alreadyShown = select && instancePath ? displayedInstancePaths().has(instancePath) : false;
					if (!alreadyShown) {
						await document.renderSignals([netlistId], undefined, undefined);
					}
					if (select) {
						emit({ command: "setSelectedSignal", netlistId });
					}
				})().catch((err) =>
					logErr(`standalone-host: addVariable failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
			// Active Trace walk (desktop right-click — extension-parity, no agent):
			// auto-follow the value-matching driver hop by hop; pause at genuine
			// decision points; the desktop's Trace pane renders the chain and
			// resumes/stops via activeTraceContinue/activeTraceStop. Replies carry
			// the FULL accumulated chain so rendering is idempotent.
			case "activeTrace":
			case "activeTraceContinue":
			case "activeTraceStop": {
				const requestId = e.requestId;
				const isStop = e.command === "activeTraceStop";
				const isContinue = e.command === "activeTraceContinue";
				(async () => {
					let walkId = typeof e.walkId === "string" ? (e.walkId as string) : "";
					let walk = walks.get(walkId);
					const reply = (w: HostWalk, extra: Record<string, unknown>) =>
						emit({
							command: "activeTraceResult",
							requestId,
							walkId,
							time: w.time,
							hops: w.chain,
							done: w.done,
							...extra,
						});

					if (isStop) {
						if (walk && !walk.done) {
							walk.done = true;
							reply(walk, { stopNote: "stopped by user" });
						}
						return;
					}

					if (isContinue) {
						if (!walk || walk.done) {
							logErr(`standalone-host: activeTraceContinue for unknown/finished walk ${walkId}`);
							return;
						}
					} else {
						// New walk.
						const time = Number(e.time) || 0;
						const cwd = typeof e.cwd === "string" && e.cwd ? (e.cwd as string) : process.cwd();
						walkId = `w${++walkCounter}`;
						walk = { state: makeActiveTraceWalkState(rtlCacheFor(cwd)), chain: [], time, cwd, done: false };
						walks.set(walkId, walk);
						if (walks.size > 20) {
							const oldest = walks.keys().next().value;
							if (oldest) walks.delete(oldest);
						}
					}

					const from = String(e.instancePath ?? "");
					const seg = await activeTraceWalk(traceBackend, walk.state, {
						from,
						time: walk.time,
						cwd: walk.cwd,
						firstReason: isContinue ? "picked" : "start",
					});
					walk.chain.push(...seg.hops);
					walk.done = seg.done;
					reply(walk, { pending: seg.pending, stopNote: seg.stopNote });
				})().catch((err) => {
					logErr(`standalone-host: ${e.command} failed: ${err instanceof Error ? err.message : err}`);
					emit({
						command: "activeTraceResult",
						requestId,
						walkId: typeof e.walkId === "string" ? e.walkId : "",
						hops: [],
						done: true,
						stopNote: `active trace failed: ${err instanceof Error ? err.message : err}`,
					});
				});
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
			// Viewer-session persistence: cache every context update (debounced
			// to disk), and answer the webview's load-time restore request with
			// the saved settings — document.applySettings resolves the signal
			// list against the freshly parsed netlist, exactly like VS Code's
			// StateChangeType.Restore path.
			case "contextUpdate": {
				const ctx: Record<string, unknown> = { ...e };
				delete ctx.command;
				lastContext = ctx;
				if (saveTimer) {
					clearTimeout(saveTimer);
				}
				saveTimer = setTimeout(flushState, 500);
				break;
			}
			case "restoreState": {
				try {
					let saved: Record<string, unknown> | undefined;
					if (existsSync(stateFile)) {
						saved = JSON.parse(readFileSync(stateFile, "utf8"));
					} else {
						// vaporview's session convention: a sibling <dump>.json.
						const sibling = file.replace(/\.[^.]+$/, "") + ".json";
						if (existsSync(sibling)) {
							saved = JSON.parse(readFileSync(sibling, "utf8"));
							logErr(`standalone-host: loading session from ${sibling}`);
						}
					}
					if (saved) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(document as any).applySettings(saved, 1 /* StateChangeType.Restore */, false);
					}
				} catch (err) {
					logErr(`standalone-host: viewer-state restore failed: ${err instanceof Error ? err.message : err}`);
				}
				break;
			}
			// Drop from the desktop's native netlist tree: the webview computed
			// the divider position (dropIndex within groupPath) and passes ids /
			// instance paths through (the extension's WebviewDropMessage shape) —
			// resolve paths to ids and render at exactly that spot, the same
			// renderSignals call the VSCode extension makes.
			case "handleDrop": {
				(async () => {
					const ids: number[] = Array.isArray(e.netlistIdList)
						? (e.netlistIdList as number[]).filter((id) => typeof id === "number")
						: [];
					const paths = Array.isArray(e.instancePathList) ? (e.instancePathList as string[]) : [];
					for (const path of paths) {
						if (typeof path !== "string" || !path) {
							continue;
						}
						const item = await document.findTreeItem(path, undefined, undefined);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const netlistId = (item as any)?.netlistId;
						if (typeof netlistId === "number") {
							ids.push(netlistId);
						}
					}
					if (ids.length > 0) {
						const groupPath = Array.isArray(e.groupPath) ? (e.groupPath as string[]) : undefined;
						const index = typeof e.dropIndex === "number" ? (e.dropIndex as number) : undefined;
						await document.renderSignals(ids, groupPath, index);
					}
				})().catch((err) =>
					logErr(`standalone-host: handleDrop failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
			// DnD diagnostics from the webview — stderr when debugging is on.
			case "logDnd":
				if (process.env.CRISP_DEV_DEBUG_DND === "1") {
					logErr(`[DND] ${String(e.message)}`);
				}
				break;
			// Host-side concerns that don't apply standalone — accept and ignore.
			// (copyToClipboard/showMessage are handled by the desktop app, which
			// taps them off the webview channel before they reach this process.)
			case "showMessage":
			case "copyToClipboard":
			case "executeCommand":
			case "updateConfiguration":
			case "emitEvent":
			case "close-webview":
				break;
			default:
				logErr(`standalone-host: unknown command: ${String(e.command)}`);
		}
	});

	rl.on("close", () => {
		flushState(); // tab close / app quit — persist the final viewer state
		process.exit(0);
	});
}

main().catch((e) => {
	logErr(`standalone-host: fatal: ${e instanceof Error ? e.stack : e}`);
	process.exit(1);
});
