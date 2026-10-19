import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const COOKIE = "acai_session";
const MAX_BODY = 16 * 1024;
const WEB = new URL("../companion/web/", import.meta.url);
const STATIC = new Map([
  ["/", [new URL("index.html", WEB), "text/html; charset=utf-8"]],
  ["/app.js", [new URL("app.js", WEB), "text/javascript; charset=utf-8"]],
  ["/character.js", [new URL("character.js", WEB), "text/javascript; charset=utf-8"]],
  ["/layout.js", [new URL("layout.js", WEB), "text/javascript; charset=utf-8"]],
  ["/drag.js", [new URL("drag.js", WEB), "text/javascript; charset=utf-8"]],
  ["/styles.css", [new URL("styles.css", WEB), "text/css; charset=utf-8"]],
  ["/assets/acai.svg", [new URL("../assets/acai.svg", import.meta.url), "image/svg+xml"]]
]);

function equal(a, b) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

export async function readJson(request, limit = MAX_BODY) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    const error = new Error("需要 JSON 请求"); error.status = 415; throw error;
  }
  if (Number(request.headers["content-length"]) > limit) {
    request.resume();
    const error = new Error("请求过大"); error.status = 413; throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { const error = new Error("请求过大"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("JSON 格式错误"); error.status = 400; throw error; }
  if (!value || typeof value !== "object" || Array.isArray(value)) { const error = new Error("需要 JSON 对象"); error.status = 400; throw error; }
  return value;
}

/** A credentialed loopback origin, never a public web server or generic command endpoint. */
export async function startBridge({ store, savePreferences = async () => {}, onOpenSession = async () => {}, onReturnSession = async () => {}, mode = "dsh", port = 0 } = {}) {
  if (!store) throw new TypeError("缺少状态 store");
  const token = randomBytes(32).toString("hex");
  const session = randomBytes(32).toString("hex");
  let origin;
  let preferenceQueue = Promise.resolve();
  let closing = false;
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("x-content-type-options", "nosniff");
    if (closing || request.headers.host !== new URL(origin).host) { json(response, 403, { error: "不允许的 Host" }); return; }
    try {
      let url;
      try { url = new URL(request.url ?? "/", origin); }
      catch { json(response, 400, { error: "请求地址格式错误" }); return; }
      if (request.method === "GET" && url.pathname === "/health") { json(response, 200, { ok: true, version: 1 }); return; }
      // Keep web navigation from embedding the credentialed application in another origin.
      if (request.headers["sec-fetch-site"] === "cross-site") { json(response, 403, { error: "禁止跨站请求" }); return; }
      if (request.method === "GET" && url.pathname === "/launch") {
        if (!equal(url.searchParams.get("token"), token)) { json(response, 401, { error: "登录凭证无效" }); return; }
        response.writeHead(303, { location: "/", "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
        response.end(); return;
      }
      const cookies = String(request.headers.cookie ?? "").split(";").map(item => item.trim());
      if (!cookies.some(item => equal(item, `${COOKIE}=${session}`))) { json(response, 401, { error: "请通过阿财启动入口登录" }); return; }
      if (request.method === "GET" && url.pathname === "/api/state") { json(response, 200, store.getSnapshot()); return; }
      if (request.method === "POST") {
        if (request.headers["x-acai-client"] !== "companion-v1" || request.headers.origin !== origin) { json(response, 403, { error: "拒绝非同源操作" }); return; }
        const data = await readJson(request);
        if (url.pathname === "/api/preferences") {
          // Validate, persist, then publish; failed disk writes leave visible state unchanged.
          const operation = preferenceQueue.catch(() => {}).then(async () => {
            const { validatePreferences } = await import("./state.js");
            const next = validatePreferences(data, store.getSnapshot().preferences);
            await savePreferences(next);
            store.setPreferences(next);
            return next;
          });
          preferenceQueue = operation;
          json(response, 200, { ok: true, preferences: await operation }); return;
        }
        if (url.pathname === "/api/action") {
          if (data.type === "fortune") { json(response, 200, { ok: true, fortune: { text: store.nextFortune() } }); return; }
          if (data.type === "interact") { json(response, 200, { ok: true }); return; }
          if (data.type === "return-session") {
            await onReturnSession(store.getLastSessionId());
            json(response, 200, { ok: true }); return;
          }
          if (data.type === "open-session") {
            const id = data.sessionId ?? store.getSnapshot().activity.sessionId;
            if (!id || !store.getSession(id)) { json(response, 409, { error: "当前没有可打开的 DSH 会话" }); return; }
            await onOpenSession(id);
            json(response, 200, { ok: true }); return;
          }
          json(response, 400, { error: "不支持的操作" }); return;
        }
        if (url.pathname === "/api/demo" && mode === "demo") {
          if (data.status === "offline") store.setConnected(false);
          else {
            store.upsertSession({ sessionId: "demo-session", title: data.title ?? "阿财演示任务", status: data.status, updatedAt: Date.now() });
            store.setConnected(true);
          }
          json(response, 200, { ok: true }); return;
        }
      }
      if ((request.method === "GET" || request.method === "HEAD") && STATIC.has(url.pathname)) {
        const [file, type] = STATIC.get(url.pathname);
        const body = await readFile(fileURLToPath(file));
        response.writeHead(200, { "content-type": type, "content-length": body.byteLength, "cache-control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : body); return;
      }
      json(response, 404, { error: "未找到该入口" });
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? (error instanceof TypeError || error instanceof RangeError ? 400 : 500), { error: error.status || error instanceof TypeError || error instanceof RangeError ? error.message : "阿财本机服务暂时不可用" });
      else response.end();
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  server.on("error", () => {});
  return {
    baseURL: origin + "/", launchURL: `${origin}/launch?token=${token}`,
    async close() {
      if (closing) return;
      closing = true;
      await preferenceQueue.catch(() => {});
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
    }
  };
}
