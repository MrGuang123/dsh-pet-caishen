import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, describeNative } from './native-artifact.mjs';

const manifest = JSON.parse(await readFile(join(root, 'native/manifest.json'), 'utf8'));
assert.deepEqual(await describeNative(), manifest, 'Native artifact is stale or modified. Run npm run prepare:native on macOS.');
console.log(`Bundled native verified: ${manifest.version}, protocol ${manifest.protocol}, arm64 + x86_64, source and binary SHA-256.`);
