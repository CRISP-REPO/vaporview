/**
 * Minimal `vscode` API stand-ins so the vaporview parsing layer
 * (document.ts + wasm_handler.ts + tree_view.ts + terminal_links.ts) can run
 * in a plain Node process instead of the VSCode extension host.
 *
 * esbuild aliases `vscode` to this module for the standalone-host build. Only
 * the surface actually exercised on the VCD/FST (wellen wasm) parse + fetch
 * path is implemented; everything else is a no-op so unrelated code paths
 * (tree view, quick pick, terminal links, fsdb) don't throw if referenced.
 *
 * This is NOT a faithful VSCode emulation — it is the smallest shim that lets
 * the parser produce `update-waveform-chunk*` messages.
 */
import { promises as fsp, statSync, existsSync } from "fs";
import * as nodePath from "path";

/**
 * FSDB reader libs for the standalone FsdbFormatHandler path. Mirrors the
 * CLI's resolution (CRISP_FSDB_READER_LIBS first), then VERDI_HOME with an
 * ARCH-AWARE subdir — the extension's own fallback hardcodes linux64, which
 * is wrong on aarch64 hosts (newer Verdi ships share/FsdbReader/aarch64).
 */
function resolveFsdbReaderLibs(): string | undefined {
	const explicit = process.env.CRISP_FSDB_READER_LIBS;
	if (explicit) {
		return explicit;
	}
	const verdiHome = process.env.VERDI_HOME;
	if (verdiHome) {
		const archDir = process.arch === "arm64" ? "aarch64" : "linux64";
		const primary = nodePath.join(verdiHome, "share", "FsdbReader", archDir);
		if (existsSync(primary)) {
			return primary;
		}
		const alternate = nodePath.join(
			verdiHome, "share", "FsdbReader", archDir === "aarch64" ? "linux64" : "aarch64");
		if (existsSync(alternate)) {
			return alternate;
		}
		return primary; // let the handler's own validation report what's missing
	}
	return undefined; // handler falls back to XCELIUM_HOME etc.
}

/** Host→webview protocol line on stdout (the shim runs inside the host process). */
function emitProtocol(message: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(message) + "\n");
}

// --- Disposable ------------------------------------------------------------

export class Disposable {
	private _callOnDispose?: () => void;
	constructor(callOnDispose?: () => void) {
		this._callOnDispose = callOnDispose;
	}
	dispose(): void {
		this._callOnDispose?.();
		this._callOnDispose = undefined;
	}
	static from(...disposables: { dispose(): unknown }[]): Disposable {
		return new Disposable(() => disposables.forEach((d) => d.dispose()));
	}
}

// --- Uri -------------------------------------------------------------------

export class Uri {
	scheme: string;
	authority = "";
	path: string;
	query = "";
	fragment = "";

	private constructor(scheme: string, path: string) {
		this.scheme = scheme;
		this.path = path;
	}
	get fsPath(): string {
		return this.path;
	}
	toString(): string {
		return `${this.scheme}://${this.path}`;
	}
	with(change: { scheme?: string; path?: string }): Uri {
		return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
	}
	static file(p: string): Uri {
		return new Uri("file", nodePath.resolve(p));
	}
	static parse(value: string): Uri {
		const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
		if (m) {
			return new Uri(m[1], m[2]);
		}
		return Uri.file(value);
	}
	static joinPath(base: Uri, ...segments: string[]): Uri {
		return base.with({ path: nodePath.join(base.path, ...segments) });
	}
}

// --- Configuration ---------------------------------------------------------

/**
 * A few config keys the parse path reads during bootstrap. Anything not listed
 * returns the caller-supplied default (or undefined), which the webview treats
 * as "use built-in default".
 */
const CONFIG_DEFAULTS: Record<string, unknown> = {
	sortNetlist: false,
	customColor5: "#CCCCCC",
	customColor6: "#CCCCCC",
	customColor7: "#CCCCCC",
	customColor8: "#CCCCCC",
	fstMaxStaticLoadSize: 1_000_000_000,
	enableInstancePathTerminalLinks: false,
};

class WorkspaceConfiguration {
	get<T>(key: string, defaultValue?: T): T | undefined {
		if (key === "fsdbReaderLibsPath") {
			return resolveFsdbReaderLibs() as T | undefined;
		}
		if (key in CONFIG_DEFAULTS) {
			return CONFIG_DEFAULTS[key] as T;
		}
		return defaultValue;
	}
	has(): boolean {
		return false;
	}
	inspect(): undefined {
		return undefined;
	}
	async update(): Promise<void> {
		/* persistence is not needed in standalone mode */
	}
}

// --- File system watcher (no-op) -------------------------------------------

class FileSystemWatcher {
	onDidChange(): Disposable {
		return new Disposable();
	}
	onDidCreate(): Disposable {
		return new Disposable();
	}
	onDidDelete(): Disposable {
		return new Disposable();
	}
	dispose(): void {
		/* no-op */
	}
}

export class RelativePattern {
	constructor(public base: string, public pattern: string) {}
}

// --- EventEmitter ----------------------------------------------------------

export class EventEmitter<T> {
	private listeners: ((e: T) => unknown)[] = [];
	event = (listener: (e: T) => unknown): Disposable => {
		this.listeners.push(listener);
		return new Disposable(() => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		});
	};
	fire(data: T): void {
		for (const l of this.listeners.slice()) {
			l(data);
		}
	}
	dispose(): void {
		this.listeners = [];
	}
}

