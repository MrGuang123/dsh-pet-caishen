import test from "node:test";
import assert from "node:assert/strict";
import { createDshHandler } from "../lib/dsh-route.js";
import { createStateStore } from "../lib/state.js";

function request(body) {
	const text = JSON.stringify(body);
	return {
		method: "POST",
		headers: {
			"x-acai-client": "dsh-plugin-v1",
			"content-type": "application/json",
			"content-length": String(Buffer.byteLength(text))
		},
		async *[Symbol.asyncIterator]() { yield Buffer.from(text); }
	};
}

function response() {
	const result = { status: 0, body: "" };
	return {
		result,
		writeHead(status) { result.status = status; },
		end(body) { result.body = body; }
	};
}

test("the DSH route forwards only supported one-shot animations", async () => {
	const animations = [];
	const desktop = {
		animate(name) { animations.push(name); return name === "coin"; },
		async start() {}, async toggle() {}, getStatus: () => ({})
	};
	const handler = createDshHandler({
		desktop,
		navigation: { peek: () => null },
		adapter: { acknowledge() {} },
		store: { getSession: () => true }
	});
	const accepted = response();
	await handler(request({ type: "animate", name: "coin" }), accepted);
	assert.equal(accepted.result.status, 200);
	assert.deepEqual(JSON.parse(accepted.result.body), { ok: true });
	assert.deepEqual(animations, ["coin"]);
	const rejected = response();
	await handler(request({ type: "animate", name: "other" }), rejected);
	assert.equal(rejected.result.status, 400);
	assert.deepEqual(animations, ["coin"]);
});

test("the client can remember a selected historical chat without a live root or message content", async () => {
  const store = createStateStore();
  const handler = createDshHandler({ desktop: {}, navigation: {}, adapter: {}, store });
  const selected = response();
  await handler(request({ type: "client-focus", clientId: "window-1", sessionId: "history-chat" }), selected);
  assert.equal(selected.result.status, 200);
  assert.equal(store.getLastSessionId(), "history-chat");
  const invalid = response();
  await handler(request({ type: "client-focus", clientId: "window-1", sessionId: "bad\nvalue" }), invalid);
  assert.equal(invalid.result.status, 400);
  assert.equal(store.getLastSessionId(), "history-chat");
});
