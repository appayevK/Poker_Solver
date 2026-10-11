// Shared paths and helpers for the flop-library pipeline scripts.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const WORK = join(ROOT, 'solver-work');
export const DATA = join(ROOT, 'data', 'flops');
export const paths = {
  input: (spot, flop) => join(WORK, 'inputs', spot, `${flop}.txt`),
  output: (spot, flop) => join(WORK, 'outputs', spot, `${flop}.json`),
  log: (spot, flop) => join(WORK, 'logs', spot, `${flop}.json`),
  data: (spot, flop) => join(DATA, spot, `${flop}.json`),
};

export function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

/** Folder holding console_solver.exe, from TEXASSOLVER_PATH, or a helpful error. */
export function solverFolder() {
  const help = [
    'Set TEXASSOLVER_PATH to the folder that contains console_solver.exe, for example:',
    "  PowerShell (once, then open a new terminal): [Environment]::SetEnvironmentVariable('TEXASSOLVER_PATH', 'C:\\TexasSolver', 'User')",
    '  This terminal only: $env:TEXASSOLVER_PATH = "C:\\TexasSolver"',
    'Download TexasSolver (console version included) from https://github.com/bupticybee/TexasSolver/releases',
  ].join('\n');
  const dir = process.env.TEXASSOLVER_PATH;
  if (!dir) throw new Error(`TEXASSOLVER_PATH is not set.\n${help}`);
  const exe = ['console_solver.exe', 'console_solver'].map((name) => join(dir, name)).find((p) => existsSync(p));
  if (!exe) throw new Error(`No console_solver.exe in "${dir}".\n${help}`);
  if (!existsSync(join(dir, 'resources'))) throw new Error(`"${dir}" has no resources folder; point TEXASSOLVER_PATH at the unzipped release folder.\n${help}`);
  return { dir, exe };
}

/** Command-line flags: --name value, --flag (true). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

/** The representative flops from data/flops/subset.json, in file order. */
export function subsetFlops() {
  const subset = JSON.parse(readFileSync(join(DATA, 'subset.json'), 'utf8'));
  return subset.representatives;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
