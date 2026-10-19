/**
 * DSH 0.2.1-rc.2 Host adapter. Reads only live root identities, title and
 * userQuestions projections, plus lifecycle/end-reason metadata.
 * A stopped driver is not evidence that work succeeded.
 */
const CLIENT_PENDING_TTL = 8_000;

export function attachDshState(ctx, store) {
	const records = new Map();
	const clients = new Map();
	const disposers = [];
	const requestCleanups = new Set();
	let disposed = false;

	function isRoot(agent) {
		return agent && ctx.agents.roots().includes(agent);
	}
	function clientPending(sessionId) {
		const now = Date.now();
		return [...clients.values()].some((client) => client.expiresAt > now && client.ids.has(sessionId));
	}
	function publish(record) {
		if (disposed || records.get(record.sessionId) !== record) return;
		let status;
		let detail;
		if (record.approvals.size || record.foregroundQuestions.size || record.questions || clientPending(record.sessionId)) {
			status = "waiting";
			detail = "掌柜，请回 DSH 过目";
		} else if (record.outcome === "blocked") {
			status = "blocked";
			detail = "遇到问题，请回 DSH 查看";
		} else if (record.running) {
			status = "running";
			detail = "算盘拨起来了";
		} else {
			status = record.outcome === "ready" ? "ready" : "idle";
			detail = status === "ready" ? "本轮结束，掌柜请过目" : "阿财在这儿陪你";
		}
		if (record.published?.title === record.title && record.published?.status === status && record.published?.detail === detail) return;
		const value = { sessionId: record.sessionId, title: record.title, status, detail, updatedAt: Date.now() };
		record.published = value;
		store.upsertSession(value);
	}

	function ensure(agent) {
		if (disposed || !isRoot(agent)) return undefined;
		const previous = records.get(agent.id);
		if (previous?.agent === agent) return previous;
		// These are the exact Host projection keys and shapes in 0.2.1-rc.2.
		const values = ctx.sessionProjections.snapshot(agent.session, ["title", "userQuestions"]).values;
		const record = {
			agent,
			sessionId: agent.id,
			title: typeof values.title === "string" && values.title ? values.title : "未命名任务",
			running: agent.status === "running",
			outcome: null,
			approvals: new Set(),
			foregroundQuestions: new Set(),
			questions: (values.userQuestions?.active?.length ?? 0) > 0,
			published: null
		};
		records.set(agent.id, record);
		publish(record);
		return record;
	}

	function fromSession(session) {
		const agent = ctx.agents.get(session.id);
		return agent?.session === session ? ensure(agent) : undefined;
	}

	function observeRequest(field) {
		// Transparent waterfall observer: it never supplies an answer or changes
		// next()'s result/error. The request signal also withdraws a hung provider.
		return async (request, next) => {
			const record = ensure(request.agent);
			if (!record) return next();
			const token = Symbol(field);
			let active = !request.signal?.aborted;
			if (active) record[field].add(token);
			const release = () => {
				if (!active) return;
				active = false;
				record[field].delete(token);
				publish(record);
			};
			request.signal?.addEventListener("abort", release, { once: true });
			const cleanup = () => {
				request.signal?.removeEventListener("abort", release);
				release();
			};
			requestCleanups.add(cleanup);
			publish(record);
			try {
				return await next();
			} finally {
				cleanup();
				requestCleanups.delete(cleanup);
			}
		};
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		for (const off of disposers.splice(0).reverse()) off();
		for (const cleanup of requestCleanups) cleanup();
		requestCleanups.clear();
		clients.clear();
		records.clear();
		store.setConnected(false);
	}

	ctx.effect(() => {
		disposers.push(ctx.on("agent/created", ({ agent }) => ensure(agent)));
		disposers.push(ctx.on("agent/disposed", ({ agent }) => {
			if (records.get(agent.id)?.agent !== agent) return;
			records.delete(agent.id);
			store.removeSession(agent.id);
		}));
		disposers.push(ctx.on("agent/status", ({ agent, status }) => {
			const record = ensure(agent);
			if (!record) return;
			record.running = status === "running";
			publish(record);
		}));
		disposers.push(ctx.on("agent/error", ({ agent }) => {
			const record = ensure(agent);
			if (!record) return;
			record.outcome = "blocked";
			publish(record);
		}));
		disposers.push(ctx.on("session/event", (session, event) => {
			// Check the discriminator before resolving an agent; never inspect
			// message bodies, tool arguments/results or model reasoning.
			if (!["turn/start", "turn/end", "session/title"].includes(event.type)) return;
			const record = fromSession(session);
			if (!record) return;
			if (event.type === "turn/start") {
				record.outcome = null;
				record.running = true;
			} else if (event.type === "turn/end") {
				const kind = event.data.reason?.kind;
				record.outcome = kind === "completed" ? "ready" : ["error", "blocked", "max-tokens"].includes(kind) ? "blocked" : null;
			} else if (typeof event.data.title === "string") {
				record.title = event.data.title || "未命名任务";
			}
			publish(record);
		}));
		disposers.push(ctx.sessionProjections.onChanged((session, key, value) => {
			if (key !== "title" && key !== "userQuestions") return;
			const record = fromSession(session);
			if (!record) return;
			if (key === "title") record.title = typeof value === "string" && value ? value : "未命名任务";
			else record.questions = (value?.active?.length ?? 0) > 0;
			publish(record);
		}));
		disposers.push(ctx.on("approval/request", observeRequest("approvals"), { global: true, prepend: true }));
		disposers.push(ctx.on("user-questions/request", observeRequest("foregroundQuestions"), { global: true, prepend: true }));
		const timer = setInterval(() => {
			const now = Date.now();
			let changed = false;
			for (const [id, client] of clients) if (client.expiresAt <= now) {
				clients.delete(id);
				changed = true;
			}
			if (changed) for (const record of records.values()) publish(record);
		}, 2_000);
		timer.unref?.();
		disposers.push(() => clearInterval(timer));
		for (const agent of ctx.agents.roots()) ensure(agent);
		store.setConnected(true);
		return dispose;
	}, "pet-caishen: Host activity observer");

	return {
		dispose,
		acknowledge(sessionId) {
			const record = records.get(sessionId);
			if (!record || disposed) return;
			record.outcome = null;
			publish(record);
		},
		setClientPending(clientId, entries) {
			if (disposed || typeof clientId !== "string" || !Array.isArray(entries)) return;
			// Supplemental facts expire independently. They cannot remove Host
			// approval/question facts or establish the Host connection's liveness.
			clients.set(clientId, {
				expiresAt: Date.now() + CLIENT_PENDING_TTL,
				ids: new Set(entries.filter((entry) => entry?.pending === true && records.has(entry.sessionId)).map((entry) => entry.sessionId))
			});
			for (const record of records.values()) publish(record);
		}
	};
}
