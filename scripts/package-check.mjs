import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cache = await mkdtemp(join(tmpdir(), "acai-package-cache-"));
let result;
try { result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache], { encoding: "utf8" }); }
finally { await rm(cache, { recursive: true, force: true }); }
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
const info = JSON.parse(result.stdout)[0];
const paths = info.files.map(file => file.path);
for (const path of ["package.json", "lib/index.js", "lib/client.js", "lib/dsh-adapter.js", "companion/web/index.html", "companion/web/app.js", "companion/web/layout.js", "companion/web/drag.js", "companion/web/styles.css", "assets/acai.svg", "cordis.patch.yml", "docs/PRODUCT.md", "native/manifest.json", "native/Acai.app/Contents/MacOS/Acai", "native/Acai.app/Contents/Info.plist", "scripts/build-macos.mjs", "companion/macos/main.swift"]) {
  if (!paths.includes(path)) throw new Error(`安装包缺少 ${path}`);
}
for (const path of paths) {
  if (/(^|\/)(\.git|node_modules|\.module-cache|\.env)(\/|$)/.test(path) || /^(output|build)\//.test(path)) throw new Error(`不应发布 ${path}`);
}
if (process.platform === "darwin") {
  const binary = "native/Acai.app/Contents/MacOS/Acai";
  await access(binary);
  if (!paths.includes(binary)) throw new Error("安装包未包含已构建的原生程序");
}
console.log(`Package check passed: ${paths.length} files, ${info.unpackedSize} unpacked bytes. Nothing published.`);
