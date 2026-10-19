import { homedir } from "node:os";
import { join } from "node:path";
import { createStateStore } from "./state.js";
import { startBridge } from "./bridge-server.js";
import { createPreferenceWriter, loadPreferences } from "./preferences.js";
import { createDesktopController, focusDsh } from "./desktop.js";
import { createNavigationQueue, createDshHandler } from "./dsh-route.js";
import { attachDshState } from "./dsh-adapter.js";

export const inject = ["agents", "sessionProjections"];

export async function apply(ctx, config = {}) {
  const directory = config.stateDirectory ?? (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "dsh-pet-caishen")
    : join(homedir(), ".local", "share", "dsh-pet-caishen"));
  const path = join(directory, "preferences.json");
  let disposed = false;
  let bridge;
  let adapter;
  const desktop = createDesktopController({ getBridge: () => bridge });
  const navigation = createNavigationQueue();
  const stop = () => {
    if (disposed) return;
    disposed = true;
    navigation.clear();
    adapter?.dispose();
    desktop.dispose();
    return bridge?.close();
  };
  ctx.effect(() => stop, "pet-caishen: companion lifecycle");
  try {
    const preferences = await loadPreferences(path);
    if (disposed) return;
    const store = createStateStore({ preferences });
    adapter = attachDshState(ctx, store);
    bridge = await startBridge({
      store, savePreferences: createPreferenceWriter(path),
      onOpenSession: async sessionId => {
        await focusDsh();
        navigation.enqueue(sessionId);
      },
      onReturnSession: async sessionId => {
        if (sessionId) navigation.enqueue(sessionId);
        await focusDsh();
      }
    });
    if (disposed) { await bridge.close(); return; }
    await desktop.refresh();
    ctx.inject(["webServer"], scope => {
      scope.effect(() => scope.webServer.register({
        kind: "exact", path: "/pet-caishen/bridge",
        handler: createDshHandler({ desktop, navigation, adapter, store })
      }), "pet-caishen: DSH bridge route");
    });
    if (config.autoLaunch !== false && desktop.getStatus().available) {
      // A missing or failed companion remains visible in the DSH control instead of breaking the host.
      await desktop.start().catch(error => ctx.logger?.warn?.("阿财未自动启动：%s", error.message));
    }
  } catch (error) { await stop(); throw error; }
}
