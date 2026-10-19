import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { attachDshState } from "../lib/dsh-adapter.js";

function fixture({ running = false, questions = [] } = {}) {
	const root = { id: "root", status: running ? "running" : "idle", session: { id: "root" } };
	const child = { id: "child", status: "running", session: { id: "child" } };
	const liveRoots = [root];
	const handlers = new Map();
	const effects = [];
	const changes = new Set();
	const rows = new Map();
	let connected = false;
	const ctx = {
		agents: { roots: () => liveRoots, get: (id) => [root, child].find((agent) => agent.id === id) },
		sessionProjections: {
			snapshot: () => ({ values: { title: "真实标题", userQuestions: { active: questions } } }),
			onChanged(listener) { changes.add(listener); return () => changes.delete(listener); }
		},
		on(name, listener) {
			const listeners = handlers.get(name) ?? new Set();
			handlers.set(name, listeners);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		effect(setup) { const cleanup = setup(); effects.push(cleanup); return cleanup; }
	};
	const store = {
		upsertSession(value) { rows.set(value.sessionId, value); },
		removeSession(id) { rows.delete(id); },
		setConnected(value) { connected = value; },
		getSnapshot: () => ({ sessions: [...rows.values()], connection: { connected } })
	};
	const adapter = attachDshState(ctx, store);
	const emit = (name, ...args) => [...handlers.get(name) ?? []].map((listener) => listener(...args));
	const event = (type, data = {}) => emit("session/event", root.session, { type, data });
	const status = () => rows.get("root")?.status;
	return { ctx, root, child, rows, adapter, emit, event, status, changes, liveRoots, handlers, effects, store };
}

test("starts from real root/title/question projections, ignores children and message content", (t) => {
	const f = fixture({ questions: [{ callId: "q", state: "continued" }] });
	t.after(f.adapter.dispose);
	assert.equal(f.rows.size, 1);
	assert.equal(f.rows.get("root").title, "真实标题");
	assert.equal(f.status(), "waiting");
	f.emit("agent/status", { agent: f.child, status: "running" });
	assert.equal(f.rows.has("child"), false);
	f.event("assistant/message", { get content() { throw new Error("must not inspect bodies"); } });
	for (const listener of f.changes) listener(f.root.session, "title", "改名后");
	assert.equal(f.rows.get("root").title, "改名后");
	for (const listener of f.changes) listener(f.root.session, "userQuestions", { active: [] });
	assert.equal(f.status(), "idle");
});

test("completed is ready only when driver stops, and acknowledgement clears the reminder", (t) => {
	const f = fixture({ running: true });
	t.after(f.adapter.dispose);
	f.event("turn/end", { reason: { kind: "completed" } });
	assert.equal(f.status(), "running");
	f.emit("agent/status", { agent: f.root, status: "idle" });
	assert.equal(f.status(), "ready");
	assert.match(f.rows.get("root").detail, /本轮结束/);
	f.adapter.acknowledge("root");
	assert.equal(f.status(), "idle");
});

for (const [kind, expected] of [["error", "blocked"], ["blocked", "blocked"], ["max-tokens", "blocked"], ["aborted", "idle"], ["interrupted", "idle"], ["unknown-plugin-ending", "idle"]]) {
	test(`turn ending ${kind} maps to ${expected}, never false success`, (t) => {
		const f = fixture({ running: true });
		t.after(f.adapter.dispose);
		f.event("turn/end", { reason: { kind } });
		f.emit("agent/status", { agent: f.root, status: "idle" });
		assert.equal(f.status(), expected);
		f.event("turn/start");
		assert.equal(f.status(), "running");
	});
}

test("approval observer forwards next exactly once and preserves its result", async (t) => {
	const f = fixture({ running: true });
	t.after(f.adapter.dispose);
	let finish;
	let calls = 0;
	const next = () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); };
	const [pending] = f.emit("approval/request", { agent: f.root }, next);
	assert.equal(calls, 1);
	assert.equal(f.status(), "waiting");
	// A UI heartbeat cannot remove Host-owned approval facts.
	f.adapter.setClientPending("ui", []);
	assert.equal(f.status(), "waiting");
	finish("allowed-once");
	assert.equal(await pending, "allowed-once");
	assert.equal(f.status(), "running");
});

