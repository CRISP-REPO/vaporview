import type { NetlistId, SignalId } from '../common/types';

// Detect IPC mode (fork) vs stdio mode (SSH spawn)
const hasIPC = typeof process.send === 'function';

function sendMsg(msg: any): void {
    if (hasIPC) {
        process.send!(msg);
    } else {
        process.stdout.write(JSON.stringify(msg) + '\n');
    }
}

let fsdbAddon: any = null;
try {
    fsdbAddon = require('../build/Release/fsdb_reader.node');
    // fsdbAddon = require('../build/Debug/fsdb_reader.node');
    // To debug node module:
    // 1. Build the addon with debug symbols: `node-gyp rebuild --debug`
    // 2. Run the extension and find PID for fsdb_worker.js: `ps aux | grep fsdb_worker`
    // 3. Attach gdb to the worker process: `gdb -p <PID>`
} catch (error) {
    sendMsg({ command: 'require-failed', error: error });
}

console.error("Start FSDB worker" + (hasIPC ? " (IPC)" : " (stdio)"));

function messageHandler(message: any) {
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
                } catch (e: any) {
                    console.error('FSDB worker: failed to parse stdin message:', e.message);
                }
            }
        }
    });
    process.stdin.resume();
}

function handleMessage(message: any) {
    switch (message.command) {
        case 'openFsdb': { fsdbAddon.openFsdb(message.fsdbPath); break; }
        case 'readScopes': { fsdbAddon.readScopes(fsdbScopeCallback, fsdbUpscopeCallback); break; }
        case 'readMetadata': { fsdbAddon.readMetadata(setMetadata, setChunkSize); break; }
        case 'readVars': {
            fsdbAddon.readVars(message.scopePath, message.scopeOffsetIdx, fsdbVarCallback, fsdbArrayBeginCallback, fsdbArrayEndCallback);
            break;
        }
        case 'loadSignals': { fsdbAddon.loadSignals(message.signalIdList); break; }
        case 'getValueChanges': { return fsdbAddon.getValueChanges(message.signalId); }
        case 'getValuesAtTime': { return fsdbAddon.getValuesAtTime(message.signalId, message.time); }
        case 'unloadSignal': { fsdbAddon.unloadSignal(message.signalId); break; }
        case 'setViewWindow': { fsdbAddon.setViewWindow(message.startTime, message.endTime); break; }
        case 'getVarInfo': { return fsdbAddon.getVarInfo(message.signalId); }
        case 'unload': { fsdbAddon.unload(); break; }
    }
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
