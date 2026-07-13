import * as vscode from 'vscode';
import type { EnumQueueEntry, SignalId, NetlistId, ValueChangeDataChunk, WaveformDumpMetadata } from '../common/types';
import { type ChildProcess, fork, exec, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

import type { VaporviewDocumentDelegate } from './viewer_provider';
import { type NetlistItem, createScope, createVar } from './tree_view';
import type { WaveformFileParser, NetlistSearchResult, NetlistSearchEntry } from './document';
import type { ValuesAtTimeResult } from '../../packages/vaporview-api/types';
import type { FsdbWaveformData, FsdbWorkerCommand } from './fsdb_types';

// Response to a callFsdbWorkerTask request (matched by id)
type FsdbWorkerResponse = {
  id: string;
  result?: unknown;
  error?: unknown;
};

// Callback messages sent by the worker (no matching id)
type FsdbRequireFailedMessage = {
  command: 'require-failed';
  error: { code?: string };
};

type FsdbScopeCallbackMessage = {
  command: 'fsdb-scope-callback';
  name: string;
  type: string;
  path: string;
  netlistId: number;
  scopeOffsetIdx: number;
};

type FsdbUpscopeCallbackMessage = {
  command: 'fsdb-upscope-callback';
};

type FsdbSetMetadataMessage = {
  command: 'setMetadata';
  scopecount: number;
  varcount: number;
  timescale: number;
  timeunit: string;
  fileType?: string;
  simVersion?: string;
  simDate?: string;
  maxVarIdcode?: number;
};

type FsdbSetChunkSizeMessage = {
  command: 'setChunkSize';
  chunksize: number;
  timeend: number;
  timetablelength?: number;
};

type FsdbVarCallbackMessage = {
  command: 'fsdb-var-callback';
  name: string;
  type: string;
  encoding: string;
  path: string;
  netlistId: number;
  signalId: number;
  width: number;
  msb: number;
  lsb: number;
};

type FsdbArrayBeginCallbackMessage = {
  command: 'fsdb-array-begin-callback';
  name: string;
  path: string;
  netlistId: number;
};

type FsdbArrayEndCallbackMessage = {
  command: 'fsdb-array-end-callback';
  size: number;
};

type FsdbWorkerCallback =
  | FsdbRequireFailedMessage
  | FsdbScopeCallbackMessage
  | FsdbUpscopeCallbackMessage
  | FsdbSetMetadataMessage
  | FsdbSetChunkSizeMessage
  | FsdbVarCallbackMessage
  | FsdbArrayBeginCallbackMessage
  | FsdbArrayEndCallbackMessage;

type FsdbWorkerMessage = FsdbWorkerResponse | FsdbWorkerCallback;


export class FsdbFormatHandler implements WaveformFileParser {
  private providerDelegate: VaporviewDocumentDelegate;
  private uri: vscode.Uri;
  private fsdbWorker: ChildProcess | undefined = undefined;
  private fsdbTopModuleCount: number = 0;
  private fsdbCurrentScope: NetlistItem | undefined = undefined;
  // Need a reference to findTreeItem for getValuesAtTime
  public findTreeItemFn: (scopePath: string, msb: number | undefined, lsb: number | undefined) => Promise<NetlistItem | null>;

  // SSH remote mode
  private isSSHRemote: boolean = false;
  private sshHost: string = '';
  private remoteWorkerDir: string = '';
  private stdioMessageListeners: Array<(msg: any) => void> = [];
  private readonly sshOpts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];

  // Top level netlist items
  public netlistSearchable: boolean = false;
  private netlistTop: NetlistItem[] = [];
  private parametersLoaded: boolean = false;

  public postMessageToWebview = (_message: Record<string, unknown>) => {};
  public metadata: WaveformDumpMetadata = {
    timeTableLoaded: false,
    scopeCount: 0,
    netlistIdCount: 0,
    signalIdCount: 0,
    timeTableCount: 0,
    timeEnd: 0,
    minTimeStep: 1,
    timeScale: 1,
    timeUnit: "ns",
  };

  constructor(
    providerDelegate: VaporviewDocumentDelegate,
    uri: vscode.Uri,
    findTreeItemFn: (scopePath: string, msb: number | undefined, lsb: number | undefined) => Promise<NetlistItem | null>,
  ) {
    this.providerDelegate = providerDelegate;
    this.uri = uri;
    this.findTreeItemFn = findTreeItemFn;
  }

  // #region SSH Remote Methods

  private detectSSHRemote(): { sshHost: string } | undefined {
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
    const uriAuthority = this.uri.authority;
    if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:detectSSH] platform=${process.platform}, uri.scheme=${this.uri.scheme}, uri.authority=${uriAuthority}`); }
    if (process.platform === 'linux') {
      if (_dwf) { this.providerDelegate.logOutputChannel('[WF:detectSSH] platform is linux — local mode'); }
      return undefined;
    }
    if (uriAuthority && uriAuthority.startsWith('ssh-remote+')) {
      const host = uriAuthority.replace('ssh-remote+', '');
      if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:detectSSH] SSH remote detected — host=${host}`); }
      return { sshHost: host };
    }
    if (_dwf) { this.providerDelegate.logOutputChannel('[WF:detectSSH] not linux and not SSH remote — no FSDB support'); }
    return undefined;
  }

  private async sshExec(sshHost: string, command: string, opts?: { stdin?: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
    // If SSH auth already failed, go directly to task-based fallback
    if (this.sshAuthFailed && this.remoteWorkerDir) {
      return this.remoteTaskExec(command, this.remoteWorkerDir, opts);
    }

    const result = await this.sshExecDirect(sshHost, command, opts);

    // Detect SSH auth failure and retry via task-based fallback
    if (result.code === 255 && result.stderr.includes('Permission denied') && this.remoteWorkerDir) {
      const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
      log('[WF:sshExec] direct SSH auth failed — falling back to VS Code task execution');
      this.sshAuthFailed = true;
      return this.remoteTaskExec(command, this.remoteWorkerDir, opts);
    }

    return result;
  }

  private sshExecDirect(sshHost: string, command: string, opts?: { stdin?: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    const timeoutMs = opts?.timeoutMs ?? 30000;

    return new Promise((resolve) => {
      let args: string[];
      let spawnOpts: any;
      if (opts?.stdin) {
        args = [...this.sshOpts, sshHost, 'bash -s'];
        spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
      } else {
        args = [...this.sshOpts, sshHost, command];
        spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
      }
      log(`[WF:sshExec] spawn ssh ${args.join(' ')} (timeout=${timeoutMs}ms)`);

      let proc: ChildProcess;
      try {
        proc = spawn('ssh', args, spawnOpts);
      } catch (e: any) {
        log(`[FSDB:SSH] failed to spawn ssh: ${e.message}`);
        resolve({ ok: false, stdout: '', stderr: `spawn failed: ${e.message}`, code: null });
        return;
      }
      log(`[WF:sshExec] spawned pid=${proc.pid} stdout=${!!proc.stdout} stderr=${!!proc.stderr} stdin=${!!proc.stdin}`);

      if (opts?.stdin) {
        proc.stdin!.write(opts.stdin);
        proc.stdin!.end();
      }

      let stdout = '', stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          log(`[FSDB:SSH] command timed out after ${timeoutMs}ms — killing process`);
          proc.kill('SIGKILL');
          resolve({ ok: false, stdout, stderr: stderr + '\n[TIMED OUT]', code: null });
        }
      }, timeoutMs);

      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (_dwf) { log(`[WF:sshExec] spawn error: ${err.message}`); }
          resolve({ ok: false, stdout, stderr: `spawn error: ${err.message}`, code: null });
        }
      });
      proc.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (_dwf) { log(`[WF:sshExec] exited code=${code}`); }
          resolve({ ok: code === 0, stdout, stderr, code });
        }
      });
    });
  }

  /** Whether direct SSH has been tested and failed (auth issue) — skip SSH for remaining calls */
  private sshAuthFailed: boolean = false;

  /**
   * Execute a command on the remote via VS Code Task API.
   * Works regardless of SSH auth method since tasks run through VS Code's remote connection.
   * Captures stdout/stderr/exit code via temp files read back with vscode.workspace.fs.
   */
  private async remoteTaskExec(command: string, remoteDir: string, opts?: { stdin?: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
    const timeoutMs = opts?.timeoutMs ?? 30000;

    const uid = Date.now().toString(36);
    const stdoutFile = `${remoteDir}/.cmd-stdout-${uid}`;
    const stderrFile = `${remoteDir}/.cmd-stderr-${uid}`;
    const exitFile = `${remoteDir}/.cmd-exit-${uid}`;

    // Ensure remote dir exists (may not yet if this is the first call)
    try {
      await vscode.workspace.fs.createDirectory(this.remoteUri(remoteDir));
    } catch { /* already exists — fine */ }

    // Write a wrapper script that captures output
    const cmdBody = opts?.stdin ? opts.stdin : command;
    const script = [
      '#!/bin/bash',
      `(${cmdBody}) > "${stdoutFile}" 2> "${stderrFile}"`,
      `echo $? > "${exitFile}"`,
    ].join('\n');
    const scriptFile = `${remoteDir}/.cmd-run-${uid}.sh`;

    try {
      await vscode.workspace.fs.writeFile(this.remoteUri(scriptFile), Buffer.from(script, 'utf-8'));
    } catch (err: any) {
      log(`[WF:remoteTaskExec] failed to write script: ${err.message}`);
      return { ok: false, stdout: '', stderr: `failed to write script: ${err.message}`, code: null };
    }

    if (_dwf) { log(`[WF:remoteTaskExec] executing via task: bash ${scriptFile}`); }

    // Execute via VS Code Task API — runs on remote through VS Code's connection
    const taskDef: vscode.TaskDefinition = { type: 'shell', id: `crisp-fsdb-${uid}` };
    const task = new vscode.Task(
      taskDef,
      vscode.TaskScope.Workspace,
      `FSDB build ${uid}`,
      'crisp-fsdb',
      new vscode.ShellExecution(`bash "${scriptFile}"`)
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, echo: false, showReuseMessage: false };
    task.isBackground = false;

    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        disposable.dispose();
        reject(new Error(`task timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const disposable = vscode.tasks.onDidEndTaskProcess(e => {
        if (e.execution.task.name === task.name) {
          clearTimeout(timer);
          disposable.dispose();
          resolve();
        }
      });
    });

    try {
      await vscode.tasks.executeTask(task);
      await completed;
    } catch (err: any) {
      log(`[WF:remoteTaskExec] task execution failed: ${err.message}`);
      return { ok: false, stdout: '', stderr: `task execution failed: ${err.message}`, code: null };
    }

    // Read results
    let stdout = '', stderr = '', exitCode: number | null = null;
    try {
      const exitStr = Buffer.from(await vscode.workspace.fs.readFile(this.remoteUri(exitFile))).toString('utf-8').trim();
      exitCode = parseInt(exitStr, 10);
    } catch { /* no exit file means something went very wrong */ }
    try {
      stdout = Buffer.from(await vscode.workspace.fs.readFile(this.remoteUri(stdoutFile))).toString('utf-8');
    } catch { /* empty */ }
    try {
      stderr = Buffer.from(await vscode.workspace.fs.readFile(this.remoteUri(stderrFile))).toString('utf-8');
    } catch { /* empty */ }

    // Clean up temp files (fire-and-forget)
    for (const f of [scriptFile, stdoutFile, stderrFile, exitFile]) {
      vscode.workspace.fs.delete(this.remoteUri(f)).then(() => {}, () => {});
    }

    if (_dwf) { log(`[WF:remoteTaskExec] done: code=${exitCode} stdout=${stdout.length}b stderr=${stderr.length}b`); }
    return { ok: exitCode === 0, stdout, stderr, code: exitCode };
  }

  private remoteUri(remotePath: string): vscode.Uri {
    return vscode.Uri.parse(`vscode-remote://ssh-remote+${this.sshHost}${remotePath}`);
  }

  private async deployRemoteWorker(sshHost: string, fsdbLibsPath: string): Promise<string | undefined> {
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';

    // Use workspace folder path instead of /tmp to avoid permission/path issues
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const wsPath = wsFolder ? wsFolder.uri.path : '/tmp';
    const remoteDir = `${wsPath}/.crisp-fsdb`;

    const localWorkerPath = path.resolve(__dirname, 'fsdb_worker.js');
    if (_dwf) { log(`[WF:deployRemote] localWorkerPath=${localWorkerPath} exists=${fs.existsSync(localWorkerPath)}`); }
    if (!fs.existsSync(localWorkerPath)) {
      log(`[FSDB:SSH] local worker not found at ${localWorkerPath}`);
      vscode.window.showErrorMessage('FSDB worker file not found in extension bundle.');
      return undefined;
    }
    const workerContent = fs.readFileSync(localWorkerPath, 'utf-8');
    if (_dwf) { log(`[WF:deployRemote] workerContent length=${workerContent.length}`); }

    const localCppPath = path.resolve(__dirname, '..', 'src', 'fsdb_reader.cpp');
    const hasCpp = fs.existsSync(localCppPath);
    if (_dwf) { log(`[WF:deployRemote] localCppPath=${localCppPath} exists=${hasCpp}`); }
    const cppContent = hasCpp ? fs.readFileSync(localCppPath, 'utf-8') : '';

    // Locate node-addon-api headers bundled with the extension
    // Try node_modules first, then dist/napi/ (copied by esbuild plugin)
    let napiDir = path.resolve(__dirname, '..', 'node_modules', 'node-addon-api');
    if (!fs.existsSync(path.join(napiDir, 'napi.h'))) {
      napiDir = path.resolve(__dirname, 'napi');
    }
    const napiHeaders = ['napi.h', 'napi-inl.h', 'napi-inl.deprecated.h'];
    const napiIndex = path.join(napiDir, 'index.js');
    const hasNapi = fs.existsSync(path.join(napiDir, 'napi.h'));
    if (_dwf) { log(`[WF:deployRemote] napiDir=${napiDir} exists=${hasNapi}`); }

    log(`[FSDB:SSH] deploying to ${sshHost}:${remoteDir} via VS Code remote filesystem`);

    try {
      await vscode.workspace.fs.createDirectory(this.remoteUri(`${remoteDir}/dist`));
      if (hasCpp) {
        await vscode.workspace.fs.createDirectory(this.remoteUri(`${remoteDir}/src`));
      }
      // Deploy node-addon-api headers so we don't need npm install on the remote
      if (hasNapi) {
        await vscode.workspace.fs.createDirectory(this.remoteUri(`${remoteDir}/node_modules/node-addon-api`));
      }
      if (_dwf) { log('[WF:deployRemote] remote directories created'); }

      await vscode.workspace.fs.writeFile(
        this.remoteUri(`${remoteDir}/dist/fsdb_worker.js`),
        Buffer.from(workerContent, 'utf-8')
      );
      if (_dwf) { log('[WF:deployRemote] fsdb_worker.js deployed'); }

      if (hasCpp) {
        await vscode.workspace.fs.writeFile(
          this.remoteUri(`${remoteDir}/src/fsdb_reader.cpp`),
          Buffer.from(cppContent, 'utf-8')
        );
        if (_dwf) { log('[WF:deployRemote] fsdb_reader.cpp deployed'); }
      }

      // Deploy node-addon-api: headers + index.js + package.json
      if (hasNapi) {
        for (const hdr of napiHeaders) {
          const hdrPath = path.join(napiDir, hdr);
          if (fs.existsSync(hdrPath)) {
            await vscode.workspace.fs.writeFile(
              this.remoteUri(`${remoteDir}/node_modules/node-addon-api/${hdr}`),
              fs.readFileSync(hdrPath)
            );
          }
        }
        // index.js and package.json are needed for require('node-addon-api').include
        for (const f of ['index.js', 'package.json']) {
          const fPath = path.join(napiDir, f);
          if (fs.existsSync(fPath)) {
            await vscode.workspace.fs.writeFile(
              this.remoteUri(`${remoteDir}/node_modules/node-addon-api/${f}`),
              fs.readFileSync(fPath)
            );
          }
        }
        // Deploy Node.js N-API core headers (bundled in dist/napi/ at build time)
        const nodeApiHeaders = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
        for (const hdr of nodeApiHeaders) {
          const hdrPath = path.join(napiDir, hdr);
          if (fs.existsSync(hdrPath)) {
            await vscode.workspace.fs.writeFile(
              this.remoteUri(`${remoteDir}/node_modules/node-addon-api/${hdr}`),
              fs.readFileSync(hdrPath)
            );
          }
        }
        if (_dwf) { log('[WF:deployRemote] node-addon-api deployed'); }
      }
      log(`[FSDB:SSH] deploy SUCCESS`);
    } catch (err: any) {
      log(`[FSDB:SSH] deploy via vscode.workspace.fs failed: ${err.message}`);
      vscode.window.showErrorMessage(`Failed to deploy FSDB worker to remote: ${err.message}`);
      return undefined;
    }

    // Only rebuild if source has changed: compare hash of cpp content with stored marker
    const sourceHash = crypto.createHash('sha1').update(cppContent).digest('hex');
    const hashMarkerUri = this.remoteUri(`${remoteDir}/build/.source_hash`);
    let needsRebuild = true;
    try {
      const remoteHash = Buffer.from(await vscode.workspace.fs.readFile(hashMarkerUri)).toString('utf-8').trim();
      needsRebuild = remoteHash !== sourceHash;
      if (_dwf) { log(`[WF:deployRemote] source hash: local=${sourceHash} remote=${remoteHash} needsRebuild=${needsRebuild}`); }
    } catch {
      if (_dwf) { log(`[WF:deployRemote] no source hash marker found — will build`); }
    }

    if (needsRebuild) {
      // Delete old addon to force rebuild
      try {
        await vscode.workspace.fs.delete(this.remoteUri(`${remoteDir}/build/Release/fsdb_reader.node`));
        if (_dwf) { log('[WF:deployRemote] deleted old addon to force rebuild'); }
      } catch { /* doesn't exist — fine */ }
    }

    if (_dwf) { log('[WF:deployRemote] checking/building remote addon...'); }
    const addonBuilt = await this.ensureRemoteAddon(sshHost, remoteDir, fsdbLibsPath);
    if (_dwf) { log(`[WF:deployRemote] ensureRemoteAddon returned ${addonBuilt}`); }
    if (!addonBuilt) { return undefined; }

    // Store source hash so we skip rebuild next time if unchanged
    if (needsRebuild) {
      try {
        await vscode.workspace.fs.createDirectory(this.remoteUri(`${remoteDir}/build`));
        await vscode.workspace.fs.writeFile(hashMarkerUri, Buffer.from(sourceHash, 'utf-8'));
      } catch { /* non-critical */ }
    }

    return remoteDir;
  }

  private async ensureRemoteAddon(sshHost: string, remoteDir: string, fsdbLibsPath: string): Promise<boolean> {
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';

    const addonRemotePath = `${remoteDir}/build/Release/fsdb_reader.node`;
    if (_dwf) { log(`[WF:remoteAddon] checking remote addon via vscode.workspace.fs: ${addonRemotePath}`); }
    try {
      await vscode.workspace.fs.stat(this.remoteUri(addonRemotePath));
      log(`[FSDB:SSH] addon already exists on remote`);
      return true;
    } catch {
      // File does not exist — proceed with build
    }
    log(`[FSDB:SSH] addon not found on remote — will attempt build`);

    let headerResult = '';
    const posixPath = path.posix;
    if (fsdbLibsPath.includes('/share/FsdbReader/')) {
      headerResult = posixPath.dirname(fsdbLibsPath);
    } else if (fsdbLibsPath.includes('/tools.lnx86/')) {
      const toolsIdx = fsdbLibsPath.indexOf('/tools.lnx86/');
      headerResult = fsdbLibsPath.substring(0, toolsIdx) + '/tools.lnx86/include';
    }
    if (_dwf) { log(`[WF:remoteAddon] derived headerPath=${headerResult || '(empty)'} from fsdbLibsPath=${fsdbLibsPath}`); }

    if (!headerResult) {
      log(`[FSDB:SSH] cannot derive header path from fsdbLibsPath=${fsdbLibsPath}`);
      vscode.window.showErrorMessage(
        'Cannot determine FSDB header path from libraries path. ' +
        'Ensure vaporview.fsdbReaderLibsPath is set to a valid Verdi (.../share/FsdbReader/linux64) ' +
        'or Xcelium (.../tools.lnx86/lib/64bit) libraries path.'
      );
      return false;
    }

    try {
      await vscode.workspace.fs.stat(this.remoteUri(headerResult));
      if (_dwf) { log(`[WF:remoteAddon] header path verified on remote`); }
    } catch {
      log(`[FSDB:SSH] header path ${headerResult} not found on remote`);
      vscode.window.showErrorMessage(
        `FSDB header directory not found at ${headerResult} on ${sshHost}. ` +
        'Check that vaporview.fsdbReaderLibsPath points to a valid FSDB installation.'
      );
      return false;
    }

    // Check internet connectivity on remote to decide build strategy
    const inetCheck = await this.sshExec(sshHost, 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/ 2>/dev/null || echo "no_internet"', { timeoutMs: 10000 });
    const hasInternet = inetCheck.ok && inetCheck.stdout.trim().startsWith('2');
    log(`[WF:remoteAddon] internet check: hasInternet=${hasInternet} (response='${inetCheck.stdout.trim()}')`);

    const buildStartTime = Date.now();

    if (hasInternet) {
      // — Online path: use npm + node-gyp (original approach) —
      log('[WF:remoteAddon] internet available — using npm/node-gyp build');

      const bindingGyp = JSON.stringify({
        variables: { FSDB_READER_LIBS_PATH: fsdbLibsPath, FSDB_HEADER_PATH: headerResult },
        targets: [{
          target_name: "fsdb_reader",
          "cflags!": ["-fno-exceptions"], cflags: ["-fPIC"],
          "cflags_cc!": ["-fno-exceptions"], cflags_cc: ["-fPIC"],
          sources: ["src/fsdb_reader.cpp"],
          include_dirs: [
            "<!@(node -p \"require('node-addon-api').include\")",
            "<(FSDB_HEADER_PATH)>"
          ],
          defines: ["NAPI_DISABLE_CPP_EXCEPTIONS"],
          ldflags: ["-L<(FSDB_READER_LIBS_PATH)>", "-static-libstdc++"],
          libraries: ["-lnffr", "-lnsys"]
        }]
      }, null, 2);
      if (_dwf) { log(`[WF:remoteAddon] binding.gyp:\n${bindingGyp}`); }

      try {
        await vscode.workspace.fs.writeFile(
          this.remoteUri(`${remoteDir}/binding.gyp`),
          Buffer.from(bindingGyp, 'utf-8')
        );
        if (_dwf) { log('[WF:remoteAddon] binding.gyp deployed via remote fs'); }
      } catch (err: any) {
        log(`[FSDB:SSH] failed to write binding.gyp: ${err.message}`);
        return false;
      }

      const buildResult = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Building FSDB reader addon on remote (this may take a minute)...",
        cancellable: false
      }, async () => {
        const npmRes = await this.sshExec(sshHost, `cd ${remoteDir} && npm install node-addon-api 2>&1`, { timeoutMs: 120000 });
        if (!npmRes.ok) { return npmRes; }
        return this.sshExec(sshHost, `cd ${remoteDir} && npx node-gyp rebuild 2>&1`, { timeoutMs: 120000 });
      });

      const elapsed = ((Date.now() - buildStartTime) / 1000).toFixed(1);
      if (!buildResult.ok) {
        log(`[FSDB:SSH] remote build FAILED after ${elapsed}s (exit ${buildResult.code})`);
        log(`[FSDB:SSH] build output:\n${buildResult.stdout}`);
        if (buildResult.stderr.trim()) { log(`[FSDB:SSH] build stderr:\n${buildResult.stderr}`); }
        vscode.window.showErrorMessage('Failed to build FSDB addon on remote. Check Vaporview output for details.');
      } else {
        log(`[FSDB:SSH] remote build SUCCESS after ${elapsed}s`);
        if (_dwf) { log(`[WF:remoteAddon] build output:\n${buildResult.stdout}`); }
      }
      return buildResult.ok;

    } else {
      // — Offline path: compile directly with g++ (no internet required) —
      log('[WF:remoteAddon] no internet — using direct g++ compilation');

      const napiInclude = `${remoteDir}/node_modules/node-addon-api`;
      const nodeIncludeCmd = `node -e "console.log(require('path').resolve(process.execPath, '..', '..', 'include', 'node'))"`;
      const nodeIncResult = await this.sshExec(sshHost, nodeIncludeCmd, { timeoutMs: 10000 });
      const nodeInclude = nodeIncResult.ok ? nodeIncResult.stdout.trim() : '';
      if (_dwf) { log(`[WF:remoteAddon] node include path: '${nodeInclude}' (ok=${nodeIncResult.ok})`); }

      // Verify node include path has headers; if not, we rely on bundled N-API headers in napiInclude
      let nodeIncludeValid = false;
      if (nodeInclude) {
        const checkResult = await this.sshExec(sshHost, `test -f "${nodeInclude}/node_api.h" && echo ok`, { timeoutMs: 5000 });
        nodeIncludeValid = checkResult.ok && checkResult.stdout.trim() === 'ok';
        if (_dwf) { log(`[WF:remoteAddon] node include has headers: ${nodeIncludeValid}`); }
        if (!nodeIncludeValid) {
          log(`[WF:remoteAddon] node headers not found at ${nodeInclude} — using bundled N-API headers`);
        }
      }

      const outputDir = `${remoteDir}/build/Release`;
      const outputFile = `${outputDir}/fsdb_reader.node`;
      const includePaths = [
        ...(nodeIncludeValid ? [`-I"${nodeInclude}"`] : []),
        `-I"${napiInclude}"`,
        `-I"${headerResult}"`,
      ];
      const gppCmd = [
        `mkdir -p ${outputDir}`,
        // Source file BEFORE -l flags (gcc processes left-to-right; --as-needed discards libs with no pending refs)
        `&& g++ -shared -fPIC -std=c++17 -DNAPI_DISABLE_CPP_EXCEPTIONS`,
        ...includePaths,
        `-o "${outputFile}"`,
        `"${remoteDir}/src/fsdb_reader.cpp"`,
        `-L"${fsdbLibsPath}"`,
        `-Wl,-rpath,"${fsdbLibsPath}"`,
        `-lnffr -lnsys`,
        `-static-libstdc++`,
        `2>&1`,
      ].join(' ');
      if (_dwf) { log(`[WF:remoteAddon] compile cmd: ${gppCmd}`); }

      log('[WF:remoteAddon] compiling FSDB addon on remote...');
      const buildResult = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Building FSDB reader addon on remote...",
        cancellable: false
      }, () => {
        return this.sshExec(sshHost, gppCmd, { timeoutMs: 120000 });
      });

      const elapsed = ((Date.now() - buildStartTime) / 1000).toFixed(1);
      if (!buildResult.ok) {
        log(`[FSDB:SSH] remote build FAILED after ${elapsed}s (exit ${buildResult.code})`);
        log(`[FSDB:SSH] build output:\n${buildResult.stdout}`);
        if (buildResult.stderr.trim()) { log(`[FSDB:SSH] build stderr:\n${buildResult.stderr}`); }
        vscode.window.showErrorMessage('Failed to build FSDB addon on remote. Check Vaporview output for details.');
      } else {
        log(`[FSDB:SSH] remote build SUCCESS after ${elapsed}s`);
        if (_dwf) { log(`[WF:remoteAddon] build output:\n${buildResult.stdout}`); }
      }
      return buildResult.ok;
    }
  }

  private async spawnRemoteWorker(sshHost: string, remoteDir: string, fsdbLibsPath: string): Promise<ChildProcess> {
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    const ldPath = fsdbLibsPath;
    const workerScript = `${remoteDir}/dist/fsdb_worker.js`;

    // Write a launcher script to avoid bash --login which can hang on remote profile scripts
    const launcherScript = [
      '#!/bin/sh',
      `cd "${remoteDir}"`,
      `export LD_LIBRARY_PATH="${ldPath}:$LD_LIBRARY_PATH"`,
      'export NOVAS_FSDB_LOG=0',
      `exec node "${workerScript}"`,
    ].join('\n') + '\n';
    try {
      await vscode.workspace.fs.writeFile(
        this.remoteUri(`${remoteDir}/run_worker.sh`),
        Buffer.from(launcherScript, 'utf-8')
      );
      if (_dwf) { log('[WF:spawnRemote] run_worker.sh deployed via remote fs'); }
    } catch (err: any) {
      log(`[FSDB:SSH] failed to write run_worker.sh: ${err.message}`);
    }

    const sshCmd = `sh ${remoteDir}/run_worker.sh`;
    if (_dwf) { log(`[WF:spawnRemote] ssh ${sshHost} — ${sshCmd}`); }
    const proc = spawn('ssh', [...this.sshOpts, sshHost, sshCmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (_dwf) { log(`[WF:spawnRemote] spawned pid=${proc.pid}`); }
    return proc;
  }

  // #region Local Auto-Build

  private async ensureFsdbAddon(vaporviewRoot: string, fsdbLibsPath: string): Promise<boolean> {
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    const dbg = process.env.CRISP_DEV_WF_FSDB === '1';

    log(`[FSDB] ensureFsdbAddon: vaporviewRoot=${vaporviewRoot}, fsdbLibsPath=${fsdbLibsPath}`);

    // Prebuilt addon short-circuits: an explicit CRISP_FSDB_ADDON path, or the
    // Crisp CLI's auto-build for this workspace (<cwd>/.crisp-fsdb). The forked
    // worker honors CRISP_FSDB_ADDON, so resolving into that env var is enough.
    const envAddon = process.env.CRISP_FSDB_ADDON;
    if (envAddon && fs.existsSync(envAddon)) {
      log(`[FSDB] using prebuilt addon from CRISP_FSDB_ADDON: ${envAddon}`);
      return true;
    }

    const addonPath = path.join(vaporviewRoot, 'build', 'Release', 'fsdb_reader.node');
    log(`[FSDB] checking addon at ${addonPath}`);
    if (fs.existsSync(addonPath)) {
      log(`[FSDB] addon already exists — skip build`);
      return true;
    }

    const cliAddon = path.join(process.cwd(), '.crisp-fsdb', 'build', 'Release', 'fsdb_reader.node');
    if (fs.existsSync(cliAddon)) {
      log(`[FSDB] using CLI-built addon: ${cliAddon}`);
      process.env.CRISP_FSDB_ADDON = cliAddon;
      return true;
    }
    log(`[FSDB] addon NOT found — will attempt auto-build`);

    const verdiHome = process.env.VERDI_HOME;
    const xceliumHome = process.env.XCELIUM_HOME;
    let fsdbHeaderPath: string;

    log(`[FSDB] VERDI_HOME=${verdiHome ?? '(unset)'}, XCELIUM_HOME=${xceliumHome ?? '(unset)'}`);

    if (verdiHome) {
      fsdbHeaderPath = path.join(verdiHome, 'share', 'FsdbReader');
    } else if (xceliumHome) {
      fsdbHeaderPath = path.join(xceliumHome, 'tools.lnx86', 'include');
    } else {
      log(`[FSDB] no env vars set — cannot auto-build, skipping (worker will handle error)`);
      return true;
    }
    log(`[FSDB] resolved fsdbHeaderPath=${fsdbHeaderPath}`);

    const missing: string[] = [];
    const libNffr = path.join(fsdbLibsPath, 'libnffr.so');
    const libNsys = path.join(fsdbLibsPath, 'libnsys.so');
    const ffrApi = path.join(fsdbHeaderPath, 'ffrAPI.h');
    log(`[FSDB] validating: libnffr=${libNffr} exists=${fs.existsSync(libNffr)}`);
    log(`[FSDB] validating: libnsys=${libNsys} exists=${fs.existsSync(libNsys)}`);
    log(`[FSDB] validating: ffrAPI.h=${ffrApi} exists=${fs.existsSync(ffrApi)}`);
    if (!fs.existsSync(libNffr)) {
      missing.push(`libnffr.so not found at ${fsdbLibsPath}/`);
    }
    if (!fs.existsSync(libNsys)) {
      missing.push(`libnsys.so not found at ${fsdbLibsPath}/`);
    }
    if (!fs.existsSync(ffrApi)) {
      missing.push(`ffrAPI.h not found at ${fsdbHeaderPath}/`);
    }
    if (missing.length > 0) {
      log(`[FSDB] validation FAILED — missing: ${JSON.stringify(missing)}`);
      vscode.window.showErrorMessage(
        "Cannot auto-build FSDB reader addon. Missing files:\n" + missing.join("\n")
      );
      return false;
    }
    log(`[FSDB] all required files present — proceeding to build`);

    const bindingGyp = JSON.stringify({
      variables: {
        FSDB_READER_LIBS_PATH: fsdbLibsPath,
        FSDB_HEADER_PATH: fsdbHeaderPath
      },
      targets: [{
        target_name: "fsdb_reader",
        "cflags!": ["-fno-exceptions"],
        cflags: ["-fPIC"],
        "cflags_cc!": ["-fno-exceptions"],
        cflags_cc: ["-fPIC"],
        sources: ["src/fsdb_reader.cpp"],
        include_dirs: [
          "<!@(node -p \"require('node-addon-api').include\")",
          "<(FSDB_HEADER_PATH)>"
        ],
        defines: ["NAPI_DISABLE_CPP_EXCEPTIONS"],
        ldflags: [
          "-L<(FSDB_READER_LIBS_PATH)>",
          "-static-libstdc++"
        ],
        libraries: [
          "-lnffr",
          "-lnsys"
        ]
      }]
    }, null, 2);

    const bindingGypPath = path.join(vaporviewRoot, 'binding.gyp');
    log(`[FSDB] writing binding.gyp to ${bindingGypPath}`);
    if (dbg) { log(`[FSDB] binding.gyp content:\n${bindingGyp}`); }
    fs.writeFileSync(bindingGypPath, bindingGyp);

    const buildCmd = 'npx node-gyp rebuild';
    log(`[FSDB] running: ${buildCmd}  cwd=${vaporviewRoot}`);
    const buildStartTime = Date.now();
    const BUILD_TIMEOUT_MS = 120_000;

    const buildSuccess = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Building FSDB reader addon (this may take a minute)...",
      cancellable: false
    }, () => {
      return new Promise<boolean>((resolve) => {
        const child = exec(buildCmd, { cwd: vaporviewRoot, timeout: BUILD_TIMEOUT_MS }, (error, stdout, stderr) => {
          const elapsed = ((Date.now() - buildStartTime) / 1000).toFixed(1);
          if (error) {
            log(`[FSDB] build FAILED after ${elapsed}s — exit code=${error.code}, signal=${error.signal}`);
            if (error.killed) { log(`[FSDB] build process was killed (timeout=${BUILD_TIMEOUT_MS}ms)`); }
            log(`[FSDB] build stdout:\n${stdout}`);
            log(`[FSDB] build stderr:\n${stderr}`);
            const output = (stdout + '\n' + stderr).trim();
            vscode.window.showErrorMessage(
              "Failed to build FSDB reader addon. Check VaporView output for details.\n" + output.slice(-300)
            );
            resolve(false);
          } else {
            log(`[FSDB] build SUCCESS after ${elapsed}s`);
            if (dbg) { log(`[FSDB] build stdout:\n${stdout}`); }
            if (dbg && stderr) { log(`[FSDB] build stderr:\n${stderr}`); }
            const addonExists = fs.existsSync(addonPath);
            log(`[FSDB] post-build addon exists=${addonExists} at ${addonPath}`);
            if (!addonExists) {
              vscode.window.showErrorMessage("FSDB reader addon build completed but fsdb_reader.node was not produced.");
            }
            resolve(addonExists);
          }
        });
        log(`[FSDB] build process spawned, pid=${child.pid}`);
      });
    });

    log(`[FSDB] ensureFsdbAddon result=${buildSuccess}`);
    return buildSuccess;
  }

  // #region loadNetlist

  async loadNetlist(): Promise<void> {
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    try {
    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] START — platform=' + process.platform + ' uri.authority=' + (this.uri.authority ?? '(none)') + ' uri.scheme=' + this.uri.scheme); }

    // Detect if we're on a non-Linux platform with SSH remote workspace
    const sshInfo = this.detectSSHRemote();
    if (process.platform !== 'linux' && !sshInfo) {
      vscode.window.showErrorMessage("FSDB support requires a Linux environment. Use VS Code Remote SSH to connect to a Linux workspace.");
      return;
    }
    this.isSSHRemote = !!sshInfo;
    if (sshInfo) {
      this.sshHost = sshInfo.sshHost;
      log(`[FSDB] SSH remote mode: host=${this.sshHost}`);
      // Set remoteWorkerDir early so sshExec fallback can use it
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      this.remoteWorkerDir = `${wsFolder ? wsFolder.uri.path : '/tmp'}/.crisp-fsdb`;
    }

    // Resolve FSDB libs path
    let fsdbReaderLibsPath = vscode.workspace.getConfiguration('vaporview').get<string>('fsdbReaderLibsPath');
    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] configured fsdbReaderLibsPath=' + (fsdbReaderLibsPath ?? '(not set)')); }

    if (!fsdbReaderLibsPath) {
      if (this.isSSHRemote) {
        if (_dwf) { log('[WF:FsdbHandler.loadNetlist] querying remote env vars for libs path via sshExec...'); }
        const envCmd = 'if [ -n "$VERDI_HOME" ]; then echo "$VERDI_HOME/share/FsdbReader/linux64"; elif [ -n "$XCELIUM_HOME" ]; then echo "$XCELIUM_HOME/tools.lnx86/lib/64bit"; else echo ""; fi';
        const envResult = await this.sshExec(this.sshHost, envCmd, { timeoutMs: 15000 });
        if (_dwf) { log(`[WF:FsdbHandler.loadNetlist] SSH env query: ok=${envResult.ok} stdout='${envResult.stdout.trim()}' stderr='${envResult.stderr.trim()}'`); }
        if (envResult.ok && envResult.stdout.trim()) {
          fsdbReaderLibsPath = envResult.stdout.trim();
          log(`[FSDB] libs path from remote env: ${fsdbReaderLibsPath}`);
        } else if (!envResult.ok) {
          log(`[FSDB] SSH env query failed (code=${envResult.code}): ${envResult.stderr.trim()}`);
        }
      } else {
        const verdiHome = process.env.VERDI_HOME;
        const xceliumHome = process.env.XCELIUM_HOME;
        if (_dwf) { log('[WF:FsdbHandler.loadNetlist] VERDI_HOME=' + (verdiHome ?? '(unset)') + ' XCELIUM_HOME=' + (xceliumHome ?? '(unset)')); }
        if (verdiHome) {
          fsdbReaderLibsPath = path.join(verdiHome, 'share', 'FsdbReader', 'linux64');
        } else if (xceliumHome) {
          fsdbReaderLibsPath = path.join(xceliumHome, 'tools.lnx86', 'lib', '64bit');
        }
      }
      if (!fsdbReaderLibsPath) {
        const setupGuide = this.isSSHRemote
          ? `To open FSDB files on a remote machine, set "vaporview.fsdbReaderLibsPath" in VS Code settings ` +
            `to the FSDB reader libraries path on ${this.sshHost} ` +
            `(e.g. /path/to/verdi/share/FsdbReader/linux64 or /path/to/xcelium/tools.lnx86/lib/64bit). ` +
            `You also need SSH key-based authentication configured for ${this.sshHost} (ssh-copy-id).`
          : `Export VERDI_HOME or XCELIUM_HOME in your environment before launching VS Code. ` +
            `For example: export VERDI_HOME=/path/to/verdi. ` +
            `Alternatively, set vaporview.fsdbReaderLibsPath in VS Code settings.`;
        log(`[FSDB] no libs path resolved — showing guidance`);
        vscode.window.showErrorMessage(
          `FSDB reader libraries not found. ${setupGuide}`,
          { modal: true }
        );
        return;
      }
    }
    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] resolved fsdbReaderLibsPath=' + fsdbReaderLibsPath); }

    // For SSH remote, resolve the file path as a POSIX path (uri.fsPath uses Windows backslashes)
    const fsdbFilePath = this.isSSHRemote ? this.uri.path : this.uri.fsPath;
    if (_dwf) { log(`[WF:FsdbHandler.loadNetlist] fsdbFilePath=${fsdbFilePath} (uri.fsPath=${this.uri.fsPath}, uri.path=${this.uri.path})`); }

    if (this.isSSHRemote) {
      // SSH remote path: deploy worker + build addon on remote, then spawn via SSH
      const remoteDir = await this.deployRemoteWorker(this.sshHost, fsdbReaderLibsPath);
      if (!remoteDir) { return; }
      this.remoteWorkerDir = remoteDir;

      log(`[FSDB] spawning remote worker via SSH on ${this.sshHost}`);
      this.fsdbWorker = await this.spawnRemoteWorker(this.sshHost, remoteDir, fsdbReaderLibsPath);
      if (_dwf) { log('[WF:FsdbHandler.loadNetlist] SSH worker spawned, pid=' + this.fsdbWorker.pid); }
    } else {
      // Local Linux path: auto-build addon + fork worker
      const vaporviewRoot = path.resolve(__dirname, '..');
      log(`[FSDB] load: __dirname=${__dirname}, vaporviewRoot=${vaporviewRoot}, fsdbReaderLibsPath=${fsdbReaderLibsPath}`);
      const addonReady = await this.ensureFsdbAddon(vaporviewRoot, fsdbReaderLibsPath);
      log(`[FSDB] load: ensureFsdbAddon returned ${addonReady}`);
      if (!addonReady) {
        log(`[FSDB] load: addon not ready — aborting load`);
        return;
      }

      const workerPath = path.resolve(__dirname, 'fsdb_worker.js');
      if (_dwf) { log('[WF:FsdbHandler.loadNetlist] forking worker: ' + workerPath); }
      this.fsdbWorker = fork(workerPath, {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: `${process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : ''}${fsdbReaderLibsPath}`,
          NOVAS_FSDB_LOG: '0'
        }
      });
      if (_dwf) { log('[WF:FsdbHandler.loadNetlist] worker forked, pid=' + this.fsdbWorker.pid); }
    }

    this.fsdbWorker.setMaxListeners(50);
    this.setupFsdbWorkerListeners();

    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] sending openFsdb command with path=' + fsdbFilePath); }
    await this.callFsdbWorkerTask({
      command: 'openFsdb',
      fsdbPath: fsdbFilePath
    });
    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] openFsdb done'); }

    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] sending readScopes command...'); }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Reading Scopes for " + path.basename(fsdbFilePath),
      cancellable: false
    }, async () => {
      await this.callFsdbWorkerTask({
        command: 'readScopes'
      });
    });
    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] readScopes done'); }

    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] sending readMetadata command...'); }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Reading Metadata for " + path.basename(fsdbFilePath),
      cancellable: false
    }, async () => {
      await this.callFsdbWorkerTask({
        command: 'readMetadata'
      });
    });
    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] readMetadata done'); }

    if (_dwf) { log('[WF:FsdbHandler.loadNetlist] DONE'); }

    } catch (err: any) {
      log(`[FSDB] loadNetlist() exception: ${err?.message ?? err}\n${err?.stack ?? ''}`);
      vscode.window.showErrorMessage(`FSDB load error: ${err?.message ?? err}`);
    }
  }

  async loadBody(): Promise<void> {
    // Implement loading the body of the FSDB file here
    return;
  }

  // #region Worker Communication

  private setupFsdbWorkerListeners(): void {
    if (!this.fsdbWorker) return;
    const log = (msg: string) => this.providerDelegate.logOutputChannel(msg);
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';

    if (_dwf) { log(`[WF:setupListeners] isSSHRemote=${this.isSSHRemote} pid=${this.fsdbWorker.pid}`); }

    this.fsdbWorker.on('error', (err: Error) => {
      log('[FSDB] worker error: ' + err.message);
    });

    this.fsdbWorker.on('exit', (code: number | null, signal: string | null) => {
      log(`[FSDB] worker exited with code ${code} (signal: ${signal})`);
    });

    if (this.isSSHRemote) {
      if (_dwf) { log('[WF:setupListeners] setting up SSH/stdio message parsing on stdout'); }
      // SSH mode: parse newline-delimited JSON from stdout
      let buf = '';
      let msgCount = 0;
      this.fsdbWorker.stdout!.setEncoding('utf-8');
      this.fsdbWorker.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) {
            try {
              const msg = JSON.parse(line);
              msgCount++;
              if (_dwf && msgCount <= 5) { log(`[WF:stdio:rx#${msgCount}] command=${msg.command ?? '(response)'} id=${msg.id ?? '(none)'}`); }
              if (_dwf && msgCount === 6) { log('[WF:stdio:rx] (further messages suppressed)'); }
              if ('command' in msg) {
                this.handleMessage(msg);
              }
              // Also notify callFsdbWorkerTask listeners
              for (const listener of this.stdioMessageListeners) {
                listener(msg);
              }
            } catch (e: any) {
              log('[FSDB:SSH] failed to parse worker output: ' + e.message + ' line: ' + line.slice(0, 200));
            }
          }
        }
      });
      // Log stderr from remote worker
      this.fsdbWorker.stderr!.setEncoding('utf-8');
      this.fsdbWorker.stderr!.on('data', (chunk: string) => {
        log('[FSDB:SSH:stderr] ' + chunk.trim());
      });
    } else {
      if (_dwf) { log('[WF:setupListeners] setting up IPC message listeners'); }
      // IPC mode (fork): use built-in message channel
      this.fsdbWorker.on('online', () => {
        log('[FSDB] worker is online.');
      });
      this.fsdbWorker.on('message', (msg: any) => {
        if ('command' in msg) {
          this.handleMessage(msg);
        }
        // Responses with 'id' are handled by callFsdbWorkerTask listeners
      });
    }
  }

  private handleMessage(message: FsdbWorkerCallback) {
    switch (message.command) {
      case 'require-failed': {
        this.providerDelegate.logOutputChannel(`[FSDB] require-failed: ${JSON.stringify(message.error)}`);
        const errorCode = message.error?.code ?? 'unknown';
        vscode.window.showErrorMessage("Failed to load FSDB reader, is vaporview.fsdbReaderLibsPath properly set? (" + errorCode + ")");
        break;
      }
      case 'fsdb-scope-callback': {
        this.fsdbScopeCallback(message.name, message.type, message.path, message.netlistId, message.scopeOffsetIdx);
        break;
      }
      case 'fsdb-upscope-callback': {
        this.fsdbUpscopeCallback();
        break;
      }
      case 'setMetadata': {
        this.metadata.scopeCount = message.scopecount;
        this.metadata.netlistIdCount = message.varcount;
        this.metadata.timeScale = message.timescale;
        this.metadata.timeUnit = message.timeunit;
        if (message.fileType) { this.metadata.fileType = message.fileType; }
        if (message.simVersion) { this.metadata.simVersion = message.simVersion; }
        if (message.simDate) { this.metadata.simDate = message.simDate; }
        if (message.maxVarIdcode !== undefined) { this.metadata.maxVarIdcode = message.maxVarIdcode; }
        break;
      }
      case 'setChunkSize': {
        this.metadata.timeEnd = Number(message.timeend);
        this.metadata.timeTableCount = 0; // FSDB addon does not provide timeTableCount
        this.metadata.timeTableLoaded = true;
        break;
      }
      case 'fsdb-var-callback': {
        this.fsdbVarCallback(
          message.name, message.type, message.encoding, message.path, message.netlistId, message.signalId, message.width, message.msb, message.lsb);
        break;
      }
      case 'fsdb-array-begin-callback': {
        this.fsdbArrayBeginCallback(message.name, message.path, message.netlistId);
        break;
      }
      case 'fsdb-array-end-callback': {
        this.fsdbArrayEndCallback(message.size);
        break;
      }
    }
  }

  private callFsdbWorkerTask(message: any): Promise<any> {
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
    if (this.fsdbWorker === undefined) {
      if (_dwf) { this.providerDelegate.logOutputChannel('[WF:callTask] worker is undefined — returning empty'); }
      return Promise.resolve([]);
    }
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substring(2, 9);
      message.id = id;
      if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:callTask] command=${message.command} id=${id} mode=${this.isSSHRemote ? 'SSH' : 'IPC'}`); }
      const taskStartTime = Date.now();

      if (this.isSSHRemote) {
        // SSH/stdio mode: listen via stdioMessageListeners, send via stdin
        const handler = (msg: any) => {
          if (msg.id === id) {
            const idx = this.stdioMessageListeners.indexOf(handler);
            if (idx >= 0) { this.stdioMessageListeners.splice(idx, 1); }
            if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:callTask] response for ${message.command} id=${id} elapsed=${Date.now() - taskStartTime}ms`); }
            if (msg.error) {
              if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:callTask] ERROR: ${msg.error}`); }
              return reject(new Error(String(msg.error)));
            }
            resolve(msg);
          }
        };
        this.stdioMessageListeners.push(handler);
        const payload = JSON.stringify(message) + '\n';
        if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:callTask] writing to stdin (${payload.length} bytes)`); }
        this.fsdbWorker!.stdin!.write(payload);
      } else {
        // IPC mode (fork): use built-in message channel
        const messageHandler = (msg: any) => {
          if ('id' in msg && msg.id === id) {
            this.fsdbWorker!.off('message', messageHandler);
            if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:callTask] IPC response id=${id} elapsed=${Date.now() - taskStartTime}ms`); }
            if (msg.error) {
              if (_dwf) { this.providerDelegate.logOutputChannel(`[WF:callTask] ERROR: ${msg.error}`); }
              return reject(new Error(String(msg.error)));
            }
            resolve(msg);
          }
        };
        this.fsdbWorker!.on('message', messageHandler);
        this.fsdbWorker!.send(message);
      }
    });
  }

  // #region Other Methods (unchanged signatures)

  private async fsdbReadVars(element: NetlistItem | undefined) {
    if (!element) return;
    this.fsdbCurrentScope = element;

    let scopePath = "";
    if (element.scopePath.length !== 0) { scopePath += element.scopePath.join(".") + "."; }
    scopePath += element.name;

    await this.callFsdbWorkerTask({
      command: 'readVars',
      scopePath: scopePath,
      scopeOffsetIdx: element.scopeOffsetIdx
    });
  }

  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) { return this.netlistTop; }
    if (element.fsdbVarLoaded) { return element.children; }
    await this.fsdbReadVars(element);
    element.fsdbVarLoaded = true;
    return element.children;
  }

  async getSignalData(signalIdList: SignalId[]): Promise<void> {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Loading signals",
      cancellable: false
    }, async () => {
      await this.callFsdbWorkerTask({
        command: 'loadSignals',
        signalIdList: signalIdList
      });
    });

    // Map each signalId to a promise for handling its task
    const tasks = signalIdList.map(async (signalId) => {
      const result = await this.callFsdbWorkerTask({
        command: 'getValueChanges',
        signalId: signalId
      });
      const message = result;
      const data = message.result as FsdbWaveformData;

      this.postMessageToWebview({
        command: 'update-waveform-chunk',
        signalId: signalId,
        transitionDataChunk: data.valueChanges,
        totalChunks: 1,
        chunkNum: 0,
        min: data.min,
        max: data.max
      } as ValueChangeDataChunk);
    });
    // Run all tasks concurrently
    await Promise.all(tasks);
  }

  async getValueChangesForSignal(signalId: SignalId): Promise<any> {
    await this.callFsdbWorkerTask({ command: 'loadSignals', signalIdList: [signalId] });
    const result = await this.callFsdbWorkerTask({ command: 'getValueChanges', signalId: signalId });
    return (result.result as FsdbWaveformData);
  }

  async getEnumData(enumList: EnumQueueEntry[]): Promise<void> {
    // Not Implemented for FSDB
    // TODO(heyfey): Implement fetching enum data for FSDB
    return;
  }

  async getValuesAtTime(time: number, instancePaths: string[]): Promise<ValuesAtTimeResult[]> {
    const instancePath2signalId: Map<string, number> = new Map();
    const signalId2values: Map<number, string | string[]> = new Map();
    for (const instancePath of instancePaths) {
      const netlistItem = await this.findTreeItemFn(instancePath, undefined, undefined);
      if (netlistItem) {
        instancePath2signalId.set(instancePath, netlistItem.signalId);
        signalId2values.set(netlistItem.signalId, []);
      }
    }
    if (signalId2values.size === 0) {
      return [];
    }

    const signalIdList = Array.from(signalId2values.keys());
    await this.callFsdbWorkerTask({
      command: 'loadSignals',
      signalIdList: signalIdList
    });

    // Call fsdbworker task for each signalId
    await Promise.all(signalIdList.map(async (signalId) => {
      const result = await this.callFsdbWorkerTask({
        command: 'getValuesAtTime',
        signalId: signalId,
        time: time
      });
      const message = result;
      signalId2values.set(signalId, (message.result as string | string[]) ?? '');
    }));

    // Convert the map to an array of objects
    const result = [];
    for (const [instancePath, signalId] of instancePath2signalId.entries()) {
      const values = signalId2values.get(signalId);
      if (values !== undefined) {
        result.push({
          instancePath: instancePath,
          value: values
        });
      }
    }
    return result;
  }

  async setViewWindow(startTime: number, endTime: number): Promise<void> {
    await this.callFsdbWorkerTask({
      command: 'setViewWindow',
      startTime: startTime,
      endTime: endTime
    });
  }

  async getVarInfo(signalId: number): Promise<any> {
    const result = await this.callFsdbWorkerTask({
      command: 'getVarInfo',
      signalId: signalId
    });
    return result.result;
  }

  async unload(): Promise<void> {
    const _dwf = process.env.CRISP_DEV_DEBUG_WF === '1';
    if (_dwf) { this.providerDelegate.logOutputChannel('[WF:FSDB:unload] START isSSHRemote=' + this.isSSHRemote + ' workerPid=' + this.fsdbWorker?.pid); }

    await this.callFsdbWorkerTask({ command: 'unload' });
    if (this.fsdbWorker !== undefined) {
      if (this.isSSHRemote) {
        if (_dwf) { this.providerDelegate.logOutputChannel('[WF:FSDB:unload] killing SSH worker pid=' + this.fsdbWorker.pid); }
        this.fsdbWorker.kill();
      } else {
        if (_dwf) { this.providerDelegate.logOutputChannel('[WF:FSDB:unload] disconnecting IPC worker pid=' + this.fsdbWorker.pid); }
        this.fsdbWorker.disconnect();
      }
      this.fsdbWorker = undefined;
    }
    this.stdioMessageListeners = [];
    this.fsdbTopModuleCount = 0;
    this.fsdbCurrentScope = undefined;
    this.parametersLoaded = false;
    this.netlistTop = [];
    if (_dwf) { this.providerDelegate.logOutputChannel('[WF:FSDB:unload] DONE'); }
  }

  dispose(): void {
    this.unload();
  }

  // #region FSDB callback methods

  private fsdbScopeCallback(name: string, type: string, path: string, netlistId: number, scopeOffsetIdx: number) {
    const scopePath = path ? path.split('.') : [];
    this.netlistTop.push(createScope(name, type, scopePath, netlistId, scopeOffsetIdx, this.uri));
  }

  private fsdbUpscopeCallback() {
    const scope = this.netlistTop.pop()!;
    if (this.netlistTop.length === this.fsdbTopModuleCount) {
      this.netlistTop.push(scope);
      this.fsdbTopModuleCount++;
    } else {
      this.netlistTop[this.netlistTop.length - 1].children.push(scope);
    }
  }

  private fsdbVarCallback(name: string, type: string, encoding: string, path: string, netlistId: NetlistId, signalId: SignalId, width: number, msb: number, lsb: number) {
    const enumType = "";
    const paramValue = "";
    const scopePath = path ? path.split('.') : [];
    const varItem = createVar(name, paramValue, type, encoding, scopePath, netlistId, signalId, width, msb, lsb, enumType, true /*isFsdb*/, this.uri);
    this.fsdbCurrentScope!.children.push(varItem);
  }

  private fsdbArrayBeginCallback(name: string, path: string, netlistId: number) {
    const scopePath = path ? path.split('.') : [];
    this.fsdbCurrentScope!.children.push(createScope(name, "vhdlarray", scopePath, netlistId, -1, this.uri));
  }

  private fsdbArrayEndCallback(size: number) {
    const arrayElements = [];
    for (let i = 0; i < size; i++) {
      const element = this.fsdbCurrentScope!.children.pop()!;
      arrayElements.push(element);
    }
    const array = this.fsdbCurrentScope!.children.pop()!;
    array.children.push(...arrayElements.reverse());
    array.fsdbVarLoaded = true;
    this.fsdbCurrentScope!.children.unshift(array);
  }

  private async loadAllVarsRecursive(items: NetlistItem[]): Promise<void> {
    for (const item of items) {
      if (item.collapsibleState !== vscode.TreeItemCollapsibleState.None && !item.fsdbVarLoaded) {
        await this.fsdbReadVars(item);
        item.fsdbVarLoaded = true;
      }
      if (item.children.length > 0) {
        await this.loadAllVarsRecursive(item.children);
      }
    }
  }

  private collectSearchResults(items: NetlistItem[], query: string, results: NetlistSearchEntry[], maxResults: number): void {
    for (const item of items) {
      if (results.length >= maxResults) { return; }
      const instancePath = item.instancePath();
      if (instancePath.toLowerCase().includes(query)) {
        const isVar = item.collapsibleState === vscode.TreeItemCollapsibleState.None;
        results.push({
          instancePath,
          type: item.type,
          isVar,
          paramValue: item.paramValue || '',
          msb: item.msb,
          lsb: item.lsb,
        });
      }
      if (item.children.length > 0 && results.length < maxResults) {
        this.collectSearchResults(item.children, query, results, maxResults);
      }
    }
  }

  public async searchNetlist(searchString: string): Promise<NetlistSearchResult> {
    if (!searchString) { return { totalResults: 0, searchResults: [] }; }
    // Ensure all vars are loaded before searching
    await this.loadAllVarsRecursive(this.netlistTop);
    const maxResults = 200;
    const results: NetlistSearchEntry[] = [];
    const query = searchString.toLowerCase();
    this.collectSearchResults(this.netlistTop, query, results, maxResults);
    this.netlistSearchable = true;
    return { totalResults: results.length, searchResults: results };
  }
}