test("request errors and abort release waiting without intercepting answers", async (t) => {
	const f = fixture({ running: true });
	t.after(f.adapter.dispose);
	const failure = new Error("provider failed");
	const [failed] = f.emit("user-questions/request", { agent: f.root }, async () => { throw failure; });
	await assert.rejects(failed, (error) => error === failure);
	assert.equal(f.status(), "running");
	const controller = new AbortController();
	let finish;
	const [pending] = f.emit("approval/request", { agent: f.root, signal: controller.signal }, () => new Promise((resolve) => { finish = resolve; }));
	assert.equal(f.status(), "waiting");
	controller.abort();
	assert.equal(f.status(), "running");
	finish("cancelled");
	assert.equal(await pending, "cancelled");
});

test("supplemental client facts replace only that client's pending values", (t) => {
	const f = fixture({ running: true });
	t.after(f.adapter.dispose);
	f.adapter.setClientPending("ui", [{ sessionId: "root", pending: true }, { sessionId: "child", pending: true }]);
	assert.equal(f.status(), "waiting");
	assert.equal(f.rows.has("child"), false);
	f.adapter.setClientPending("ui", []);
	assert.equal(f.status(), "running");
	f.emit("agent/error", { agent: f.root, error: new Error("private diagnostic") });
	assert.equal(f.status(), "blocked");
	assert.doesNotMatch(JSON.stringify(f.store.getSnapshot()), /private diagnostic/);
});

test("lost UI expires only its supplemental pending; Host questions and connection remain", (t) => {
	let now = 1_000;
	let tick;
	t.mock.method(Date, "now", () => now);
	t.mock.method(globalThis, "setInterval", (callback) => { tick = callback; return { unref() {} }; });
	t.mock.method(globalThis, "clearInterval", () => {});
	const f = fixture({ running: true });
	t.after(f.adapter.dispose);
	f.adapter.setClientPending("background-ui", [{ sessionId: "root", pending: true }]);
	assert.equal(f.status(), "waiting");
	now += 8_001;
	tick();
	assert.equal(f.status(), "running");
	assert.equal(f.store.getSnapshot().connection.connected, true);
	for (const listener of f.changes) listener(f.root.session, "userQuestions", { active: [{ state: "continued" }] });
	f.adapter.setClientPending("background-ui", [{ sessionId: "root", pending: true }]);
	now += 8_001;
	tick();
	assert.equal(f.status(), "waiting");
});

test("root disposal removes its row; adapter disposal removes listeners and ignores late requests", async () => {
	const f = fixture({ running: true });
	let finish;
	const [pending] = f.emit("approval/request", { agent: f.root }, () => new Promise((resolve) => { finish = resolve; }));
	f.emit("agent/disposed", { agent: f.root });
	assert.equal(f.rows.has("root"), false);
	f.adapter.dispose();
	f.adapter.dispose();
	assert.equal(f.store.getSnapshot().connection.connected, false);
	assert.equal([...f.handlers.values()].every((listeners) => listeners.size === 0), true);
	assert.equal(f.changes.size, 0);
	finish("rejected");
	await pending;
	assert.equal(f.rows.size, 0);
});

