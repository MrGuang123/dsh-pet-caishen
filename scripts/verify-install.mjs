import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await realpath(await mkdtemp(join(tmpdir(), 'acai-install-')));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--cache', join(temporary, 'cache'), '--pack-destination', temporary]))[0];
  run('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
  const installed = join(temporary, 'package');
  await assert.rejects(access(join(installed, 'build')));
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-pet-caishen');
  const desktop = await import(pathToFileURL(join(installed, 'lib/desktop.js')));
  assert.equal(desktop.NATIVE_EXECUTABLE, join(installed, 'native/Acai.app/Contents/MacOS/Acai'));
  await import(pathToFileURL(join(installed, 'lib/index.js')));
  const artifact = await import(pathToFileURL(join(installed, 'scripts/native-artifact.mjs')));
  assert.deepEqual(await artifact.describeNative(), JSON.parse(await readFile(join(installed, 'native/manifest.json'), 'utf8')));
  if (process.platform === 'darwin') {
    assert.equal(await desktop.nativeAvailable(), true);
    const config = { launchURL: 'http://127.0.0.1:54321/', baseURL: 'http://127.0.0.1:54321/', parentPID: process.pid };
    assert.match(run(desktop.NATIVE_EXECUTABLE, ['--check-config'], { input: JSON.stringify(config) + '\n' }), /configuration is valid/);
    run('codesign', ['--verify', '--strict', '--all-architectures', join(installed, 'native/Acai.app')]);
  }
  for (const path of ['lib/client.js', 'cordis.patch.yml', 'locale/zh.json', 'assets/acai.svg', 'companion/web/drag.js']) await access(join(installed, path));
  console.log(`Clean package install verified: ${pkg.version}, bundled companion selected without build/, no install scripts or downloads.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
