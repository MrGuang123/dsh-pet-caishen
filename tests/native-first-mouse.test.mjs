import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// WKWebView's default refuses the activating first mouse while the page is not
// draggable/scrollable. The companion panel is a non-activating NSPanel, so the
// pet must opt into that click or AppKit spends it activating the panel.
test("native companion accepts the first mouse press before the panel is key", { skip: process.platform !== "darwin" }, async t => {
  await mkdir("build", { recursive: true });
  const directory = await mkdtemp("build/first-mouse-test-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = join(directory, "main.swift");
  await writeFile(main, `import AppKit
import WebKit
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let webView = CompanionWebView(frame: .zero, configuration: configuration)
precondition(webView.acceptsFirstMouse(for: nil))
`);
  const binary = join(directory, "first-mouse-check");
  const compiled = spawnSync("xcrun", ["swiftc", "-module-cache-path", "build/.module-cache", "companion/macos/CompanionWebView.swift", main, "-o", binary], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(binary, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
