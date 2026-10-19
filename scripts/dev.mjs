import { spawn } from "node:child_process";
import { createStateStore } from "../lib/state.js";
import { startBridge } from "../lib/bridge-server.js";
import { createDesktopController } from "../lib/desktop.js";

const native = process.argv.includes("--native");
const browser = process.argv.includes("--open");
const store = createStateStore({ mode: "demo" });
store.upsertSession({ sessionId: "demo-session", title: "阿财演示任务", status: "idle", updatedAt: Date.now() });
const demoNavigation = async () => { throw new Error("当前为演示模式，没有真实 DSH 会话"); };
const bridge = await startBridge({ store, mode: "demo", onOpenSession: demoNavigation, onReturnSession: demoNavigation });
const desktop = createDesktopController({ getBridge: () => bridge });
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  desktop.dispose();
  await bridge.close();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop().then(() => process.exit(0)); });
if (native) {
  try { await desktop.start(); console.log("阿财原生演示已启动；Ctrl+C 同时停止服务与窗口。此模式没有连接真实 DSH。"); }
  catch (error) { console.error(error.message); await stop(); process.exitCode = 1; }
} else {
  // This local login URL is printed only for the explicitly requested development preview.
  console.log("阿财浏览器演示（未连接真实 DSH）：\n" + bridge.launchURL + "\nCtrl+C 停止。");
  if (browser && process.platform === "darwin") {
    const opener = spawn("/usr/bin/open", [bridge.launchURL], { stdio: "ignore" });
    opener.on("error", error => console.error(error.message));
  }
}