// --- workspace -------------------------------------------------------------

export const workspace = {
	getConfiguration(_section?: string): WorkspaceConfiguration {
		return new WorkspaceConfiguration();
	},
	createFileSystemWatcher(_pattern: unknown): FileSystemWatcher {
		return new FileSystemWatcher();
	},
	fs: {
		async readFile(uri: Uri): Promise<Uint8Array> {
			return new Uint8Array(await fsp.readFile(uri.fsPath));
		},
		async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
			await fsp.writeFile(uri.fsPath, content);
		},
		async stat(uri: Uri): Promise<{ size: number; type: number }> {
			const s = statSync(uri.fsPath);
			return { size: s.size, type: s.isDirectory() ? 2 : 1 };
		},
	},
	workspaceFolders: undefined as unknown[] | undefined,
	getWorkspaceFolder(): undefined {
		return undefined;
	},
};

// --- window ----------------------------------------------------------------

export const window = {
	registerTerminalLinkProvider(): Disposable {
		return new Disposable();
	},
	async withProgress<T>(_options: unknown, task: (progress: { report(v: unknown): void }) => Promise<T>): Promise<T> {
		return task({ report() {} });
	},
	createQuickPick() {
		return {
			items: [] as unknown[],
			onDidChangeValue: () => new Disposable(),
			onDidAccept: () => new Disposable(),
			onDidHide: () => new Disposable(),
			show() {},
			hide() {},
			dispose() {},
		};
	},
	createTreeView() {
		return {
			onDidExpandElement: () => new Disposable(),
			onDidCollapseElement: () => new Disposable(),
			onDidChangeSelection: () => new Disposable(),
			dispose() {},
		};
	},
	createStatusBarItem() {
		return { text: "", tooltip: "", show() {}, hide() {}, dispose() {} };
	},
	// Message dialogs become protocol lines so the desktop app can surface
	// them (the FSDB path reports all its failures through these).
	async showErrorMessage(message?: unknown): Promise<undefined> {
		const text = typeof message === "string" ? message : String(message ?? "");
		process.stderr.write(`[error] ${text}\n`);
		emitProtocol({ command: "showMessage", messageType: "error", message: text });
		return undefined;
	},
	async showWarningMessage(message?: unknown): Promise<undefined> {
		const text = typeof message === "string" ? message : String(message ?? "");
		process.stderr.write(`[warn] ${text}\n`);
		emitProtocol({ command: "showMessage", messageType: "warning", message: text });
		return undefined;
	},
	async showInformationMessage(message?: unknown): Promise<undefined> {
		const text = typeof message === "string" ? message : String(message ?? "");
		process.stderr.write(`[info] ${text}\n`);
		return undefined;
	},
	createOutputChannel(name: string) {
		return {
			name,
			appendLine: (line: string) => process.stderr.write(line + "\n"),
			append: (text: string) => process.stderr.write(text),
			clear() {},
			show() {},
			hide() {},
			dispose() {},
		};
	},
};

// --- commands / env / extensions -------------------------------------------

export const commands = {
	async executeCommand(): Promise<undefined> {
		return undefined;
	},
	registerCommand(): Disposable {
		return new Disposable();
	},
};

export const env = {
	clipboard: {
		async writeText(): Promise<void> {},
		async readText(): Promise<string> {
			return "";
		},
	},
	openExternal: async () => true,
};

export const extensions = {
	getExtension(_id: string) {
		return { packageJSON: { version: "0.0.0" }, isActive: true };
	},
};

// --- presentation primitives (used by tree_view / terminal_links) ----------

export class ThemeIcon {
	static readonly File = new ThemeIcon("file");
	static readonly Folder = new ThemeIcon("folder");
	constructor(public id: string, public color?: unknown) {}
}

export class ThemeColor {
	constructor(public id: string) {}
}

export class TreeItem {
	label: unknown;
	collapsibleState: number;
	constructor(label: unknown, collapsibleState = 0) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

export class MarkdownString {
	value: string;
	constructor(value = "") {
		this.value = value;
	}
	appendText(t: string): this {
		this.value += t;
		return this;
	}
	appendMarkdown(t: string): this {
		this.value += t;
		return this;
	}
}

export class Position {
	constructor(public line: number, public character: number) {}
}
export class Range {
	constructor(public start: Position, public end: Position) {}
}

// --- enums -----------------------------------------------------------------

export enum TreeItemCollapsibleState {
	None = 0,
	Collapsed = 1,
	Expanded = 2,
}

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3,
}

export enum ViewColumn {
	Active = -1,
	Beside = -2,
	One = 1,
}

export enum ProgressLocation {
	SourceControl = 1,
	Window = 10,
	Notification = 15,
}

export enum FileType {
	Unknown = 0,
	File = 1,
	Directory = 2,
	SymbolicLink = 64,
}

// Namespace default export so `import * as vscode from 'vscode'` works.
export default {
	Disposable,
	Uri,
	RelativePattern,
	EventEmitter,
	workspace,
	window,
	commands,
	env,
	extensions,
	ThemeIcon,
	ThemeColor,
	TreeItem,
	MarkdownString,
	Position,
	Range,
	TreeItemCollapsibleState,
	ConfigurationTarget,
	ViewColumn,
	ProgressLocation,
	FileType,
};