async function clientFixture({ navigationFails = false, themeIntegrated = false } = {}) {
	const requests = [];
	const effects = [];
	const pendingListeners = new Set();
	const selectionListeners = new Set();
	let currentSessionId = "reading-chat";
	const controls = [];
	const styles = [];
	const clickListeners = new Set();
	let selected = false;
	let plugin;
	const desktop = { supported: true, available: true, running: true, visible: true };
	const window = new EventTarget();
	if (themeIntegrated) window.__DSH_CAISHEN_STATUS_V1__ = { version: 1 };
	const document = {
		head: { append(style) { styles.push(style); } },
		createElement(tagName) {
			const style = {
				tagName, dataset: {}, textContent: "",
				remove() { const index = styles.indexOf(style); if (index !== -1) styles.splice(index, 1); }
			};
			return style;
		},
		addEventListener(type, listener) { if (type === "click") clickListeners.add(listener); },
		removeEventListener(type, listener) { if (type === "click") clickListeners.delete(listener); }
	};
	const command = { id: "navigation-1", sessionId: "root", expiresAt: Date.now() + 20_000 };
	const sandbox = {
		window: Object.assign(window, { __ModuleLoader__: { load(definition) {
			assert.equal(definition.id, "dsh-pet-caishen");
			plugin = definition.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }), useSyncExternalStore: (_subscribe, get) => get() }));
		} } }),
		document, AbortController, Date, Math, Event,
		setInterval: () => 1,
		clearInterval() {},
		fetch: async (_url, options) => {
			requests.push(options);
			const body = options.body && JSON.parse(options.body);
			if (body?.type === "toggle") desktop.visible = !desktop.visible;
			return { ok: true, status: 200, json: async () => options.method === "GET" ? { desktop: { ...desktop }, command } : { ok: true, desktop: { ...desktop } } };
		}
	};
	vm.runInNewContext(await readFile(new URL("../lib/client.js", import.meta.url), "utf8"), sandbox);
	const ctx = {
		effect(setup) { const cleanup = setup(); effects.push(cleanup); return cleanup; },
		uiSession: { current: {
			getSnapshot: () => ({ key: currentSessionId }),
			subscribe(listener) { selectionListeners.add(listener); return () => selectionListeners.delete(listener); }
		}, sessionStatus: {
			getSnapshot: () => new Map([["root", { pendingInteraction: { kind: "approval", reason: "private reason", result: Promise.resolve() } }]]),
			subscribe(listener) { pendingListeners.add(listener); return () => pendingListeners.delete(listener); }
		} },
		sessions: {
			list: { getSnapshot: () => ({ byId: { root: { id: "root" }, "reading-chat": { id: "reading-chat" }, "other-chat": { id: "other-chat" } } }) },
			retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: selected ? 1 : 0 } }) })
		},
		uiWorkspace: { openSession(id) { assert.equal(id, "root"); if (navigationFails) throw new Error("navigation rejected"); selected = true; } },
		slots: {
			inject: (_name, factory) => factory(),
			register: (_options, Component) => { controls.push(Component); return () => {}; }
		}
	};
	plugin.apply(ctx);
	await new Promise(setImmediate);
	return { requests, controls, pendingListeners, selectionListeners, select(id) { currentSessionId = id; for (const listener of selectionListeners) listener(); }, styles, clickListeners, window, dispose: () => effects.reverse().forEach((off) => off()), plugin };
}

test("client acknowledges real selection, sends only pending booleans, aborts on unload", async () => {
	const f = await clientFixture();
	assert.deepEqual(Array.from(f.plugin.inject), ["slots", "uiSession", "uiWorkspace", "sessions"]);
	const bodies = f.requests.filter((request) => request.body).map((request) => JSON.parse(request.body));
	assert.equal(bodies.some((body) => body.type === "navigation-ack" && body.sessionId === "root"), true);
	const pending = bodies.find((body) => body.type === "client-pending");
	assert.deepEqual(pending.entries, [{ sessionId: "root", pending: true }]);
	assert.doesNotMatch(JSON.stringify(bodies), /private reason|pendingInteraction/);
	f.dispose();
	assert.equal(f.pendingListeners.size, 0);
	assert.equal(f.requests.every((request) => request.signal.aborted), true);
});

test("client navigation failures stay unacknowledged and visible in the control", async () => {
	const f = await clientFixture({ navigationFails: true });
	const bodies = f.requests.filter((request) => request.body).map((request) => JSON.parse(request.body));
	assert.equal(bodies.some((body) => body.type === "navigation-ack"), false);
	assert.match(JSON.stringify(f.controls[0]()), /返回任务失败：navigation rejected/);
	f.dispose();
});

test("selected chat changes are reported independently of the active background task and unsubscribed", async () => {
	const f = await clientFixture();
	const focused = () => f.requests.flatMap(request => request.body ? [JSON.parse(request.body)] : []).filter(body => body.type === "client-focus");
	assert.equal(focused().at(-1).sessionId, "reading-chat");
	f.select("other-chat");
	await new Promise(setImmediate);
	assert.equal(focused().at(-1).sessionId, "other-chat");
	f.select(undefined);
	await new Promise(setImmediate);
	assert.equal(focused().at(-1).sessionId, "other-chat", "home must retain the previous selected chat");
	f.dispose();
	assert.equal(f.selectionListeners.size, 0);
});

