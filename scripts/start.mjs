// Launches the built app with a clean environment (see electron-env.mjs).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronEnv, electronBinary } from './electron-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(electronBinary(root), ['.', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: electronEnv()
});
child.on('exit', (code) => process.exit(code ?? 0));
