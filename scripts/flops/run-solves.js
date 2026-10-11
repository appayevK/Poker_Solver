// Runs the TexasSolver inputs in solver-work/inputs/ one after another.
// Resumable: a solve counts as finished only when its log in solver-work/logs/ exists,
// which is written after a successful dump, so a crash or reboot just reruns the
// solve that was in progress. Logs time, iterations, final exploitability and peak RAM.
//
// Memory guard: each solve's private memory is watched every second; a solve that
// goes over --max-gb is stopped (so the laptop never starts swapping), recorded as a
// memory failure and not retried unless --retry-memory is given. Before each solve the
// runner waits until there is enough free RAM for that spot's last measured peak.
//
// Usage: node scripts/flops/run-solves.js [--spot srp-btn-bb] [--limit 3] [--dry-run]
//        [--bench] (one flop per spot, then a time / RAM summary and a full-run estimate)
//        [--max-gb 3.5] [--force] (rerun finished solves) [--retry-memory]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { paths, ensureDir, parseArgs, subsetFlops, solverFolder, formatDuration, WORK } from './common.js';
import { SPOT_DEFINITIONS } from '../../src/flops/spots.js';
import { parseSolverLog } from '../../src/flops/extract.js';

const GB = 1024 ** 3;
const args = parseArgs();
const limit = args.bench ? 1 : args.limit ? Number(args.limit) : Infinity;
const maxGB = args['max-gb'] ? Number(args['max-gb']) : Math.min(3.5, (0.75 * freemem()) / GB);
const flops = subsetFlops();
const spots = SPOT_DEFINITIONS.filter((s) => !args.spot || s.id === args.spot);
if (!spots.length) throw new Error(`Unknown spot "${args.spot}"`);
const runLog = join(WORK, 'logs', 'runs.jsonl');

/** Last run record per spot/flop from runs.jsonl. */
function lastRecords() {
  const out = new Map();
  if (!existsSync(runLog)) return out;
  for (const line of readFileSync(runLog, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      out.set(`${r.spot}/${r.flop}`, r);
    } catch {
      // ignore a torn line from a crash
    }
  }
  return out;
}

const previous = lastRecords();
const jobs = [];
for (const spot of spots) {
  for (const { key } of flops.slice(0, limit)) {
    if (!existsSync(paths.input(spot.id, key))) continue;
    const done = existsSync(paths.log(spot.id, key)) && existsSync(paths.output(spot.id, key));
    const memoryFailed = previous.get(`${spot.id}/${key}`)?.reason === 'memory';
    jobs.push({ spot: spot.id, flop: key, done: done && !args.force, skipMemory: memoryFailed && !args['retry-memory'] && !args.force });
  }
}
if (!jobs.length) {
  console.log('No input files found. Run: node scripts/flops/make-configs.js');
  process.exit(0);
}

/** Finished-solve logs for a spot (or all spots). */
function finishedLogs(spotId) {
  const logs = [];
  for (const j of jobs) {
    if (spotId && j.spot !== spotId) continue;
    const log = paths.log(j.spot, j.flop);
    if (existsSync(log)) logs.push(JSON.parse(readFileSync(log, 'utf8')));
  }
  return logs;
}

function averageSeconds(spotId) {
  const logs = finishedLogs(spotId);
  return logs.length ? logs.reduce((s, r) => s + r.seconds, 0) / logs.length : null;
}

function estimate(todo) {
  let total = 0;
  for (const j of todo) {
    const avg = averageSeconds(j.spot) ?? averageSeconds();
    if (avg === null) return 'unknown until a solve finishes';
    total += avg;
  }
  return formatDuration(total);
}

const todo = jobs.filter((j) => !j.done && !j.skipMemory);
const skipped = jobs.filter((j) => j.skipMemory);
console.log(`${jobs.length} solves, ${jobs.length - todo.length - skipped.length} finished, ${todo.length} to go. Estimated time: ${estimate(todo)}.`);
console.log(`Memory limit per solve: ${maxGB.toFixed(1)} GB (change with --max-gb). Free RAM now: ${(freemem() / GB).toFixed(1)} GB.`);
if (skipped.length) {
  console.log(`Skipping ${skipped.length} solve(s) that went over the memory limit before (--retry-memory to try again): ${skipped.map((j) => `${j.spot} ${j.flop}`).join(', ')}`);
}
if (args['dry-run']) {
  for (const j of todo) console.log(`  would solve ${j.spot} ${j.flop}`);
  process.exit(0);
}

const { dir, exe } = solverFolder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Watches a process's private memory (MB) every second; calls onSample(mb). Windows only. */
function watchMemory(pid, onSample) {
  if (process.platform !== 'win32') return { stop() {} };
  const script = `while ($true) { $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { break }; [Console]::WriteLine([math]::Round($p.PrivateMemorySize64/1MB)); Start-Sleep -Milliseconds 1000 }`;
  const watcher = spawn('powershell', ['-NoProfile', '-Command', script]);
  watcher.stdout.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      const mb = Number(line);
      if (mb > 0) onSample(mb);
    }
  });
  watcher.on('error', () => {});
  return { stop: () => watcher.kill() };
}

