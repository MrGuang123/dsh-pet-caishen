import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

export async function describeNative(directory = root) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const desktop = await readFile(join(directory, 'lib/desktop.js'), 'utf8');
  const protocol = Number(desktop.match(/export const NATIVE_PROTOCOL = (\d+);/)?.[1]);
  if (!protocol) throw new Error('Cannot read the native protocol.');
  const sources = (await readdir(join(directory, 'companion/macos'))).filter(name => name.endsWith('.swift')).sort();
  const hash = createHash('sha256').update(JSON.stringify({ version: pkg.version, protocol }));
  for (const path of [...sources.map(name => `companion/macos/${name}`), 'scripts/build-macos.mjs']) {
    hash.update(path).update(await readFile(join(directory, path)));
  }
  const files = {};
  async function walk(relative) {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[path] = digest(await readFile(join(directory, path)));
      else throw new Error(`Unexpected symlink or special file: ${path}`);
    }
  }
  await walk('native/Acai.app');
  const executable = join(directory, 'native/Acai.app/Contents/MacOS/Acai');
  if (!((await stat(executable)).mode & 0o111)) throw new Error('Bundled Acai is not executable.');
  const binary = await readFile(executable);
  if (binary.readUInt32BE(0) !== 0xcafebabe || binary.readUInt32BE(4) !== 2) throw new Error('Expected a two-architecture universal Mach-O binary.');
  const cpus = [binary.readUInt32BE(8), binary.readUInt32BE(28)].sort();
  if (JSON.stringify(cpus) !== JSON.stringify([0x01000007, 0x0100000c])) throw new Error('Expected x86_64 and arm64 slices.');
  return { version: pkg.version, protocol, architectures: ['arm64', 'x86_64'], sourcesSha256: hash.digest('hex'), files };
}
