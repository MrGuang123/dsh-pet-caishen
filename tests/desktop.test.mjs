import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createDesktopController, resolveNativeExecutable, NATIVE_PROTOCOL } from "../lib/desktop.js";

test("GitHub installs use the bundled companion without a local build directory", () => {
  assert.match(resolveNativeExecutable(() => false), /\/native\/Acai\.app\/Contents\/MacOS\/Acai$/);
  assert.match(resolveNativeExecutable(() => true), /\/build\/Acai\.app\/Contents\/MacOS\/Acai$/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { hello = true, protocol = NATIVE_PROTOCOL, ...overrides } = {}) {
  const children = [];
  const calls = [];
  const controller = createDesktopController({
    getBridge: () => ({ launchURL: "http://127.0.0.1:54321/launch?token=private", baseURL: "http://127.0.0.1:54321/" }),
    platform: "darwin", parentPID: 12345, executable: "/fixture/Acai",
    checkAvailable: async () => true,
    visibilityTimeout: 200,
    protocolTimeout: 100,
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, killed: false, signals: [], input: "" });
      child.stdin.on("data", chunk => { child.input += chunk; });
      child.kill = signal => { child.killed = true; child.signals.push(signal); return true; };
      child.report = visible => child.stdout.write(JSON.stringify({ type: "visibility", visible }) + "\n");
      child.hello = (version = protocol) => child.stdout.write(JSON.stringify({ type: "hello", protocol: version }) + "\n");
      child.exit = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit("exit", code, signal); };
      children.push(child);
      queueMicrotask(() => { if (hello) child.hello(); child.emit("spawn"); });
      return child;
    },
    ...overrides
  });
  t.after(() => controller.dispose());
  return { controller, children, calls };
}

test("desktop visibility waits for native confirmation; credentials use stdin only", async t => {
  const { controller, children, calls } = fixture(t);
  let resolved = false;
  const launch = controller.start().then(() => { resolved = true; });
  await tick();
  assert.equal(controller.getStatus().running, true);
  assert.equal(controller.getStatus().visible, false);
  assert.equal(resolved, false);
  assert.deepEqual(calls[0], { executable: "/fixture/Acai", args: [], options: { stdio: ["pipe", "pipe", "pipe"] } });
  assert.deepEqual(JSON.parse(children[0].input), { launchURL: "http://127.0.0.1:54321/launch?token=private", baseURL: "http://127.0.0.1:54321/", parentPID: 12345 });
  children[0].stdout.write('{"type":"visibility",');
  children[0].stdout.write('"visible":true}\n');
  await launch;
  assert.equal(controller.getStatus().visible, true);
});

test("toggle hides and reveals the same process only after reported state", async t => {
  const { controller, children } = fixture(t);
  const launch = controller.start();
  await tick();
  const child = children[0];
  child.report(true);
  await launch;
  let hidden = false;
  const hiding = controller.toggle().then(() => { hidden = true; });
  await tick();
  assert.deepEqual(child.signals, ["SIGUSR2"]);
  assert.equal(child.killed, true);
  assert.equal(controller.getStatus().running, true, "a control signal must not mark ChildProcess as exited");
  assert.equal(controller.getStatus().visible, true);
  assert.equal(hidden, false);
  child.report(false);
  await hiding;
  assert.equal(controller.getStatus().visible, false);
  const showing = controller.toggle();
  assert.deepEqual(child.signals, ["SIGUSR2", "SIGUSR1"]);
  assert.equal(controller.getStatus().visible, false);
  child.report(true);
  await showing;
  assert.equal(controller.getStatus().running, true);
  assert.equal(children.length, 1);
  await controller.start(); // Idempotent reveal needs no new state-change report.
  assert.equal(children.length, 1);
  assert.equal(child.signals.at(-1), "SIGUSR1");
});

test("coin animation is written only while the pet is reported visible", async t => {
  const { controller, children } = fixture(t);
  const launch = controller.start();
  await tick();
  const child = children[0];
  child.report(true);
  await launch;
  assert.equal(controller.animate("coin"), true);
  assert.equal(controller.animate("other"), false);
  assert.deepEqual(JSON.parse(child.input.trim().split("\n").at(-1)), { type: "animate", name: "coin" });
  const hiding = controller.hide();
  await tick();
  child.report(false);
  await hiding;
  assert.equal(controller.animate("coin"), false);
});

