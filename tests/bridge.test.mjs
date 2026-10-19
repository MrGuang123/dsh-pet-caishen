import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { startBridge } from "../lib/bridge-server.js";
import { createStateStore } from "../lib/state.js";
import { createPreferenceWriter, loadPreferences } from "../lib/preferences.js";

async function fixture(t, options = {}) {
  const store = createStateStore({ mode: options.mode ?? "demo" });
  const bridge = await startBridge({ store, mode: options.mode ?? "demo", ...options });
  t.after(() => bridge.close());
  const login = await fetch(bridge.launchURL, { redirect: "manual" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const origin = new URL(bridge.baseURL).origin;
  const request = (path, data, extra = {}) => fetch(new URL(path, bridge.baseURL), {
    method: data === undefined ? "GET" : "POST",
    headers: { cookie, origin, "x-acai-client": "companion-v1", "content-type": "application/json", ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, bridge, request, cookie, origin, login };
}

test("loopback API requires credential and login removes the token from navigation", async t => {
  const { bridge, request, login } = await fixture(t);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(bridge.baseURL + "api/state")).status, 401);
  assert.equal((await request("api/state")).status, 200);
  const dragModule = await request("drag.js");
  assert.equal(dragModule.status, 200);
  assert.match(dragModule.headers.get("content-type"), /javascript/);
  assert.match(await dragModule.text(), /export function attachPetDrag/);
  const denied = await fetch(bridge.baseURL + "launch?token=" + "财".repeat(64), { redirect: "manual" });
  assert.equal(denied.status, 401);
});

test("cross-origin mutations, DNS rebinding and overlarge requests are rejected", async t => {
  const { bridge, request } = await fixture(t);
  assert.equal((await request("api/preferences", { quiet: true }, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await request("api/preferences", { quiet: true }, { "x-acai-client": "" })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL("health", bridge.baseURL), { headers: { host: "attacker.invalid" } }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject); request.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await request("api/preferences", { excess: "x".repeat(20_000) })).status, 413);
});

test("a malformed absolute request target returns 400 and leaves the bridge alive", async t => {
  const { bridge, request } = await fixture(t);
  const endpoint = new URL(bridge.baseURL);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: endpoint.hostname, port: endpoint.port, path: "http://[", headers: { host: endpoint.host } }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject); request.end();
  });
  assert.equal(status, 400);
  assert.equal((await request("api/state")).status, 200);
});

test("invalid or failed preferences do not overwrite the committed state", async t => {
  const { store, request } = await fixture(t, { savePreferences: async () => { throw new Error("disk full"); } });
  assert.equal((await request("api/preferences", { size: 400 })).status, 400);
  assert.equal((await request("api/preferences", { size: 200 })).status, 500);
  assert.equal(store.getSnapshot().preferences.size, 160);
});

test("real DSH mode refuses simulated tasks; navigation is limited to known sessions", async t => {
  const opened = [];
  const { store, request } = await fixture(t, { mode: "dsh", onOpenSession: id => opened.push(id) });
  assert.equal((await request("api/demo", { status: "running" })).status, 404);
  assert.equal((await request("api/action", { type: "open-session", sessionId: "arbitrary" })).status, 409);
  store.setConnected(true);
  store.upsertSession({ sessionId: "known", title: "任务", status: "waiting" });
  assert.equal((await request("api/action", { type: "open-session", sessionId: "known" })).status, 200);
  assert.deepEqual(opened, ["known"]);
  assert.equal((await request("api/action", { type: "run-shell", command: "false" })).status, 400);
});

test("preview can cycle all business states and shows offline honestly", async t => {
  const { request } = await fixture(t);
  for (const status of ["running", "waiting", "ready", "blocked", "idle", "offline"]) {
    assert.equal((await request("api/demo", { status })).status, 200);
    assert.equal((await (await request("api/state")).json()).activity.status, status);
  }
});

test("return-session opens the last selected chat rather than the task with highest priority", async t => {
  const opened = [];
  const { store, request } = await fixture(t, { mode: "dsh", onReturnSession: id => opened.push(id) });
  store.setLastSessionId("reading-chat");
  store.upsertSession({ sessionId: "background-job", status: "waiting" });
  assert.equal((await request("api/action", { type: "return-session", sessionId: "untrusted-target" })).status, 200);
  assert.deepEqual(opened, ["reading-chat"]);
});

test("preference writes are atomic, ordered and contain no conversation data", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acai-preferences-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "preferences.json");
  const save = createPreferenceWriter(path);
  await Promise.all([save({ size: 180 }), save({ size: 220, quiet: true })]);
  const data = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(data, { size: 220, quiet: true, reducedMotion: false, hidden: false });
  assert.deepEqual(await loadPreferences(path), data);
});
