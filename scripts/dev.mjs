// Run the production FastAPI implementation alongside Vite during development.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const localPython = path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.PYTHON || (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const apiPort = process.env.API_PORT || '8000';
process.env.API_PORT = apiPort;
const apiOnly = process.argv.includes('--api-only');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
}
run(python, ['-m', 'uvicorn', 'app.main:app', '--reload', '--port', apiPort], path.join(root, 'backend'));
if (!apiOnly) run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js')], root);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
