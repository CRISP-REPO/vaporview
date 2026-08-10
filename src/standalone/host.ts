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
import { readFile, readdir } from "fs/promises";
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
	findAssignments,
	hasUnknownBits,
	makeActiveTraceWalkState,
	makeRtlScanCache,
	normalizeInstancePath,
	toHexIfBinary,
	traceSignal,
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

	// Upper bound on transitions any single history read materializes here.
	// A clock in a 2 GB dump has millions; the questions this host asks
	// (first x, clock edges, reg history) all need a bounded PREFIX, not all
	// of it. Results at the cap are treated as prefixes, never as "all".
	const kMaxHistoryRead = 200_000;

	// Reduce a viewer value to a settled scalar string. The wasm backend hands
	// back glitch/edge arrays — sometimes REAL arrays, sometimes STRINGIFIED
	// (`["0","1"]`), sometimes malformed (`[],"0"]`) — and every host-side
	// consumer (edge detection, assertion eval, run diff) needs the settled
	// value, exactly like the core tracer's own scalarOf.
	const scalarize = (raw: unknown): string => {
		if (Array.isArray(raw)) return raw.length ? String(raw[raw.length - 1]) : "";
		const s = String(raw ?? "");
		if (s.length > 1 && s.startsWith("[") && s.endsWith("]")) {
			try {
				const arr = JSON.parse(s);
				if (Array.isArray(arr) && arr.length) return String(arr[arr.length - 1]);
			} catch {
				/* not JSON — try the last quoted token below */
			}
			const m = /"([^"]*)"\s*\]$/.exec(s);
			if (m) return m[1]!;
		}
		return s;
	};

	// Data-quality notes from the reads themselves (a truncated history), reported
	// next to the RTL scan limits so the Trace pane shows everything that bounded
	// the answer. Deduped and bounded; cumulative for the life of the host.
	const traceNotes: string[] = [];
	const traceNote = (n: string): void => {
		if (!traceNotes.includes(n) && traceNotes.length < 12) traceNotes.push(n);
	};

	// The tracer's waveform primitives, backed by the OPEN document — the same
	// value reads and netlist search the viewer itself uses.
	const traceBackend: TraceBackend = {
		async valuesAt(time, paths) {
			if (!paths.length) return [];
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const values = await (document as any).getValuesAtTime({ time, instancePaths: paths });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (values as any[]).map((v) => {
				const scalar = scalarize(v.value);
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
		// Exact transition history — FSDB via the reader, VCD/FST/GHW via the wasm
		// handler's getvaluechanges export. A handler that has neither returns null
		// and the tracer degrades to its structural answer, as the interface documents.
		async valueChanges(path, opts) {
			// Window + cap travel to the handler (both readers honour them, so a
			// million-transition clock never crosses the boundary); the filters below
			// still apply for handlers that ignore them.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const res = await (document as any).getValueChangesForPath(path, {
				start: opts?.start,
				end: opts?.end,
				max: opts?.max ?? kMaxHistoryRead,
			});
			const vc = res?.valueChanges;
			if (!Array.isArray(vc)) return null;
			let out = vc as Array<[number, string]>;
			if (opts?.start !== undefined) out = out.filter(([t]) => t >= (opts.start as number));
			if (opts?.end !== undefined) out = out.filter(([t]) => t <= (opts.end as number));
			const cap = opts?.max ?? kMaxHistoryRead;
			if (res?.truncated || out.length > cap) {
				// A truncated history is a PREFIX. The tracer degrades on its own, but
				// the user should be told WHY the answer got vaguer instead of being
				// left to wonder — same reason RTL scan caps are reported.
				traceNote(
					`${path}: only the first ${cap.toLocaleString()} value changes were read — sequential/x history beyond that was not analyzed.`,
				);
			}
			if (out.length > cap) out = out.slice(0, cap);
			return out;
		},
		backendNotes: () => [...traceNotes],
	};

	// ---- SVA assertion checking (native subset) -------------------------------
	// Supported form: [label:] assert property (@(posedge|negedge clk)
	// [disable iff (expr)] A |-> B) — plus |=> and consequent-only properties.
	// Boolean expressions over dump signals with ! ~ && || & | ^ == != parens,
	// literals, and $rose/$fell/$stable/$past. Sequence syntax (##, [*…],
	// throughout, …) is reported as unsupported rather than mis-evaluated.
	interface SvaAssertion {
		label: string;
		file: string;
		line: number;
		edge: string;
		clk: string;
		disable?: string;
		ante: string;
		conseq: string;
		op: string;
		text: string;
		unsupported?: boolean;
	}

	const kRtlSkipDirs = new Set([
		"node_modules", ".git", "build", "build-docker", "dist", "out", "obj", "target",
	]);
	const listRtlFiles = async (root: string, cap = 1500): Promise<string[]> => {
		const out: string[] = [];
		const walkDir = async (dir: string): Promise<void> => {
			if (out.length >= cap) return;
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				if (out.length >= cap) return;
				if (ent.isDirectory()) {
					if (kRtlSkipDirs.has(ent.name) || ent.name.startsWith(".")) continue;
					await walkDir(nodePath.join(dir, ent.name));
				} else if (/\.(sv|v|svh)$/i.test(ent.name)) {
					out.push(nodePath.join(dir, ent.name));
				}
			}
		};
		await walkDir(root);
		return out;
	};

	const parseAssertions = (content: string, file: string): SvaAssertion[] => {
		const out: SvaAssertion[] = [];
		const re = /(?:(\w+)\s*:\s*)?assert\s+property\s*\(/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content))) {
			const start = re.lastIndex;
			let depth = 1;
			let i = start;
			for (; i < content.length && depth > 0; i++) {
				const c = content[i];
				if (c === "(") depth++;
				else if (c === ")") depth--;
			}
			if (depth !== 0) break;
			const body = content.slice(start, i - 1);
			const line = content.slice(0, m.index).split("\n").length;
			re.lastIndex = i;
			const ck = /@\(\s*(posedge|negedge)\s+([\w.]+)\s*\)/.exec(body);
			if (!ck) continue;
			let rest = body.replace(ck[0], " ");
			let disable: string | undefined;
			const dis = /disable\s+iff\s*\(([^)]*)\)/.exec(rest);
			if (dis) {
				disable = dis[1];
				rest = rest.replace(dis[0], " ");
			}
			// Split at a top-level |-> or |=> (never inside parens).
			let op = "";
			let opIdx = -1;
			let d = 0;
			for (let j = 0; j < rest.length - 2; j++) {
				const c = rest[j];
				if (c === "(") d++;
				else if (c === ")") d--;
				else if (d === 0 && c === "|" && (rest[j + 1] === "-" || rest[j + 1] === "=") && rest[j + 2] === ">") {
					op = rest.slice(j, j + 3);
					opIdx = j;
					break;
				}
			}
			const ante = opIdx >= 0 ? rest.slice(0, opIdx).trim() : "1'b1";
			const conseq = (opIdx >= 0 ? rest.slice(opIdx + 3) : rest).trim();
			const unsupported =
				/##|\[\*|\[->|\[=|\bthroughout\b|\bwithin\b|\bfirst_match\b|\bs_?eventually\b|\buntil\b|\bintersect\b/.test(
					rest,
				);
			out.push({
				label: m[1] ?? "",
				file,
				line,
				edge: ck[1]!,
				clk: ck[2]!,
				disable,
				ante,
				conseq,
				op: op || "|->",
				text: body.trim().replace(/\s+/g, " ").slice(0, 160),
				unsupported,
			});
		}
		return out;
	};

	// Tiny boolean evaluator. Values are scalar strings (hex-normalized where
	// possible); x/z propagates as null (three-valued: a failure requires a
	// DEFINITE false). Multibit & | ^ are evaluated on truthiness — good enough
	// for the control assertions this targets.
	type SvaEnv = { cur: Map<string, string>; prev: Map<string, string> | null };
	const svaNorm = (s: string | undefined): string | null => {
		if (s === undefined || s === "") return null;
		if (hasUnknownBits(s)) return null;
		// toHexIfBinary yields "0x…" — drop the prefix BEFORE the leading-zero
		// strip, or "0x1" becomes the never-numeric "x1".
		let t = (toHexIfBinary(s) ?? s).toLowerCase();
		if (t.startsWith("0x")) t = t.slice(2);
		return t.replace(/^0+(?=.)/, "");
	};
	const svaTruthy = (s: string | null): boolean | null => {
		if (s === null) return null;
		if (/^[0-9a-f]+$/.test(s)) {
			try {
				return BigInt("0x" + s) !== 0n;
			} catch {
				return null;
			}
		}
		return s.length > 0;
	};
	const svaLiteral = (tok: string): string | null => {
		const sized = /^\d*'s?([bodh])([0-9a-fx_z?]+)$/i.exec(tok);
		if (sized) {
			const base = sized[1]!.toLowerCase();
			const digits = sized[2]!.replace(/_/g, "");
			if (/[xz?]/i.test(digits)) return null;
			const radix = base === "b" ? 2 : base === "o" ? 8 : base === "d" ? 10 : 16;
			try {
				return BigInt(`${radix === 10 ? "" : radix === 16 ? "0x" : radix === 8 ? "0o" : "0b"}${digits}` || "0").toString(16);
			} catch {
				return null;
			}
		}
		if (/^\d+$/.test(tok)) return BigInt(tok).toString(16);
		return null;
	};

	const evalSva = (expr: string, env: SvaEnv): boolean | null => {
		let pos = 0;
		const s = expr;
		const ws = () => {
			while (pos < s.length && /\s/.test(s[pos]!)) pos++;
		};
		const peek = (str: string) => s.startsWith(str, pos);
		const eat = (str: string) => (peek(str) ? ((pos += str.length), true) : false);
		const identRe = /^[A-Za-z_][\w.]*/;
		const valueOf = (name: string, map: Map<string, string> | null): string | null =>
			map ? svaNorm(map.get(name)) : null;

		// Primary → returns a VALUE (string|null) for comparisons; boolean
		// contexts reduce via svaTruthy.
		const parsePrimary = (): string | null => {
			ws();
			if (eat("(")) {
				const v = parseOrVal();
				ws();
				eat(")");
				return v;
			}
			if (eat("!") || eat("~")) {
				const v = svaTruthy(parsePrimary());
				return v === null ? null : v ? "0" : "1";
			}
			if (s[pos] === "$") {
				const fn = /^\$(rose|fell|stable|past)\s*\(\s*([A-Za-z_][\w.]*)\s*\)/.exec(s.slice(pos));
				if (fn) {
					pos += fn[0].length;
					const name = fn[2]!;
					const cur = valueOf(name, env.cur);
					const prv = valueOf(name, env.prev);
					switch (fn[1]) {
						case "past":
							return prv;
						case "stable":
							return cur !== null && prv !== null ? (cur === prv ? "1" : "0") : null;
						case "rose": {
							const c = svaTruthy(cur);
							const p = svaTruthy(prv);
							return c === null || p === null ? null : c && !p ? "1" : "0";
						}
						case "fell": {
							const c = svaTruthy(cur);
							const p = svaTruthy(prv);
							return c === null || p === null ? null : !c && p ? "1" : "0";
						}
					}
				}
				return null; // unknown system function
			}
			const lit = /^\d*'s?[bodh][0-9a-fx_z?]+|^\d+/i.exec(s.slice(pos));
			if (lit) {
				pos += lit[0].length;
				return svaLiteral(lit[0]);
			}
			const id = identRe.exec(s.slice(pos));
			if (id) {
				pos += id[0].length;
				const leaf = id[0].split(".").pop()!;
				return valueOf(leaf, env.cur);
			}
			pos++; // unparseable char — skip so we terminate
			return null;
		};
		const parseEq = (): string | null => {
			let left = parsePrimary();
			ws();
			while (peek("==") || peek("!=")) {
				const neg = peek("!=");
				pos += 2;
				const right = parsePrimary();
				if (left === null || right === null) left = null;
				else left = (left === right) !== neg ? "1" : "0";
				ws();
			}
			return left;
		};
		const boolBin = (
			next: () => string | null,
			opChar: string,
			apply: (a: boolean, b: boolean) => boolean,
		) => (): string | null => {
			let left = next();
			ws();
			// Single-char & | ^ but not && / ||.
			while (s[pos] === opChar && s[pos + 1] !== opChar) {
				pos++;
				const right = next();
				const a = svaTruthy(left);
				const b = svaTruthy(right);
				left = a === null || b === null ? null : apply(a, b) ? "1" : "0";
				ws();
			}
			return left;
		};
		const parseBitAnd = boolBin(parseEq, "&", (a, b) => a && b);
		const parseXor = boolBin(parseBitAnd, "^", (a, b) => a !== b);
		const parseBitOr = boolBin(parseXor, "|", (a, b) => a || b);
		const parseAnd = (): string | null => {
			let left = parseBitOr();
			ws();
			while (eat("&&")) {
				const right = parseBitOr();
				const a = svaTruthy(left);
				const b = svaTruthy(right);
				left = a === null || b === null ? null : a && b ? "1" : "0";
				ws();
			}
			return left;
		};
		const parseOrVal = (): string | null => {
			let left = parseAnd();
			ws();
			while (eat("||")) {
				const right = parseAnd();
				const a = svaTruthy(left);
				const b = svaTruthy(right);
				left = a === null || b === null ? null : a || b ? "1" : "0";
				ws();
			}
			return left;
		};
		return svaTruthy(parseOrVal());
	};

	const svaIdentifiers = (expr: string): string[] => {
		const kKeywords = new Set(["posedge", "negedge", "disable", "iff"]);
		const out = new Set<string>();
		// Blank out literals FIRST — `1'b1` would otherwise shed a phantom
		// identifier `b1` (the token regex starts mid-literal at the base char).
		const cleaned = expr.replace(/\d*'s?[bodh][0-9a-fx_z?]+/gi, " ");
		const re = /\$?[A-Za-z_][\w.]*/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(cleaned))) {
			const tok = m[0];
			if (tok.startsWith("$")) continue; // $rose(...) — the inner ident matches separately
			if (kKeywords.has(tok)) continue;
			out.add(tok.split(".").pop()!);
		}
		return [...out];
	};

	// Resolve a leaf name near `scope` (sibling first, then netlist search).
	const resolveLeafNear = async (scope: string, name: string): Promise<string | null> => {
		if (scope) {
			const item = await document.findTreeItem(`${scope}.${name}`, undefined, undefined);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			if (item && (item as any).contextValue !== "netlistScope") return `${scope}.${name}`;
		}
		const hits = (await traceBackend.searchSignals(name)).filter(
			(p) => p.split(".").pop() === name,
		);
		return hits.sort((a, b) => a.length - b.length)[0] ?? null;
	};

	// Clock edge times: exact from transition history (FSDB), else a sampled
	// grid (VCD/FST) — an edge between two samples lands on the later sample.
	/** Edges an assertion check may evaluate (also bounds the clock history read). */
	const kMaxSvaEdges = 400;

	const clockEdges = async (
		clkPath: string,
		edge: string,
	): Promise<{ times: number[]; sampled: boolean; partial?: boolean }> => {
		const rising = edge === "posedge";
		const isHigh = (v: string): boolean | null => {
			const t = svaTruthy(svaNorm(v));
			return t;
		};
		// A clock is the HIGHEST-transition signal in any dump — read only as
		// much history as the edge budget can consume (2 transitions/edge, ×4
		// headroom for irregular clocks) instead of the whole million.
		const clkCap = kMaxSvaEdges * 8;
		const vc = await traceBackend.valueChanges!(clkPath, { max: clkCap });
		if (vc && vc.length) {
			const times: number[] = [];
			let prev: boolean | null = null;
			for (const [t, v] of vc) {
				const b = isHigh(String(v));
				if (prev !== null && b !== null && b !== prev && b === rising) times.push(t);
				if (b !== null) prev = b;
			}
			// At the cap the history is a PREFIX: the edges are real, but they
			// are the FIRST N — the caller reports that honestly.
			return { times, sampled: false, partial: vc.length >= clkCap };
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tEnd = Number((document as any).metadata?.timeEnd) || 0;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const minStep = Number((document as any).metadata?.minTimeStep) || 1;
		const step = Math.max(minStep, Math.ceil(tEnd / 2048));
		const times: number[] = [];
		let prev: boolean | null = null;
		for (let t = 0; t <= tEnd; t += step) {
			const vals = await traceBackend.valuesAt(t, [clkPath]);
			const b = vals.length ? isHigh(String(vals[0]!.value ?? "")) : null;
			if (prev !== null && b !== null && b !== prev && b === rising) times.push(t);
			if (b !== null) prev = b;
		}
		return { times, sampled: true };
	};

	// First time `path` reads x/z. Exact when the backend has transition
	// history (FSDB); otherwise a sampled scan — coarse pass over the dump
	// range, then a binary refine of the first known→x bracket. Sampling can
	// miss an x pulse narrower than the coarse step; the result says so.
	const findFirstXTime = async (
		path: string,
	): Promise<{ time: number; sampled: boolean } | { neverX: true; sampled: boolean }> => {
		// Only a PREFIX is needed — the FIRST x is what we are after, and it is
		// at the front by definition. An x beyond the cap is vanishingly
		// unlikely and the sampled fallback covers a pathological case.
		const changes = await traceBackend.valueChanges!(path, { max: kMaxHistoryRead });
		if (changes && changes.length) {
			for (const [t, v] of changes) {
				if (hasUnknownBits(String(v))) return { time: t, sampled: false };
			}
			// Exhaustive only when the history was NOT truncated.
			if (changes.length < kMaxHistoryRead) return { neverX: true, sampled: false };
		}
		const valueAt = async (t: number): Promise<string | undefined> => {
			const vals = await traceBackend.valuesAt(t, [path]);
			return vals.length ? String(vals[0]!.value ?? "") : undefined;
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tEnd = Number((document as any).metadata?.timeEnd) || 0;
		if (tEnd <= 0) return { neverX: true, sampled: true };
		if (hasUnknownBits(await valueAt(0))) return { time: 0, sampled: true };
		const kSamples = 64;
		let lo = 0;
		let hi = -1;
		for (let i = 1; i <= kSamples; i++) {
			const t = Math.round((tEnd * i) / kSamples);
			if (hasUnknownBits(await valueAt(t))) {
				hi = t;
				break;
			}
			lo = t;
		}
		if (hi < 0) return { neverX: true, sampled: true };
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			if (hasUnknownBits(await valueAt(mid))) hi = mid;
			else lo = mid;
		}
		return { time: hi, sampled: true };
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
			// Editor → waveform DnD: the code editor drags plain identifier
			// names (it knows nothing of hierarchy). Resolve each against the
			// netlist — exact LEAF match, shortest instance path wins (top-most
			// scope) — and render what resolves. Always ack with the tally so
			// the desktop can tell the user what a dropped name resolved to.
			case "addSignalsByName": {
				const names = Array.isArray(e.names) ? (e.names as unknown[]).slice(0, 8).map(String) : [];
				(async () => {
					const added: string[] = [];
					const alreadyShown: string[] = [];
					const unresolved: string[] = [];
					for (const name of names) {
						try {
							const res = await document.searchNetlist(name, undefined);
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const hits = (res.searchResults as any[]) ?? [];
							let best: string | undefined;
							for (const h of hits) {
								const p = String(h.instancePath ?? "");
								if ((p.split(".").pop() ?? "") !== name) continue;
								if (!best || p.length < best.length) best = p;
							}
							if (!best) {
								unresolved.push(name);
								continue;
							}
							if (displayedInstancePaths().has(best)) {
								alreadyShown.push(best);
								continue;
							}
							const item = await document.findTreeItem(best, undefined, undefined);
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const netlistId = (item as any)?.netlistId;
							if (typeof netlistId !== "number") {
								unresolved.push(name);
								continue;
							}
							await document.renderSignals([netlistId], undefined, undefined);
							added.push(best);
						} catch {
							unresolved.push(name);
						}
					}
					emit({ command: "signalsAddedByName", added, alreadyShown, unresolved });
				})().catch((err) =>
					logErr(`standalone-host: addSignalsByName failed: ${err instanceof Error ? err.message : err}`),
				);
				break;
			}
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
					// scanNotes = RTL scan LIMITS that bit (file-walk cap, per-name
					// caps). A truncated scan can masquerade as "no driver", so it
					// travels to the pane instead of being dropped here.
					reply(walk, { pending: seg.pending, stopNote: seg.stopNote, scanNotes: seg.scanNotes });
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
			// Displayed rows (instance paths) from the host's context stream —
			// the run-diff coordinator uses the ACTIVE run's rows as the compare set.
			case "getDisplayed": {
				emit({
					command: "displayedSignals",
					requestId: e.requestId,
					paths: [...displayedInstancePaths()],
				});
				break;
			}
			// Exact-path batch value read at one time (run diff / assertion eval).
			// annotateValues resolves loose NAMES; this one takes full paths.
			case "valuesAt": {
				const requestId = e.requestId;
				const time = Number(e.time) || 0;
				const paths = Array.isArray(e.paths) ? (e.paths as unknown[]).slice(0, 400).map(String) : [];
				(async () => {
					const values = await traceBackend.valuesAt(time, paths);
					emit({
						command: "valuesAtResult",
						requestId,
						time,
						values: values.map((v) => ({
							instancePath: v.instancePath,
							value: v.valueHex ?? String(v.value ?? ""),
						})),
					});
				})().catch((err) => {
					logErr(`standalone-host: valuesAt failed: ${err instanceof Error ? err.message : err}`);
					emit({ command: "valuesAtResult", requestId, time, values: [] });
				});
				break;
			}
			// Real waveform data for a CHAT snapshot: resolve loose names, then
			// return the windowed transition history for each. The IDE draws a
			// proper waveform from this instead of showing the ASCII plot the
			// tracer renders for terminals — same dump, same values, but a
			// picture the user can actually read at chat-pane width.
			case "waveSnapshot": {
				const requestId = e.requestId;
				const names = Array.isArray(e.signals) ? (e.signals as unknown[]).slice(0, 24).map(String) : [];
				const start = Number(e.start);
				const end = Number(e.end);
				const cursor = Number(e.cursor);
				// Scope of a known signal from the same trace — lets a bare leaf
				// ("q") resolve to the RIGHT one in a design with fifty of them.
				const hintScope = typeof e.hintScope === "string" ? (e.hintScope as string) : "";
				(async () => {
					const out: Array<Record<string, unknown>> = [];
					for (const name of names) {
						let path = "";
						if (name.includes(".")) {
							path = name;
						} else if (hintScope) {
							const candidate = `${hintScope}.${name}`;
							const probe = await traceBackend.valuesAt(cursor, [candidate]);
							if (probe.length) path = candidate;
						}
						if (!path) {
							// Unique leaf match only — guessing between two `count`s
							// would draw a waveform of the wrong signal, which is
							// worse than drawing none.
							const hits = (await traceBackend.searchSignals(name)).filter(
								(p) => p.slice(p.lastIndexOf(".") + 1) === name,
							);
							if (hits.length === 1) path = hits[0]!;
						}
						if (!path) { continue; }
						const vc = await traceBackend.valueChanges?.(path, { start, end, max: 4000 });
						// No history (a handler without value-change reads) still gets a
						// row: the held value across the window, drawn as one segment.
						const at = await traceBackend.valuesAt(cursor, [path]);
						const atStart = await traceBackend.valuesAt(start, [path]);
						// Same radix as the value column and the viewer — raw dump values
						// are binary, and a bus reading 00111000 next to a cursor value of
						// 0x38 looks like two different signals.
						const hex = (v: unknown): string => {
							const s = scalarize(v);
							return toHexIfBinary(s) || s;
						};
						const trans: Array<[number, string]> = (vc ?? []).map(
							([t, v]) => [t, hex(v)] as [number, string],
						);
						// The value HELD when the window opens: without it the lane starts
						// blank until the first change inside the window, which reads as
						// "no data" rather than "unchanged".
						if (atStart.length && (trans.length === 0 || trans[0]![0] > start)) {
							trans.unshift([start, hex(atStart[0]!.valueHex ?? atStart[0]!.value)]);
						}
						out.push({
							name,
							instancePath: path,
							transitions: vc ? trans : null,
							valueAtCursor: at.length ? (at[0]!.valueHex ?? String(at[0]!.value ?? "")) : null,
						});
					}
					emit({
						command: "waveSnapshotResult",
						requestId,
						start, end, cursor,
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						timeUnit: String((document as any).metadata?.timeUnit ?? ""),
						signals: out,
					});
				})().catch((err) => {
					logErr(`standalone-host: waveSnapshot failed: ${err instanceof Error ? err.message : err}`);
					emit({ command: "waveSnapshotResult", requestId, signals: [] });
				});
				break;
			}
			// Driver trace against the OPEN document — the value-mode twin of
			// xOrigin. The agent tools open their OWN reader session for this
			// (a second FSDB stack that needs its own libs and netlist read,
			// and fails independently of the viewer you are looking at). This
			// session already has the file parsed, so run the trace here and
			// hand the agent a finished chain to explain.
			case "traceDrivers": {
				const requestId = e.requestId;
				const path = String(e.instancePath ?? "");
				const time = Number(e.time) || 0;
				const cwd = typeof e.cwd === "string" && e.cwd ? (e.cwd as string) : process.cwd();
				const mode = e.mode === "x" ? "x" : e.mode === "value" ? "value" : undefined;
				(async () => {
					const res = await traceSignal(traceBackend, { start: path, time, cwd, mode });
					emit({
						command: "traceDriversResult",
						requestId,
						instancePath: path,
						// `start`/`mermaid` make this payload a complete TraceResult, so a
						// caller can hand it straight to buildTraceReport (the chat sidecar
						// does exactly that when the IDE serves a trace on its behalf).
						start: res.start,
						startInstancePath: res.startInstancePath,
						mermaid: res.mermaid,
						time,
						mode: res.mode ?? "value",
						hops: res.hops,
						stopReason: res.stopReason,
						needsReasoning: res.needsReasoning ?? null,
						xRootCause: res.xRootCause ?? null,
						branchCount: res.branchCount ?? 0,
						...(res.scanNotes?.length ? { scanNotes: res.scanNotes } : {}),
					});
				})().catch((err) => {
					logErr(`standalone-host: traceDrivers failed: ${err instanceof Error ? err.message : err}`);
					emit({
						command: "traceDriversResult",
						requestId,
						instancePath: path,
						error: `trace failed: ${err instanceof Error ? err.message : err}`,
					});
				});
				break;
			}
			// X-origin hunter: find the FIRST time the signal reads x/z, then
			// root-cause the unknown with the core tracer's x-mode (follows the
			// x through the fan-in to undriven / multi-driver / uninitialized-reg
			// / primary-input / x-select). One command = the whole hunt.
			case "xOrigin": {
				const requestId = e.requestId;
				const path = String(e.instancePath ?? "");
				const cwd = typeof e.cwd === "string" && e.cwd ? (e.cwd as string) : process.cwd();
				(async () => {
					const firstX = await findFirstXTime(path);
					if ("neverX" in firstX) {
						emit({
							command: "xOriginResult",
							requestId,
							instancePath: path,
							neverX: true,
							sampled: firstX.sampled,
						});
						return;
					}
					const res = await traceSignal(traceBackend, {
						start: path,
						time: firstX.time,
						cwd,
						mode: "x",
					});
					emit({
						command: "xOriginResult",
						requestId,
						instancePath: path,
						neverX: false,
						firstXTime: firstX.time,
						sampled: firstX.sampled,
						hops: res.hops,
						stopReason: res.stopReason,
						xRootCause: res.xRootCause ?? null,
						mermaid: res.mermaid,
						// Same limits the Active Trace reports (RTL scan caps + truncated
						// history): an x hunt that could not read everything must say so,
						// or "no x driver found" reads as a conclusion instead of a cap.
						...(res.scanNotes?.length ? { scanNotes: res.scanNotes } : {}),
					});
				})().catch((err) => {
					logErr(`standalone-host: xOrigin failed: ${err instanceof Error ? err.message : err}`);
					emit({
						command: "xOriginResult",
						requestId,
						instancePath: path,
						error: `x-origin hunt failed: ${err instanceof Error ? err.message : err}`,
					});
				});
				break;
			}
			// Assertion-aware check: find SVA assertions in the workspace RTL that
			// mention the signal's leaf name, evaluate each over the dump at its
			// clock edges, and report failure times.
			case "checkAssertions": {
				const requestId = e.requestId;
				const path = String(e.instancePath ?? "");
				const cwd = typeof e.cwd === "string" && e.cwd ? (e.cwd as string) : process.cwd();
				(async () => {
					const node = normalizeInstancePath(path) ?? path.trim();
					const leaf = node.split(".").pop() ?? node;
					const scope = node.split(".").slice(0, -1).join(".");
					const files = await listRtlFiles(cwd);
					const leafRe = new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
					const all: SvaAssertion[] = [];
					for (const f of files) {
						let content: string;
						try {
							content = await readFile(f, "utf8");
						} catch {
							continue;
						}
						if (!content.includes("assert")) continue;
						for (const a of parseAssertions(content, f)) {
							if (leafRe.test(`${a.ante} ${a.conseq} ${a.disable ?? ""}`)) all.push(a);
						}
					}
					const kMaxAssertions = 8;
					const kMaxEdges = kMaxSvaEdges;
					const items: Record<string, unknown>[] = [];
					for (const a of all.slice(0, kMaxAssertions)) {
						const base = {
							label: a.label || `${nodePath.basename(a.file)}:${a.line}`,
							file: a.file,
							line: a.line,
							text: a.text,
							op: a.op,
						};
						if (a.unsupported) {
							items.push({ ...base, note: "sequence syntax not supported by the native checker" });
							continue;
						}
						const clkPath = await resolveLeafNear(scope, a.clk.split(".").pop()!);
						if (!clkPath) {
							items.push({ ...base, note: `clock '${a.clk}' not found in the dump` });
							continue;
						}
						const names = svaIdentifiers(`${a.ante} ${a.conseq} ${a.disable ?? ""}`);
						const pathFor = new Map<string, string>();
						const missing: string[] = [];
						for (const n of names) {
							const p = await resolveLeafNear(scope, n);
							if (p) pathFor.set(n, p);
							else missing.push(n);
						}
						if (missing.length) {
							items.push({ ...base, note: `signals not in dump: ${missing.join(", ")}` });
							continue;
						}
						const { times, sampled, partial } = await clockEdges(clkPath, a.edge);
						const edges = times.slice(0, kMaxEdges);
						const failures: number[] = [];
						let checked = 0;
						let anteTrue = 0;
						let unknown = 0;
						let prev: Map<string, string> | null = null;
						let pendingA = false;
						const sigPaths = [...pathFor.values()];
						for (const t of edges) {
							const vals = await traceBackend.valuesAt(t, sigPaths);
							// Raw scalars, NOT valueHex — its "0x" prefix reads as an
							// unknown bit to hasUnknownBits and skips every edge.
							const byPath = new Map(vals.map((v) => [v.instancePath, String(v.value ?? "")]));
							const cur = new Map<string, string>();
							for (const [n, p] of pathFor) {
								const v = byPath.get(p);
								if (v !== undefined) cur.set(n, v);
							}
							const env: SvaEnv = { cur, prev };
							checked++;
							const disabled = a.disable ? evalSva(a.disable, env) : false;
							if (disabled === true) {
								pendingA = false;
								prev = cur;
								continue;
							}
							if (a.op === "|=>") {
								if (pendingA) {
									const b = evalSva(a.conseq, env);
									if (b === false) failures.push(t);
									else if (b === null) unknown++;
								}
								const aNow = evalSva(a.ante, env);
								pendingA = aNow === true;
								if (aNow === true) anteTrue++;
								else if (aNow === null) unknown++;
							} else {
								const aNow = evalSva(a.ante, env);
								if (aNow === true) {
									anteTrue++;
									const b = evalSva(a.conseq, env);
									if (b === false) failures.push(t);
									else if (b === null) unknown++;
								} else if (aNow === null) {
									unknown++;
								}
							}
							prev = cur;
							if (failures.length >= 20) break;
						}
						const notes: string[] = [];
						if (sampled) notes.push("clock edges from sampling (VCD has no host-side history)");
						if (times.length > kMaxEdges) notes.push(`first ${kMaxEdges} of ${times.length} edges checked`);
						// The clock history itself was capped — say so rather than
						// implying the whole run was covered.
						if (partial) notes.push("clock history capped — only the earliest edges were read");
						if (anteTrue === 0 && a.op !== "|->") notes.push("antecedent never true (vacuous)");
						if (anteTrue === 0 && a.op === "|->" && a.ante !== "1'b1") notes.push("antecedent never true (vacuous)");
						if (unknown > 0) notes.push(`${unknown} edge(s) skipped on x/z`);
						items.push({
							...base,
							clk: a.clk,
							edge: a.edge,
							failures,
							checkedEdges: checked,
							totalEdges: times.length,
							note: notes.join("; "),
						});
					}
					emit({
						command: "assertionResults",
						requestId,
						instancePath: path,
						totalFound: all.length,
						items,
					});
				})().catch((err) => {
					logErr(`standalone-host: checkAssertions failed: ${err instanceof Error ? err.message : err}`);
					emit({
						command: "assertionResults",
						requestId,
						instancePath: path,
						error: `assertion check failed: ${err instanceof Error ? err.message : err}`,
						items: [],
					});
				});
				break;
			}
			// Cone-of-influence: one fan-in level of a signal (from its RTL
			// driver expression) added as a named waveform group. Recursion =
			// run it again on a signal inside the group.
			case "fanInGroup": {
				const requestId = e.requestId;
				const path = String(e.instancePath ?? "");
				const cwd = typeof e.cwd === "string" && e.cwd ? (e.cwd as string) : process.cwd();
				const groupName = String(e.groupName ?? "") || `fan-in: ${path.split(".").pop()}`;
				(async () => {
					// Straight to the RTL: every RHS signal of every assignment to the
					// leaf. Deliberately NOT activeTraceStep — that stops at x sinks /
					// terminals, and an x sink is exactly where a cone matters.
					const node = normalizeInstancePath(path) ?? path.trim();
					const leaf = node.split(".").pop() ?? node;
					const scope = node.split(".").slice(0, -1).join(".");
					const assigns = await findAssignments(leaf, cwd, { cache: rtlCacheFor(cwd) });
					if (!assigns.length) {
						emit({
							command: "fanInResult",
							requestId,
							instancePath: path,
							count: 0,
							note: `no RTL assignment to '${leaf}' found under the workspace`,
						});
						return;
					}
					const primary = assigns[0]!;
					const names = [...new Set(assigns.flatMap((a) => a.rhsSignals))].filter(
						(n) => n && n !== leaf,
					);
					const ids: number[] = [];
					const seenIds = new Set<number>();
					const unresolved: string[] = [];
					for (const name of names) {
						// Sibling in the sink's scope first, then a netlist search
						// (exact leaf, shortest path wins — same rule as name drops).
						let item = scope
							? await document.findTreeItem(`${scope}.${name}`, undefined, undefined)
							: null;
						if (!item) {
							const hits = (await traceBackend.searchSignals(name)).filter(
								(p) => p.split(".").pop() === name,
							);
							const best = hits.sort((a, b) => a.length - b.length)[0];
							if (best) {
								item = await document.findTreeItem(best, undefined, undefined);
							}
						}
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const netlistId = (item as any)?.netlistId;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						if (typeof netlistId === "number" && (item as any)?.contextValue !== "netlistScope") {
							if (!seenIds.has(netlistId)) {
								seenIds.add(netlistId);
								ids.push(netlistId);
							}
						} else {
							unresolved.push(name);
						}
					}
					if (ids.length) {
						// The webview creates the group (uniquifying the name if it
						// collides), then the add targets it by name — both messages
						// travel the same ordered relay, so the group exists first.
						emit({ command: "newSignalGroup", groupName, showRenameInput: false });
						await document.renderSignals(ids, [groupName], undefined);
					}
					emit({
						command: "fanInResult",
						requestId,
						instancePath: path,
						group: groupName,
						count: ids.length,
						unresolved,
						driverExpr: primary.rhsExpr ?? "",
						file: primary.file ?? "",
						line: primary.line ?? 0,
					});
				})().catch((err) => {
					logErr(`standalone-host: fanInGroup failed: ${err instanceof Error ? err.message : err}`);
					emit({
						command: "fanInResult",
						requestId,
						instancePath: path,
						count: 0,
						note: `fan-in failed: ${err instanceof Error ? err.message : err}`,
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
				// Visible time range → windowed waveform loading (large FSDBs).
				// The webview already rate-limits context updates; the handler
				// additionally skips when the loaded window still covers this.
				const sl = Number(ctx.scrollLeft);
				const sr = Number(ctx.scrollRight);
				if (isFinite(sl) && isFinite(sr) && sr > sl) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(document as any).updateRenderViewport(sl, sr);
				}
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
					// Explicit variable drops (rows the user picked by hand) — always honored.
					const directIds: number[] = Array.isArray(e.netlistIdList)
						? (e.netlistIdList as number[]).filter((id) => typeof id === "number")
						: [];
					const paths = Array.isArray(e.instancePathList) ? (e.instancePathList as string[]) : [];

					// Scope drops expand to EVERY variable underneath (recursive), with a
					// hard ceiling: a hierarchy over the limit is blocked outright — no
					// partial subset — because a giant add is a memory + lead-time trap.
					// The limit is shared across all scopes in one drop for the same reason.
					const kMaxScopeSignals = Math.max(
						1,
						Number.parseInt(process.env.CRISP_MAX_SCOPE_SIGNALS ?? "", 10) || 2000,
					);
					const scopeVars: { id: number; path: string }[] = [];
					const blockedScopes: string[] = [];
					let scopesExpanded = 0;
					let firstScopePath = "";
					let budget = kMaxScopeSignals;
					for (const path of paths) {
						if (typeof path !== "string" || !path) {
							continue;
						}
						const item = await document.findTreeItem(path, undefined, undefined);
						if (!item) {
							continue;
						}
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						if ((item as any).contextValue !== "netlistScope") {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const netlistId = (item as any)?.netlistId;
							if (typeof netlistId === "number") {
								directIds.push(netlistId);
							}
							continue;
						}
						// BFS the scope; stop as soon as it exceeds the remaining budget —
						// the exact total of a huge hierarchy is not worth walking for.
						const vars: { id: number; path: string }[] = [];
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const queue: any[] = [item];
						let overflow = false;
						while (queue.length > 0 && !overflow) {
							const scope = queue.shift();
							const children = await document.getScopeChildren(scope);
							for (const child of children) {
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								const c = child as any;
								if (c.contextValue === "netlistScope") {
									queue.push(child);
								} else if (typeof c.netlistId === "number") {
									vars.push({
										id: c.netlistId,
										path: typeof c.instancePath === "function" ? String(c.instancePath()) : "",
									});
									if (vars.length > budget) {
										overflow = true;
										break;
									}
								}
							}
						}
						if (overflow) {
							blockedScopes.push(path);
							continue;
						}
						if (!firstScopePath) {
							firstScopePath = path;
						}
						scopesExpanded++;
						budget -= vars.length;
						scopeVars.push(...vars);
					}

					if (blockedScopes.length > 0) {
						emit({
							command: "scopeDropBlocked",
							blocked: blockedScopes,
							limit: kMaxScopeSignals,
						});
					}

					// Scope expansions skip what is already on screen (a re-drop is a
					// no-op) and dedupe across scopes; explicit variable drops keep
					// today's behavior (add what the user grabbed, duplicates included).
					// Displayed rows come from the host's own context stream — the
					// document's webviewContext is extension-side plumbing and stays
					// empty standalone.
					const displayed = displayedInstancePaths();
					const seenIds = new Set<number>(directIds);
					const seenPaths = new Set<string>();
					const freshScopeIds: number[] = [];
					for (const v of scopeVars) {
						if (seenIds.has(v.id) || (v.path && (displayed.has(v.path) || seenPaths.has(v.path)))) {
							continue;
						}
						seenIds.add(v.id);
						if (v.path) {
							seenPaths.add(v.path);
						}
						freshScopeIds.push(v.id);
					}

					const ids = directIds.concat(freshScopeIds);
					const groupPath = Array.isArray(e.groupPath) ? (e.groupPath as string[]) : undefined;
					const baseIndex = typeof e.dropIndex === "number" ? (e.dropIndex as number) : undefined;
					// Batched add: each chunk lands (and starts fetching waveform data)
					// before the next is queued, so the viewer paints early rows while the
					// rest stream in instead of freezing on one giant synchronous add.
					const kDropBatch = 200;
					for (let i = 0; i < ids.length; i += kDropBatch) {
						const chunk = ids.slice(i, i + kDropBatch);
						await document.renderSignals(
							chunk,
							groupPath,
							baseIndex === undefined ? undefined : baseIndex + i,
						);
						if (ids.length > kDropBatch) {
							emit({
								command: "scopeAddProgress",
								done: Math.min(i + kDropBatch, ids.length),
								total: ids.length,
							});
							await new Promise((resolve) => setImmediate(resolve));
						}
					}
					if (scopesExpanded > 0) {
						emit({
							command: "scopeAdded",
							count: freshScopeIds.length,
							scopes: scopesExpanded,
							instancePath: firstScopePath,
							truncated: false,
						});
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
