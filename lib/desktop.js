import { access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export function resolveNativeExecutable(exists = existsSync) {
  const local = fileURLToPath(new URL("../build/Acai.app/Contents/MacOS/Acai", import.meta.url));
  const bundled = fileURLToPath(new URL("../native/Acai.app/Contents/MacOS/Acai", import.meta.url));
  return exists(local) ? local : bundled;
}
export const NATIVE_EXECUTABLE = resolveNativeExecutable();
/** Must match the `hello` line printed by companion/macos/main.swift. */
export const NATIVE_PROTOCOL = 4;

export async function nativeAvailable({ platform = process.platform, executable = NATIVE_EXECUTABLE } = {}) {
  if (platform !== "darwin") return false;
  try { await access(executable, constants.X_OK); return true; }
  catch { return false; }
}

export function focusDsh() {
  if (process.platform !== "darwin") return Promise.reject(new Error("首版桌面导航仅支持 macOS"));
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-b", "com.deepseek.dsh"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("未能唤回 DSH，请确认已安装桌面版")));
  });
}

export function createDesktopController({
  getBridge, instanceId, parentPID = process.pid, executable = NATIVE_EXECUTABLE,
  platform = process.platform, spawnProcess = spawn,
  checkAvailable = () => nativeAvailable({ platform, executable }),
  visibilityTimeout = 3000,
  protocolTimeout = 2000,
  rendererTimeout = 15000
} = {}) {
  let child = null;
  let launch = null;
  let error = null;
  let disposed = false;
  let available = false;
  let visible = false;
  let visibilityReported = false;
  let nativeProtocol = null;
  let nativeVersion = null;
  let rendererReady = false;
  let shortcut = "unknown";
  const pendingRenderer = new Set();
  const pendingVisibility = new Set();
  const pendingProtocol = new Set();
  const supported = platform === "darwin";
  // ChildProcess.killed becomes true after *any* successfully sent signal,
  // including SIGUSR1/SIGUSR2; it does not mean the process has exited.
  const running = () => Boolean(child && child.exitCode === null && child.signalCode == null);
  function protocolMismatch() {
    return new Error(`阿财原生程序协议不匹配（需要 ${NATIVE_PROTOCOL}，实际 ${nativeProtocol}），请重新运行 npm run build:macos`);
  }
  function settleProtocol(processChild, cause) {
    for (const pending of pendingProtocol) {
      if (pending.child !== processChild) continue;
      pendingProtocol.delete(pending);
      clearTimeout(pending.timer);
      if (cause) pending.reject(cause);
      else if (nativeProtocol === NATIVE_PROTOCOL) pending.resolve();
      else pending.reject(protocolMismatch());
    }
  }
  function waitForProtocol(processChild) {
    if (child !== processChild || !running()) return Promise.reject(new Error("阿财伴随程序已退出，请重新唤醒"));
    if (nativeProtocol !== null) return nativeProtocol === NATIVE_PROTOCOL ? Promise.resolve() : Promise.reject(protocolMismatch());
    return new Promise((resolve, reject) => {
      const pending = { child: processChild, resolve, reject };
      pending.timer = setTimeout(() => {
        pendingProtocol.delete(pending);
        reject(new Error("阿财原生程序未响应版本握手，请运行 npm run build:macos 后重试"));
      }, protocolTimeout);
      pendingProtocol.add(pending);
    });
  }
  function settleVisibility(processChild, cause) {
    for (const pending of pendingVisibility) {
      if (pending.child !== processChild) continue;
      if (!cause && (!visibilityReported || visible !== pending.visible)) continue;
      pendingVisibility.delete(pending);
      clearTimeout(pending.timer);
      if (cause) pending.reject(cause); else pending.resolve();
    }
  }
  function waitForVisibility(processChild, target) {
    if (child !== processChild || !running()) return Promise.reject(new Error("阿财伴随程序已退出，请重新唤醒"));
    if (visibilityReported && visible === target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const pending = { child: processChild, visible: target, resolve, reject };
      pending.timer = setTimeout(() => {
        pendingVisibility.delete(pending);
        reject(new Error("阿财显示状态确认超时，请重试"));
      }, visibilityTimeout);
      pendingVisibility.add(pending);
    });
  }
  function settleRenderer(processChild, cause) {
    for (const pending of pendingRenderer) {
      if (pending.child !== processChild || !cause && !rendererReady) continue;
      pendingRenderer.delete(pending); clearTimeout(pending.timer);
      if (cause) pending.reject(cause); else pending.resolve();
    }
  }
  function waitForRenderer(processChild) {
    if (rendererReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const pending = { child: processChild, resolve, reject };
      pending.timer = setTimeout(() => { pendingRenderer.delete(pending); reject(new Error('阿财画面尚未就绪，请从菜单栏重新加载')); }, rendererTimeout);
      pendingRenderer.add(pending);
    });
  }
  function observeVisibility(processChild) {
    const decoder = new StringDecoder("utf8");
    let line = "";
    let dropping = false;
    processChild.stdout.on("data", chunk => {
      if (child !== processChild || disposed) return;
      const data = decoder.write(chunk);
      let start = 0;
      while (start < data.length) {
        const newline = data.indexOf("\n", start);
        const end = newline === -1 ? data.length : newline;
        if (!dropping) {
          if (line.length + end - start > 4096) { line = ""; dropping = true; }
          else line += data.slice(start, end);
        }
        if (newline === -1) break;
        if (!dropping) {
          try {
            const event = JSON.parse(line);
            if (event?.type === "hello" && Number.isInteger(event.protocol)) {
              nativeProtocol = event.protocol;
              nativeVersion = typeof event.version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(event.version) ? event.version : null;
              settleProtocol(processChild);
            } else if (event?.type === 'renderer' && typeof event.ready === 'boolean') {
              rendererReady = event.ready; settleRenderer(processChild);
            } else if (event?.type === 'shortcut' && ['registered','conflict','disabled'].includes(event.state)) {
              shortcut = event.state;
            } else if (event?.type === "visibility" && typeof event.visible === "boolean") {
              visibilityReported = true;
              visible = event.visible;
              settleVisibility(processChild);
            }
          } catch { /* Ignore unrelated or malformed stdout; never echo it. */ }
        }
        line = "";
        dropping = false;
        start = newline + 1;
      }
    });
  }
  function sendVisibilitySignal(processChild, target) {
    if (!processChild.kill(target ? "SIGUSR1" : "SIGUSR2")) throw new Error("未能通知阿财，请重新唤醒");
    return waitForVisibility(processChild, target);
  }
  const controller = {
    async refresh() { available = await checkAvailable(); return available; },
    getStatus() { return { supported, available, running: running(), visible: running() && visibilityReported && visible, rendererReady: running() && rendererReady, nativeVersion: running() ? nativeVersion : null, shortcut, error }; },
    async start() {
      if (disposed) throw new Error("阿财插件已停用");
      if (launch) return launch;
      launch = (async () => {
        if (running()) {
          error = null;
          await sendVisibilitySignal(child, true);
          return;
        }
        available = await checkAvailable();
        if (!available) throw new Error(supported ? "阿财原生程序缺失或不可执行，请重新安装插件；源码开发可运行 npm run build:macos" : "首版原生伴随程序仅支持 macOS 13+");
        const bridge = getBridge();
        if (!bridge) throw new Error("本机桥接尚未准备好，请稍后重试");
        if (disposed) return;
        error = null;
        const processChild = spawnProcess(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
        child = processChild;
        nativeProtocol = null; nativeVersion = null;
        rendererReady = false; shortcut = "unknown";
        visible = false;
        visibilityReported = false;
        observeVisibility(processChild);
        processChild.stderr.resume();
        processChild.stdin.on("error", () => {});
        processChild.once("exit", (code, signal) => {
          settleRenderer(processChild, new Error("阿财伴随程序已退出，请重新唤醒"));
          settleProtocol(processChild, new Error("阿财伴随程序已退出，请重新唤醒"));
          settleVisibility(processChild, new Error("阿财伴随程序已退出，请重新唤醒"));
          if (child === processChild) {
            child = null;
            nativeProtocol = null;
            visible = false;
            visibilityReported = false;
            if (!disposed && code !== 0) error = "阿财伴随程序已退出，请重新唤醒";
          }
        });
        await new Promise((resolve, reject) => {
          processChild.once("error", event => {
            settleProtocol(processChild, event);
            settleVisibility(processChild, event);
            if (child === processChild) { child = null; nativeProtocol = null; visible = false; visibilityReported = false; }
            reject(event);
          });
          processChild.once("spawn", resolve);
        });
        if (disposed) { processChild.kill(); return; }
        // Credentials stay out of process arguments and application logs.
        // Keep stdin open: later animation commands use the same one-line channel.
        processChild.stdin.write(JSON.stringify({ launchURL: bridge.launchURL, baseURL: bridge.baseURL, parentPID, ...(instanceId ? { instanceId } : {}) }) + "\n");
        try {
          // A stale or foreign binary must not leave an uncontrolled pet on screen.
          await waitForProtocol(processChild);
          await waitForVisibility(processChild, true);
          await waitForRenderer(processChild);
        } catch (cause) {
          if (child === processChild) {
            child = null;
            nativeProtocol = null;
            visible = false;
            visibilityReported = false;
            if (processChild.exitCode === null && processChild.signalCode == null) processChild.kill("SIGTERM");
          }
          throw cause;
        }
      })().catch(cause => { error = cause.message; throw cause; }).finally(() => { launch = null; });
      return launch;
    },
    async hide() {
      if (disposed) throw new Error("阿财插件已停用");
      try {
        // Do not lose SIGUSR2 while the native app is still bootstrapping.
        if (launch) await launch;
        if (!running()) return;
        error = null;
        await sendVisibilitySignal(child, false);
      } catch (cause) { error = cause.message; throw cause; }
    },
    async toggle() {
      if (running() && visibilityReported && visible) await controller.hide();
      else await controller.start();
    },
    animate(name) {
      if (disposed || name !== "coin" || !running() || !visibilityReported || !visible) return false;
      const stream = child.stdin;
      if (!stream || !stream.writable || stream.destroyed || stream.writableEnded) return false;
      try {
        stream.write(JSON.stringify({ type: "animate", name }) + "\n");
        return true;
      } catch { return false; }
    },
    dispose() {
      disposed = true;
      if (child) {
        settleProtocol(child, new Error("阿财插件已停用"));
        settleVisibility(child, new Error("阿财插件已停用"));
        settleRenderer(child, new Error("阿财插件已停用"));
        if (running()) child.kill("SIGTERM");
      }
      child = null;
      nativeProtocol = null;
      visible = false;
      visibilityReported = false;
    }
  };
  return controller;
}
