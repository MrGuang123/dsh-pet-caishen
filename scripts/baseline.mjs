import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Development-only, synthetic data. Never attach to an existing pet or enumerate
// process arguments. The copied bundle has an isolated preferences domain.
const root = resolve(new URL('../', import.meta.url).pathname);
const source = resolve(process.argv.find(v => v.startsWith('--source='))?.slice(9) || root);
const directory = join(root, 'output', `baseline-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const app = join(directory, 'AcaiBaseline.app');
await cp(join(root, 'native/Acai.app'), app, { recursive: true });
const plist = join(app, 'Contents/Info.plist');
const bundleId = `dev.dsh.pet.baseline.${randomUUID().replaceAll('-', '')}`;
await writeFile(plist, (await readFile(plist, 'utf8')).replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+/, `$1${bundleId}`));
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
const { createStateStore } = await import(pathToFileURL(join(source, 'lib/state.js')));
const { startBridge } = await import(pathToFileURL(join(source, 'lib/bridge-server.js')));
const store = createStateStore({ mode: 'demo' });
store.upsertSession({ sessionId: 'synthetic', title: '隔离基线', status: 'idle' });
const bridge = await startBridge({ store, mode: 'demo' });
const child = spawn(join(app, 'Contents/MacOS/Acai'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
child.stdout.resume();
child.stdin.on('error', () => {});
child.stdin.write(JSON.stringify({ launchURL: bridge.launchURL, baseURL: bridge.baseURL, parentPID: process.pid }) + '\n');
let stopped = false;
async function cleanup() {
  if (stopped) return;
  stopped = true;
  if (child.exitCode === null) child.kill('SIGTERM');
  await bridge.close();
}
process.once('SIGINT', () => void cleanup());
process.once('SIGTERM', () => void cleanup());
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sample() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [pid, ppid, cpu, rssKiB] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid, cpu, rssKiB };
  });
  const ids = new Set([child.pid]);
  for (let i = 0; i < rows.length; i++) for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
  const owned = rows.filter(r => ids.has(r.pid) || r.pid === process.pid);
  return { cpuPercent: owned.reduce((n, r) => n + r.cpu, 0), rssMiB: owned.reduce((n, r) => n + r.rssKiB, 0) / 1024, processCount: owned.length };
}
const report = { createdAt: new Date().toISOString(), architecture: process.arch, platform: process.platform,
  type: 'isolated-native-synthetic', sampleNotes: 'ps %cpu is a decayed estimate, RSS sums may share pages; WebKit XPC outside descendants is not attributable. No total-app or power claim.',
  gpu: null, energy: null, frameTime: null, wakeups: null, drag: { measured: false, reason: 'requires physical native input' }, scenes: {} };
try {
  await sleep(5000);
  for (const scene of ['idle', 'running', 'hidden']) {
    if (child.exitCode !== null) throw new Error('native_exit');
    store.upsertSession({ sessionId: 'synthetic', title: '隔离基线', status: scene === 'running' ? 'running' : 'idle' });
    if (scene === 'hidden') child.kill('SIGUSR2');
    console.log(`baseline stage: ${scene}`);
    await sleep(2000);
    const samples = [];
    for (let i = 0; i < 8; i++) { samples.push(sample()); await sleep(1000); }
    report.scenes[scene] = { samples, meanCpuPercent: samples.reduce((n, r) => n + r.cpuPercent, 0) / samples.length, meanRssMiB: samples.reduce((n, r) => n + r.rssMiB, 0) / samples.length };
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`baseline report: ${join(directory, 'report.json')}`);
} catch {
  console.error('baseline failed: native_or_sampling_unavailable');
  process.exitCode = 1;
} finally { await cleanup(); }
