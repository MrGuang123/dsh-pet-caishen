import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// A local, dependency-free build for macOS 13+. No installed DSH files are touched.
if (process.platform !== 'darwin') {
  console.error('The Acai macOS companion requires macOS and the Xcode command line tools.');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const universal = process.argv.includes('--universal');
const build = join(root, 'build');
const contents = join(build, 'Acai.app', 'Contents');
const executableDirectory = join(contents, 'MacOS');
const moduleCache = join(build, '.module-cache');
await Promise.all([mkdir(executableDirectory, { recursive: true }), mkdir(moduleCache, { recursive: true })]);

const sourcesDirectory = join(root, 'companion', 'macos');
const sources = (await readdir(sourcesDirectory)).filter(name => name.endsWith('.swift')).sort().map(name => join(sourcesDirectory, name));
if (!sources.length) throw new Error('No Swift companion source files were found.');
const architectures = universal ? ['arm64', 'x86_64'] : [process.arch === 'arm64' ? 'arm64' : 'x86_64'];
const environment = { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULECACHE_PATH: moduleCache };
const executable = join(executableDirectory, 'Acai');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const slices = [];
for (const architecture of architectures) {
  const output = universal ? join(build, `Acai-${architecture}`) : executable;
  run('xcrun', ['swiftc', '-O', '-whole-module-optimization', '-target', `${architecture}-apple-macosx13.0`, '-module-cache-path', moduleCache, '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'Carbon', ...sources, '-o', output]);
  slices.push(output);
}
if (universal) run('xcrun', ['lipo', '-create', ...slices, '-output', executable]);

await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>阿财</string>
  <key>CFBundleExecutable</key><string>Acai</string>
  <key>CFBundleIdentifier</key><string>dev.dsh.pet.caishen</string>
  <key>CFBundleName</key><string>Acai</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`);
await writeFile(join(contents, 'PkgInfo'), 'APPL????');

run('/usr/bin/codesign', ['--force', '--sign', '-', join(build, 'Acai.app')]);
run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', join(build, 'Acai.app')]);
console.log(`Built ${join(build, 'Acai.app')} (${architectures.join(' + ')}, macOS 13+).`);
