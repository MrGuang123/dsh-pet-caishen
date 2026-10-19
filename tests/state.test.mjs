import test from "node:test";
import assert from "node:assert/strict";
import { createStateStore, validatePreferences } from "../lib/state.js";
import { createNavigationQueue } from "../lib/dsh-route.js";

test("disconnected startup never invents live work", () => {
  const store = createStateStore();
  assert.equal(store.getSnapshot().activity.status, "offline");
  store.upsertSession({ sessionId: "a", title: "任务", status: "running", updatedAt: 1 });
  assert.equal(store.getSnapshot().activity.status, "offline");
  store.setConnected(true);
  assert.equal(store.getSnapshot().activity.status, "running");
});

test("user input and errors outrank completion and background work", () => {
  const store = createStateStore({ mode: "demo" });
  for (const [index, status] of ["running", "ready", "blocked", "waiting"].entries()) {
    store.upsertSession({ sessionId: status, title: status, status, updatedAt: index });
  }
  assert.equal(store.getSnapshot().activity.status, "waiting");
  store.removeSession("waiting");
  assert.equal(store.getSnapshot().activity.status, "blocked");
  store.removeSession("blocked");
  assert.equal(store.getSnapshot().activity.status, "ready");
});

test("stale updates cannot overwrite a newer task transition; snapshots are independent", () => {
  const store = createStateStore({ mode: "demo" });
  store.upsertSession({ sessionId: "s", title: "new", status: "ready", updatedAt: 20 });
  store.upsertSession({ sessionId: "s", title: "old", status: "running", updatedAt: 10 });
  const snapshot = store.getSnapshot();
  snapshot.activity.title = "tampered";
  snapshot.sessions[0].title = "tampered";
  assert.equal(store.getSnapshot().activity.title, "new");
  assert.equal(store.getSnapshot().activity.status, "ready");
});

test("preferences reject malformed fields without changing state", () => {
  const store = createStateStore();
  assert.throws(() => store.setPreferences({ size: 999 }));
  assert.throws(() => store.setPreferences({ quiet: "yes" }));
  assert.throws(() => validatePreferences({ command: "anything" }));
  assert.equal(store.getSnapshot().preferences.size, 160);
  assert.equal(store.setPreferences({ quiet: true }).quiet, true);
});

test("navigation expires and a stale acknowledgement cannot consume a new request", () => {
  let time = 100;
  const queue = createNavigationQueue({ now: () => time });
  queue.enqueue("first");
  const first = queue.peek();
  queue.enqueue("second");
  assert.equal(queue.acknowledge(first.id), false);
  assert.equal(queue.peek().sessionId, "second");
  time += 20_001;
  assert.equal(queue.peek(), null);
});

test("return chat is remembered separately from priority and survives an idle root being unloaded", () => {
  const store = createStateStore({ mode: "demo" });
  store.setLastSessionId("reading-chat");
  store.upsertSession({ sessionId: "background-job", title: "后台工作", status: "waiting" });
  assert.equal(store.getSnapshot().activity.sessionId, "background-job");
  assert.equal(store.getLastSessionId(), "reading-chat");
  store.removeSession("reading-chat");
  assert.equal(store.getLastSessionId(), "reading-chat");
  assert.throws(() => store.setLastSessionId("bad\nvalue"));
  assert.equal(store.getLastSessionId(), "reading-chat");
});
