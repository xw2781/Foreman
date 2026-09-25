// Builds the three bundles the app is made of:
//   out/main       Electron main process + telemetry worker (esbuild, CommonJS)
//   out/preload    contextBridge preload (esbuild, CommonJS)
//   out/renderer   React UI (Vite)
// `--dev` serves the renderer from Vite with hot reload and restarts Electron
// whenever the main or preload bundle changes.
import { context, build } from 'esbuild';
import { build as viteBuild, createServer } from 'vite';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronEnv, electronBinary } from './electron-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');

const nodeBundle = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: dev ? 'inline' : true,
  // node-pty ships native binaries next to its JS, so it must stay in node_modules.
  // electron-updater loads parts of itself lazily; it ships as an ordinary dependency.
  external: ['electron', 'node-pty', 'electron-updater'],
  logLevel: 'warning',
  absWorkingDir: root
};

const bundles = [
  { ...nodeBundle, entryPoints: { index: 'src/main/index.ts' }, outdir: 'out/main' },
  { ...nodeBundle, entryPoints: { telemetryWorker: 'src/main/telemetry/worker.ts' }, outdir: 'out/main' },
  { ...nodeBundle, entryPoints: { index: 'src/preload/index.ts' }, outdir: 'out/preload' }
];

if (!dev) {
  rmSync(path.join(root, 'out'), { recursive: true, force: true });
  await Promise.all(bundles.map((options) => build(options)));
  await viteBuild({ configFile: path.join(root, 'vite.config.mts'), logLevel: 'warn' });
  console.log('Built out/main, out/preload, out/renderer');
} else {
  const server = await createServer({ configFile: path.join(root, 'vite.config.mts') });
  await server.listen();
  const rendererUrl = server.resolvedUrls.local[0];
  console.log(`Renderer dev server: ${rendererUrl}`);

  let electron = null;
  let restartTimer = null;
  let restarting = Promise.resolve();
  const relaunch = async () => {
    if (electron) {
      // The app holds a single-instance lock: a new process started before the
      // old one exits would quit at once and end the dev session.
      const old = electron;
      electron = null;
      old.removeAllListeners('exit');
      const exited = new Promise((resolve) => old.once('exit', resolve));
      old.kill();
      await exited;
    }
    electron = spawn(electronBinary(root), ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...electronEnv(), ELECTRON_RENDERER_URL: rendererUrl }
    });
    // Closing the app window ends the dev session.
    electron.on('exit', (code) => {
      server.close();
      process.exit(code ?? 0);
    });
  };
  const restart = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restarting = restarting.then(relaunch);
    }, 150);
  };

  const restartPlugin = {
    name: 'restart-electron',
    setup(buildApi) {
      buildApi.onEnd((result) => {
        if (result.errors.length === 0) restart();
      });
    }
  };
  for (const options of bundles) {
    const ctx = await context({ ...options, plugins: [restartPlugin] });
    await ctx.watch();
  }
}
