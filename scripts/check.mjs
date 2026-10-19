import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\.(?:m?js)$/.test(path)) files.push(path);
  }
  return files;
}
const files = (await Promise.all(["lib", "scripts", "companion/web", "tests"].map(walk))).flat();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const zh = JSON.parse(await readFile("locale/zh.json", "utf8"));
const en = JSON.parse(await readFile("locale/en.json", "utf8"));
if (Object.keys(zh.$).sort().join() !== Object.keys(en.$).sort().join()) throw new Error("插件文案键不一致");
for (const locale of [zh, en]) {
  if (!locale.meta?.title?.trim() || !locale.meta?.description?.trim()) throw new Error("DSH 插件展示需要 locale.meta.title 和 description");
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const client = await readFile("lib/client.js", "utf8");
if (!client.includes(`id: "${pkg.name}"`) && !client.includes(`id: '${pkg.name}'`)) throw new Error("模块加载器 id 与包名不一致");
await import("../lib/index.js");
await import("./check-native.mjs");
console.log(`Syntax, host imports, plugin identity and locale checks passed (${files.length} JS files).`);
