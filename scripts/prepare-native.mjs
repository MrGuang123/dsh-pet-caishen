import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root, describeNative } from './native-artifact.mjs';

const built = spawnSync(process.execPath, [join(root, 'scripts/build-macos.mjs'), '--universal'], { cwd: root, stdio: 'inherit' });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
await mkdir(join(root, 'native'), { recursive: true });
await rm(join(root, 'native/Acai.app'), { recursive: true, force: true });
await cp(join(root, 'build/Acai.app'), join(root, 'native/Acai.app'), { recursive: true });
await writeFile(join(root, 'native/manifest.json'), JSON.stringify(await describeNative(), null, 2) + '\n');
console.log('Prepared native/Acai.app and source/binary checksums for GitHub installation.');
