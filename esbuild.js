const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      console.log(`Build ${build.initialOptions.outfile} finished`);
      if (result.errors.length) {
        result.errors.forEach(error => {
          console.error(error);
        });
      }
    });
  }
};

/**
 * Copies node-addon-api headers AND Node.js N-API headers into dist/napi/
 * so they ship with the extension. Needed for offline remote FSDB addon compilation.
 */
const copyNapiPlugin = {
  name: 'copy-napi-headers',
  setup(build) {
    build.onEnd(() => {
      const napiDst = path.resolve(__dirname, 'dist', 'napi');
      fs.mkdirSync(napiDst, { recursive: true });

      // 1) node-addon-api headers (C++ wrapper)
      const napiSrc = path.resolve(__dirname, 'node_modules', 'node-addon-api');
      const napiFiles = ['napi.h', 'napi-inl.h', 'napi-inl.deprecated.h', 'index.js', 'package.json'];
      if (!fs.existsSync(path.join(napiSrc, 'napi.h'))) {
        console.warn('[copy-napi-headers] node-addon-api not found, skipping');
        return;
      }
      for (const f of napiFiles) {
        const src = path.join(napiSrc, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(napiDst, f));
        }
      }

      // 2) Node.js N-API core headers (platform-independent C headers)
      const { execSync } = require('child_process');
      let nodeIncDir = '';
      try {
        nodeIncDir = execSync('node -e "console.log(require(\'path\').resolve(process.execPath, \'..\', \'..\', \'include\', \'node\'))"', { encoding: 'utf-8' }).trim();
      } catch { /* ignore */ }
      const nodeHeaders = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
      if (nodeIncDir && fs.existsSync(path.join(nodeIncDir, 'node_api.h'))) {
        for (const h of nodeHeaders) {
          const src = path.join(nodeIncDir, h);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(napiDst, h));
          }
        }
        console.log('[copy-napi-headers] copied napi + node N-API headers to dist/napi/');
      } else {
        console.warn('[copy-napi-headers] Node.js N-API headers not found at ' + nodeIncDir);
        console.log('[copy-napi-headers] copied napi headers (without node N-API) to dist/napi/');
      }
    });
  }
};

const commonConfig = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// Resolve alias targets to absolute paths. Relative paths break under pnpm,
// where these packages live in the hoisted root `.pnpm/` store, not in
// apps/vaporview/node_modules. Resolve jsonc-parser via the shiki-bridge
// package (where pnpm nests it) since it isn't resolvable from here directly.
const shikiBridgeDir = path.dirname(require.resolve('vscode-shiki-bridge/package.json'));
const shikiBridgeCjs = path.join(shikiBridgeDir, 'dist', 'index.cjs');
const jsoncParserEsm = require.resolve('jsonc-parser/lib/esm/main.js', { paths: [shikiBridgeDir] });

const extensionConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/extension.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'], // Only external we actually need
  alias: {
    // vscode-shiki-bridge ships ESM as its default export, which can't be
    // bundled into a CJS output. Point esbuild at the CJS build instead.
    'vscode-shiki-bridge': shikiBridgeCjs,
    // jsonc-parser's UMD entry passes the real Node require() into its factory,
    // so internal require('./impl/format') calls escape esbuild's module system
    // and fail at runtime. Use the ESM entry so esbuild can bundle it statically.
    'jsonc-parser': jsoncParserEsm,
  },
  plugins: [esbuildProblemMatcherPlugin, copyNapiPlugin],
};

const workerConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/worker.ts'],
  format: 'iife', // Self-executing function for worker scope
  platform: 'node',
  outfile: 'dist/worker.js',
  plugins: [esbuildProblemMatcherPlugin],
  target: 'es2020', // Modern browsers support WASM
};

const fsdbWorkerConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/fsdb_worker.ts'],
  format: 'iife', // Self-executing function for worker scope
  platform: 'node',
  outfile: 'dist/fsdb_worker.js',
  external: ['../build/Release/fsdb_reader.node'],
  plugins: [esbuildProblemMatcherPlugin],
  target: 'es2020', // Modern browsers support WASM
};

// Standalone host for Crisp Desktop: drives the parser outside VSCode by
// aliasing `vscode` to a minimal Node shim. Reuses dist/worker.js + the wasm.
const standaloneHostConfig = {
  ...commonConfig,
  entryPoints: ['src/standalone/host.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/standalone-host.js',
  // Resolve `vscode` to the shim. vscode-shiki-bridge (theme reader, only used
  // by viewer_provider, never on the parse path) is stubbed so its shiki +
  // jsonc-parser UMD deps drop out of the bundle entirely.
  alias: {
    'vscode': './src/standalone/vscodeShims.ts',
    'vscode-shiki-bridge': './src/standalone/shikiBridgeStub.ts',
  },
  plugins: [esbuildProblemMatcherPlugin],
  target: 'es2020',
};

const webviewConfig = {
  ...commonConfig,
  entryPoints: ['src/webview/vaporview.ts'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/webview.js',
  plugins: [esbuildProblemMatcherPlugin],
  target: ['es2020'],
  treeShaking: production,
  metafile: true, // To analyze bundle
};

const netlistExplorerConfig = {
  ...commonConfig,
  entryPoints: ['src/webview/netlist_explorer/main.ts'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/netlist_explorer.js',
  plugins: [esbuildProblemMatcherPlugin],
  target: ['es2020'],
  treeShaking: production,
};

async function main() {
  try {
    if (watch) {
      const extensionCtx = await esbuild.context(extensionConfig);
      const webviewCtx = await esbuild.context(webviewConfig);
      const netlistExplorerCtx = await esbuild.context(netlistExplorerConfig);
      const workerCtx = await esbuild.context(workerConfig);
      const fsdbWorkerCtx = await esbuild.context(fsdbWorkerConfig);
      const standaloneHostCtx = await esbuild.context(standaloneHostConfig);

      await Promise.all([
        extensionCtx.watch(),
        webviewCtx.watch(),
        netlistExplorerCtx.watch(),
        workerCtx.watch(),
        fsdbWorkerCtx.watch(),
        standaloneHostCtx.watch()
      ]);
    } else {
      await Promise.all([
        esbuild.build(extensionConfig),
        esbuild.build(webviewConfig),
        esbuild.build(netlistExplorerConfig),
        esbuild.build(workerConfig),
        esbuild.build(fsdbWorkerConfig),
        esbuild.build(standaloneHostConfig)
      ]);
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}


main().catch(e => {
  console.error(e);
  process.exit(1);
});