test("fortune status reflects actual visibility and toggles without treating a running process as visible", async () => {
	const f = await clientFixture();
	const provider = f.window.__DSH_ACAI_COMPANION_V1__;
	assert.match(JSON.stringify(f.controls[0]()), /今日财运在线/);
	assert.equal(f.controls[0]().props["data-acai-fortune"], "online");
	assert.equal(f.controls[0]().props.className, "acai-fortune");
	assert.equal(f.controls[0]().props.style, undefined);
	await provider.toggle();
	assert.equal(provider.getSnapshot().desktop.running, true);
	assert.equal(provider.getSnapshot().desktop.visible, false);
	assert.match(JSON.stringify(f.controls[0]()), /财运正在路上/);
	assert.doesNotMatch(JSON.stringify(f.controls[0]()), /今日财运酝酿/);
	assert.equal(f.controls[0]().props["data-acai-fortune"], "away");
	assert.equal(f.controls[0]().props["aria-pressed"], false);
	await provider.toggle();
	assert.equal(provider.getSnapshot().desktop.visible, true);
	assert.equal(f.controls[0]().props["aria-pressed"], true);
	f.dispose();
	assert.equal(f.window.__DSH_ACAI_COMPANION_V1__, undefined);
});

test("the theme's static fortune chip is hidden until the theme publishes the single control", async () => {
	const f = await clientFixture();
	const shim = () => f.styles.find((style) => style.dataset.pluginCss === "dsh-pet-caishen:fortune-status");
	const control = () => f.styles.find((style) => style.dataset.pluginCss === "dsh-pet-caishen:fortune");
	assert.ok(control());
	assert.ok(shim());
	assert.match(control().textContent, /align-self: center/);
	assert.match(control().textContent, /height: 30px/);
	assert.match(shim().textContent, /position: relative/);
	assert.match(shim().textContent, /top: 6px/);
	assert.match(shim().textContent, /\.caishen-utilities \.caishen-status/);
	assert.match(shim().textContent, /\.caishen-hero-actions \.caishen-status/);
	f.window.__DSH_CAISHEN_STATUS_V1__ = { version: 1 };
	f.window.dispatchEvent(new Event("dsh-theme-caishen:status-host"));
	assert.equal(shim(), undefined);
	assert.ok(control());
	delete f.window.__DSH_CAISHEN_STATUS_V1__;
	f.window.dispatchEvent(new Event("dsh-theme-caishen:status-host"));
	assert.ok(shim());
	f.dispose();
	assert.equal(f.styles.length, 0);
});

test("clicking the theme merit badge asks the host to play the coin animation", async () => {
	const f = await clientFixture();
	assert.equal(f.clickListeners.size, 1);
	const before = f.requests.length;
	[...f.clickListeners][0]({ target: { closest: (selector) => selector === ".caishen-merit" ? {} : null } });
	await new Promise(setImmediate);
	const bodies = f.requests.slice(before).map((request) => request.body && JSON.parse(request.body));
	assert.deepEqual(bodies.find((body) => body?.type === "animate"), { type: "animate", name: "coin" });
	const after = f.requests.length;
	[...f.clickListeners][0]({ target: { closest: () => null } });
	await new Promise(setImmediate);
	assert.equal(f.requests.length, after);
	f.dispose();
	assert.equal(f.clickListeners.size, 0);
});

test("a compatible theme owns the single fortune control, including late enable and disable", async () => {
	const f = await clientFixture({ themeIntegrated: true });
	assert.equal(f.controls[0](), null);
	delete f.window.__DSH_CAISHEN_STATUS_V1__;
	f.window.dispatchEvent(new Event("dsh-theme-caishen:status-host"));
	assert.notEqual(f.controls[0](), null);
	f.window.__DSH_CAISHEN_STATUS_V1__ = { version: 1 };
	f.window.dispatchEvent(new Event("dsh-theme-caishen:status-host"));
	assert.equal(f.controls[0](), null);
	f.dispose();
});
