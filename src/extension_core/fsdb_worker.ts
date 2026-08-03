import type { NetlistId, SignalId } from '../common/types';
import type { FsdbWaveformData, FsdbWorkerIpcMessage } from './fsdb_types';

// Detect IPC mode (fork) vs stdio mode (SSH spawn)
const hasIPC = typeof process.send === 'function';

function sendMsg(msg: unknown): void {
    if (hasIPC) {
        process.send!(msg);
    } else {
        process.stdout.write(JSON.stringify(msg) + '\n');
    }
}

interface FsdbAddon {
    openFsdb(fsdbPath: string): void;
    readScopes(scopeCallback: (name: string, type: string, path: string, netlistId: number, scopeOffsetIdx: number) => void, upscopeCallback: () => void): void;
    readMetadata(setMetadataFn: (...args: Parameters<typeof setMetadata>) => void, setChunkSizeFn: (chunksize: number, timeend: number) => void): void;
    readVars(scopePath: string, scopeOffsetIdx: number, varCallback: (...args: Parameters<typeof fsdbVarCallback>) => void, arrayBeginCallback: (name: string, path: string, netlistId: number) => void, arrayEndCallback: (size: number) => void): void;
    loadSignals(signalIdList: number[]): void;
    getValueChanges(signalId: number, maxTransitions?: number): FsdbWaveformData;
    getValuesAtTime(signalId: number, time: number): string | string[];
    unloadSignal(signalId: number): void;
    setViewWindow(startTime: number, endTime: number): void;
    getVarInfo(signalId: number): string | string[];
    unload(): void;
}

let vcCapSupported: boolean | null = null;
let fsdbAddon: FsdbAddon | null = null;
try {
    // CRISP_FSDB_ADDON points at a prebuilt fsdb_reader.node (e.g. the Crisp
    // CLI's auto-build under <workspace>/.crisp-fsdb) — takes precedence over
    // the in-tree build. Dynamic require: esbuild leaves it for runtime.
    const addonOverride = process.env.CRISP_FSDB_ADDON;
    fsdbAddon = addonOverride
        ? require(addonOverride)
        : require('../build/Release/fsdb_reader.node');
    // fsdbAddon = require('../build/Debug/fsdb_reader.node');
    // To debug node module:
    // 1. Build the addon with debug symbols: `node-gyp rebuild --debug`
    // 2. Run the extension and find PID for fsdb_worker.js: `ps aux | grep fsdb_worker`
    // 3. Attach gdb to the worker process: `gdb -p <PID>`
} catch (error: unknown) {
    sendMsg({ command: 'require-failed', error: error });
}

console.error("Start FSDB worker" + (hasIPC ? " (IPC)" : " (stdio)"));

function messageHandler(message: FsdbWorkerIpcMessage) {
    const result = handleMessage(message);
    sendMsg({ id: message.id, result: result });
}

// Listen for messages: IPC channel or stdin
if (hasIPC) {
    process.on('message', messageHandler);
} else {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) {
                try {
                    messageHandler(JSON.parse(line));
                } catch (e) {
                    console.error('FSDB worker: failed to parse stdin message:', (e as Error).message);
                }
            }
        }
    });
    process.stdin.resume();
}

function handleMessage(message: FsdbWorkerIpcMessage): FsdbWaveformData | string | string[] | undefined {
    if (!fsdbAddon) { return undefined; }
    switch (message.command) {
        case 'openFsdb': { fsdbAddon.openFsdb(message.fsdbPath); break; }
        case 'readScopes': { fsdbAddon.readScopes(fsdbScopeCallback, fsdbUpscopeCallback); break; }
        case 'readMetadata': { fsdbAddon.readMetadata(setMetadata, setChunkSize); break; }
        case 'readVars': {
            fsdbAddon.readVars(message.scopePath, message.scopeOffsetIdx, fsdbVarCallback, fsdbArrayBeginCallback, fsdbArrayEndCallback);
            break;
        }
        case 'loadSignals': { fsdbAddon.loadSignals(message.signalIdList); break; }
        case 'getValueChanges': {
            const maxTransitions = message.maxTransitions ?? 0;
            // Prebuilt addons from before the decimation change reject a 2nd
            // argument ("Incorrect number of arguments") — detect once and
            // fall back to the uncapped single-argument form.
            if (maxTransitions > 0 && vcCapSupported !== false) {
                try {
                    const r = fsdbAddon.getValueChanges(message.signalId, maxTransitions);
                    vcCapSupported = true;
                    return r;
                } catch (e) {
                    if (vcCapSupported === true) { throw e; }
                    vcCapSupported = false;
                    console.error('FSDB worker: addon predates maxTransitions — loading uncapped');
                }
            }
            return fsdbAddon.getValueChanges(message.signalId);
        }
        case 'getValuesAtTime': { return fsdbAddon.getValuesAtTime(message.signalId, message.time); }
        case 'unloadSignal': { fsdbAddon.unloadSignal(message.signalId); break; }
        case 'setViewWindow': { fsdbAddon.setViewWindow(message.startTime, message.endTime); break; }
        case 'getVarInfo': { return fsdbAddon.getVarInfo(message.signalId); }
        case 'unload': { fsdbAddon.unload(); break; }
    }
    return undefined;
}

function fsdbScopeCallback(name: string, type: string, path: string, netlistId: number, scopeOffsetIdx: number) {
    sendMsg({
        command: 'fsdb-scope-callback',
        name: name,
        type: type,
        path: path,
        netlistId: netlistId,
        scopeOffsetIdx: scopeOffsetIdx
    });
}

function fsdbUpscopeCallback() {
    sendMsg({
        command: 'fsdb-upscope-callback'
    });
}

function setMetadata(scopecount: number, varcount: number, timescale: number, timeunit: string, fileType: string, simVersion: string, simDate: string, maxVarIdcode: number) {
    sendMsg({
        command: 'setMetadata',
        scopecount: scopecount,
        varcount: varcount,
        timescale: timescale,
        timeunit: timeunit,
        fileType: fileType,
        simVersion: simVersion,
        simDate: simDate,
        maxVarIdcode: maxVarIdcode
    });
}

function setChunkSize(chunksize: number, timeend: number) {
    sendMsg({
        command: 'setChunkSize',
        chunksize: chunksize,
        timeend: timeend
    });
}

function fsdbVarCallback(name: string, type: string, encoding: string, path: string, netlistId: NetlistId, signalId: SignalId, width: number, msb: number, lsb: number) {
    sendMsg({
        command: 'fsdb-var-callback',
        name: name,
        type: type,
        encoding: encoding,
        path: path,
        netlistId: netlistId,
        signalId: signalId,
        width: width,
        msb: msb,
        lsb: lsb
    });
}

function fsdbArrayBeginCallback(name: string, path: string, netlistId: number) {
    sendMsg({
        command: 'fsdb-array-begin-callback',
        name: name,
        path: path,
        netlistId: netlistId
    });
}

function fsdbArrayEndCallback(size: number) {
    sendMsg({
        command: 'fsdb-array-end-callback',
        size: size,
    });
}
