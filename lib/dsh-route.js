import { randomUUID } from "node:crypto";
import { json, readJson } from "./bridge-server.js";

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (origin === "dsh-app://app") return true;
  if (!origin) return !request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin";
  try { const url = new URL(origin); return ["http:", "https:"].includes(url.protocol) && url.host === request.headers.host; }
  catch { return false; }
}

/** Navigation is a bounded request consumed by DSH's own client navigation API. */
export function createNavigationQueue({ now = Date.now } = {}) {
  let command = null;
  return {
    enqueue(sessionId) { command = { id: randomUUID(), sessionId, expiresAt: now() + 20_000 }; },
    peek() { if (command && command.expiresAt <= now()) command = null; return command ? { ...command } : null; },
    acknowledge(id) { if (this.peek()?.id !== id) return false; command = null; return true; },
    clear() { command = null; }
  };
}

export function createDshHandler({ desktop, navigation, adapter, store }) {
  return async (request, response) => {
    if (request.headers["x-acai-client"] !== "dsh-plugin-v1" || !allowedOrigin(request)) { json(response, 403, { error: "只接受 DSH 内的同源操作" }); return; }
    try {
      if (request.method === "GET") {
        json(response, 200, { desktop: desktop.getStatus(), command: navigation.peek() }); return;
      }
      if (request.method !== "POST") { json(response, 405, { error: "不支持的请求方法" }); return; }
      const data = await readJson(request, 32 * 1024);
      if (data.type === "launch") {
        await desktop.start(); json(response, 200, { ok: true, desktop: desktop.getStatus() }); return;
      }
      if (data.type === "toggle") {
        await desktop.toggle(); json(response, 200, { ok: true, desktop: desktop.getStatus() }); return;
      }
      if (data.type === "animate") {
        if (data.name !== "coin") { json(response, 400, { error: "不支持的动画" }); return; }
        const accepted = desktop.animate?.("coin") === true;
        json(response, accepted ? 200 : 409, { ok: accepted });
        return;
      }
      if (data.type === "navigation-ack") {
        const command = navigation.peek();
        if (!command || command.id !== data.id || command.sessionId !== data.sessionId) { json(response, 409, { error: "导航请求已失效" }); return; }
        navigation.acknowledge(data.id);
        adapter.acknowledge(data.sessionId);
        json(response, 200, { ok: true }); return;
      }
      if (data.type === "client-pending") {
        if (typeof data.clientId !== "string" || data.clientId.length > 100 || !Array.isArray(data.entries) || data.entries.length > 300) { json(response, 400, { error: "交互状态格式无效" }); return; }
        const entries = data.entries.map(entry => {
          if (typeof entry?.sessionId !== "string" || entry.sessionId.length > 160 || typeof entry.pending !== "boolean") throw new TypeError("交互状态格式无效");
          return { sessionId: entry.sessionId, pending: entry.pending };
        }).filter(entry => store.getSession(entry.sessionId));
        adapter.setClientPending?.(data.clientId, entries);
        json(response, 200, { ok: true }); return;
      }
      if (data.type === "client-focus") {
        if (typeof data.clientId !== "string" || !data.clientId || data.clientId.length > 100) {
          json(response, 400, { error: "客户端标识无效" }); return;
        }
        store.setLastSessionId(data.sessionId);
        json(response, 200, { ok: true }); return;
      }
      json(response, 400, { error: "不支持的操作" });
    } catch (error) {
      json(response, error.status ?? (error instanceof TypeError ? 400 : 503), { error: error.message ?? "阿财暂时不可用" });
    }
  };
}