test("menu, shortcut and web visibility reports update status without a host command", async t => {
  const { controller, children } = fixture(t);
  const launch = controller.start();
  await tick();
  children[0].report(true);
  await launch;
  children[0].report(false);
  assert.equal(controller.getStatus().visible, false);
  assert.equal(controller.getStatus().running, true);
  children[0].report(true);
  assert.equal(controller.getStatus().visible, true);
});

test("stdout parser ignores unrelated, malformed and overlong lines and recovers", async t => {
  const { controller, children } = fixture(t);
  const launch = controller.start();
  await tick();
  const { stdout } = children[0];
  stdout.write('Acai configuration is valid.\n{"type":"visibility","visible":"true"}\n');
  stdout.write("x".repeat(4090));
  stdout.write('x'.repeat(30) + '{"type":"visibility","visible":true}\n');
  assert.equal(controller.getStatus().visible, false);
  children[0].report(true);
  await launch;
  assert.equal(controller.getStatus().visible, true);
});

test("hide during bootstrap waits for initial visibility before sending SIGUSR2", async t => {
  const { controller, children } = fixture(t);
  const launch = controller.start();
  const hiding = controller.hide();
  await tick();
  assert.deepEqual(children[0].signals, []);
  children[0].report(true);
  await launch;
  await tick();
  assert.deepEqual(children[0].signals, ["SIGUSR2"]);
  children[0].report(false);
  await hiding;
  await controller.hide(); // Idempotent hide also needs no new report.
  assert.equal(controller.getStatus().visible, false);
});

test("native exit rejects a pending command and clears visible state", async t => {
  const { controller, children } = fixture(t);
  const launch = controller.start();
  await tick();
  children[0].report(true);
  await launch;
  const hiding = controller.hide();
  const rejected = assert.rejects(hiding, /已退出/);
  children[0].exit();
  await rejected;
  assert.equal(controller.getStatus().running, false);
  assert.equal(controller.getStatus().visible, false);
  children[0].report(true);
  assert.equal(controller.getStatus().visible, false, "late data from an exited process is ignored");
});

test("missing confirmation times out, stops the stale child and does not invent a visible state", async t => {
  const { controller, children } = fixture(t, { visibilityTimeout: 15 });
  await assert.rejects(controller.start(), /确认超时/);
  assert.equal(controller.getStatus().running, false);
  assert.equal(controller.getStatus().visible, false);
  assert.match(controller.getStatus().error, /确认超时/);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
});

test("a native binary without a protocol handshake is stopped with a rebuild hint", async t => {
  const { controller, children } = fixture(t, { hello: false, protocolTimeout: 15 });
  await assert.rejects(controller.start(), /版本握手.*build:macos/);
  assert.equal(controller.getStatus().running, false);
  assert.match(controller.getStatus().error, /build:macos/);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
});

test("a mismatched native protocol is rejected before the pet is treated as visible", async t => {
  const { controller, children } = fixture(t, { protocol: NATIVE_PROTOCOL - 1, protocolTimeout: 15 });
  await assert.rejects(controller.start(), /协议不匹配/);
  assert.equal(controller.getStatus().running, false);
  assert.match(controller.getStatus().error, /build:macos/);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
});

test("unavailable native program cannot launch; dispose terminates even after control signals", async t => {
  const unavailable = fixture(t, { checkAvailable: async () => false });
  assert.equal(await unavailable.controller.refresh(), false);
  await assert.rejects(unavailable.controller.start(), /请重新安装插件/);
  assert.equal(unavailable.children.length, 0);
  const { controller, children } = fixture(t);
  const launch = controller.start();
  await tick();
  children[0].report(true);
  await launch;
  await controller.start();
  controller.dispose();
  assert.deepEqual(children[0].signals, ["SIGUSR1", "SIGTERM"]);
  assert.equal(controller.getStatus().visible, false);
  assert.equal(controller.getStatus().running, false);
  await assert.rejects(controller.start(), /已停用/);
});
