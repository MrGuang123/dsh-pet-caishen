import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function checkSwift(t, source) {
  await mkdir("build", { recursive: true });
  const directory = await mkdtemp("build/geometry-test-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = join(directory, "main.swift");
  await writeFile(main, `import Foundation\nimport CoreGraphics\n${source}`);
  const binary = join(directory, "geometry-check");
  const compiled = spawnSync("xcrun", ["swiftc", "-module-cache-path", "build/.module-cache", "companion/macos/Geometry.swift", main, "-o", binary], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(binary, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("native drag permits transparent padding offscreen while keeping pet and toolbar reachable", { skip: process.platform !== "darwin" }, async t => {
  await checkSwift(t, `
let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
let right = CompanionGeometry.clampedX(2000, screen: screen, left: 108, right: 319)
precondition(right == 1113)
precondition(right + 319 == screen.maxX - 8)
precondition(right + 420 > screen.maxX)
let left = CompanionGeometry.clampedX(-2000, screen: screen, left: 108, right: 319)
precondition(left == -100)
precondition(left + 108 == screen.minX + 8)
let second = CGRect(x: -1920, y: 0, width: 1920, height: 1080)
precondition(CompanionGeometry.clampedX(-4000, screen: second, left: 108, right: 319) == -2020)
precondition(CompanionGeometry.clampedX(500, screen: screen, left: 108, right: 319) == 500)
`);
});

test("native drag follows a fixed global mouse anchor without cumulative drift", { skip: process.platform !== "darwin" }, async t => {
  await checkSwift(t, `
var drag = CompanionDrag(id: 1, mouseStart: CGPoint(x: 700, y: 500), windowStart: CGPoint(x: 500, y: 300))
precondition(drag.origin(at: CGPoint(x: 702, y: 501)) == nil)
precondition(!drag.moved)
let cursor = CGPoint(x: 780, y: 540)
let expected = CGPoint(x: 580, y: 340)
for _ in 0..<10000 { precondition(drag.origin(at: cursor) == expected) }
precondition(drag.moved)
// Screen points use AppKit's upward-positive Y; there is no CSS Y inversion
// or backing-scale multiplication, including negative-coordinate screens.
precondition(drag.origin(at: CGPoint(x: -20, y: -40)) == CGPoint(x: -220, y: -240))
precondition(drag.origin(at: CGPoint(x: 700, y: 500)) == CGPoint(x: 500, y: 300))
let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
for _ in 0..<1000 {
    let point = drag.origin(at: CGPoint(x: 3000, y: 500))!
    precondition(CompanionGeometry.clampedX(point.x, screen: screen, left: 108, right: 319) == 1113)
}
precondition(drag.origin(at: cursor) == expected)
// A new press anchors to its own position, independent of the previous drag.
var next = CompanionDrag(id: 2, mouseStart: CGPoint(x: -1000, y: 700), windowStart: CGPoint(x: -1200, y: 400))
precondition(next.origin(at: CGPoint(x: -990, y: 680)) == CGPoint(x: -1190, y: 380))
`);
});