/** Waits (up to 10 minutes) until free RAM can hold the spot's last measured peak. */
async function waitForMemory(job) {
  const peaks = finishedLogs(job.spot).map((r) => r.peakMB).filter(Boolean);
  if (!peaks.length) return true;
  const needGB = (Math.max(...peaks) / 1024) * 1.1;
  for (let waited = 0; freemem() / GB < needGB; waited += 30) {
    if (waited === 0) process.stdout.write(`(waiting for ${needGB.toFixed(1)} GB free RAM, ${(freemem() / GB).toFixed(1)} GB free) `);
    if (waited >= 600) return false;
    await sleep(30000);
  }
  return true;
}

let child = null;
process.on('SIGINT', () => {
  if (child) child.kill();
  console.log('\nStopped. Run the same command again to continue where it left off.');
  process.exit(130);
});

function solveOne(job) {
  return new Promise((resolve) => {
    const output = paths.output(job.spot, job.flop);
    rmSync(output, { force: true }); // a partial dump from an interrupted run
    const t0 = Date.now();
    let stdout = '';
    let peak = 0;
    let overLimit = false;
    child = spawn(exe, ['-i', paths.input(job.spot, job.flop)], { cwd: dir });
    const watcher = watchMemory(child.pid, (mb) => {
      peak = Math.max(peak, mb);
      if (mb / 1024 > maxGB && !overLimit) {
        overLimit = true;
        child?.kill();
      }
    });
    child.stdout.on('data', (d) => {
      stdout += d.toString('latin1');
      if (stdout.length > 2e6) stdout = stdout.slice(-1e6);
    });
    child.stderr.on('data', (d) => {
      stdout += d.toString('latin1');
    });
    child.on('close', (code) => {
      watcher.stop();
      child = null;
      const seconds = (Date.now() - t0) / 1000;
      const progress = parseSolverLog(stdout);
      const ok = !overLimit && code === 0 && existsSync(output);
      if (!ok) rmSync(output, { force: true });
      resolve({
        ok,
        code,
        reason: overLimit ? 'memory' : ok ? undefined : 'error',
        seconds,
        peakMB: peak ? Math.round(peak) : null,
        iterations: progress.iterations,
        exploitability: progress.exploitability,
      });
    });
  });
}

ensureDir(runLog);
const results = [];
for (let i = 0; i < todo.length; i++) {
  const job = todo[i];
  process.stdout.write(`[${i + 1}/${todo.length}] ${job.spot} ${job.flop} ... `);
  if (!(await waitForMemory(job))) {
    console.log('skipped: not enough free RAM after 10 minutes. Close other apps and run again.');
    continue;
  }
  const r = await solveOne(job);
  const record = { spot: job.spot, flop: job.flop, ...r, finishedAt: new Date().toISOString() };
  appendFileSync(runLog, `${JSON.stringify(record)}\n`);
  const ram = r.peakMB ? `, peak RAM ${(r.peakMB / 1024).toFixed(1)} GB` : '';
  if (r.ok) {
    ensureDir(paths.log(job.spot, job.flop));
    writeFileSync(paths.log(job.spot, job.flop), JSON.stringify(record, null, 1));
    results.push(record);
    console.log(
      `${formatDuration(r.seconds)}, ${r.iterations ?? '?'} iterations, exploitability ${r.exploitability ?? '?'}% of pot${ram}. Remaining: ${estimate(todo.slice(i + 1))}`,
    );
  } else if (r.reason === 'memory') {
    console.log(
      `STOPPED at ${maxGB.toFixed(1)} GB${ram}. This solve needs more memory: close other apps and raise --max-gb, or use a smaller tree (make-configs --tree laptop, or fewer sizes in src/flops/tree-config.js).`,
    );
  } else {
    console.log(`FAILED (exit code ${r.code})${ram}. See solver-work/logs/runs.jsonl; continuing.`);
  }
}

if (args.bench) {
  console.log('\nBenchmark (one flop per spot):');
  for (const r of results) {
    console.log(
      `  ${r.spot.padEnd(12)} ${r.flop.padEnd(8)} ${formatDuration(r.seconds).padStart(8)}  peak RAM ${r.peakMB ? `${(r.peakMB / 1024).toFixed(1)} GB` : '?'}  ` +
        `-> about ${formatDuration(r.seconds * flops.length)} for all ${flops.length} flops`,
    );
  }
  const total = results.reduce((s, r) => s + r.seconds * flops.length, 0);
  if (results.length) console.log(`  Full library (${results.length} spot${results.length === 1 ? '' : 's'}): about ${formatDuration(total)}.`);
}
