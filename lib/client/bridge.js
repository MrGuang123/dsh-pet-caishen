const { ENDPOINT, HEADERS } = require("./constants");

/**
 * Credentialed client side of the DSH bridge.
 * Owns polling, pending-interaction supplements, navigation acknowledgements
 * and the two user actions (toggle, one-shot animation).
 */
function createBridge({ ctx, store, update, lifetime, isActive }) {
	const clientId = globalThis.crypto?.randomUUID?.() ?? `acai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const handled = new Set();
	let pendingFingerprint;
	let pendingSentAt = 0;
	let pendingSending = false;
	let polling = false;
	let desktopRevision = 0;
	let selectedSent = null;
	let selectedSentAt = 0;
		let completions = [];
		let selectedCompletion = null;
	let selectionSending = false;
	let selectionQueued = false;

	async function sendSelection() {
		if (!isActive() || typeof document !== "undefined" && (document.visibilityState === "hidden" || typeof document.hasFocus === "function" && !document.hasFocus())) return;
		if (selectionSending) { selectionQueued = true; return; }
		const rows = ctx.sessions.list.getSnapshot().byId;
		const current = ctx.uiSession.current?.getSnapshot?.();
		const id = current?.key ?? Object.values(rows).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id;
		const observedCompletionId = completions.find(row => row.sessionId === id)?.completionId ?? null;
			if (typeof id !== "string" || !rows[id] || id === selectedSent && observedCompletionId === selectedCompletion && Date.now() - selectedSentAt < 4_000) return;
		selectionSending = true;
		try {
			await request({ type: "client-focus", clientId, sessionId: id, ...(observedCompletionId ? { observedCompletionId } : {}) });
				selectedCompletion = observedCompletionId;
			selectedSent = id;
			selectedSentAt = Date.now();
		} catch (error) {
			if (!lifetime.signal.aborted) update({ error: error.message });
		} finally {
			selectionSending = false;
			if (selectionQueued) { selectionQueued = false; void sendSelection(); }
		}
	}

	async function request(body) {
		const response = await fetch(ENDPOINT, {
			method: body ? "POST" : "GET",
			headers: HEADERS,
			credentials: "same-origin",
			cache: "no-store",
			signal: lifetime.signal,
			...(body ? { body: JSON.stringify(body) } : {})
		});
		const payload = response.status === 204 ? null : await response.json().catch(() => null);
		if (!response.ok) throw new Error(payload?.error || `阿财桥接请求失败（${response.status}）`);
		return payload;
	}

	async function sendPending(force = false) {
		if (!isActive() || pendingSending) return;
		const entries = [...ctx.uiSession.sessionStatus.getSnapshot()]
			.filter(([, status]) => Boolean(status.pendingInteraction))
			.map(([sessionId]) => ({ sessionId, pending: true })).slice(0, 200);
		const fingerprint = JSON.stringify(entries);
		if (!force && fingerprint === pendingFingerprint && Date.now() - pendingSentAt < 4_000) return;
		pendingSending = true;
		try {
			await request({ type: "client-pending", clientId, entries });
			pendingFingerprint = fingerprint;
			pendingSentAt = Date.now();
		} catch (error) {
			if (!lifetime.signal.aborted) update({ error: error.message });
		} finally {
			pendingSending = false;
		}
	}

	async function navigate(command) {
		if (!command || handled.has(command.id) || !Number.isFinite(command.expiresAt) || command.expiresAt <= Date.now()) return;
		handled.add(command.id);
		try {
			if (!ctx.sessions.list.getSnapshot().byId[command.sessionId]) throw new Error("目标会话暂不可用，请在 DSH 会话列表中打开");
			ctx.uiWorkspace.openSession(command.sessionId);
			// openSession() is synchronous in this DSH version. A mainView
			// retention confirms selection; it does not claim history loaded.
			if (!(ctx.sessions.retainInfo(command.sessionId).getSnapshot().retainedBy.mainView > 0)) throw new Error("DSH 尚未选中目标会话，请稍后重试");
			await request({ type: "navigation-ack", id: command.id, sessionId: command.sessionId });
			update({ error: "" });
		} catch (error) {
			// Leave a failed command unacknowledged. The Host expires it.
			if (!lifetime.signal.aborted) update({ error: `返回任务失败：${error.message}` });
		}
		if (handled.size > 100) handled.delete(handled.values().next().value);
	}

	async function poll() {
		if (!isActive() || polling) return;
		polling = true;
		const revision = desktopRevision;
		try {
			const result = await request();
				completions = result.completions ?? [];
			if (!isActive()) return;
			const keepNavigationError = store.getSnapshot().error.startsWith("返回任务失败：");
			if (revision === desktopRevision) update({ desktop: result.desktop, error: keepNavigationError ? store.getSnapshot().error : "" });
			await navigate(result.command);
		} catch (error) {
			if (!lifetime.signal.aborted) update({ error: error.message });
		} finally {
			polling = false;
		}
		void sendPending();
		void sendSelection();
	}

	async function toggle() {
		if (store.getSnapshot().busy) return;
		desktopRevision += 1;
		update({ busy: true, error: "" });
		try {
			const result = await request({ type: "toggle" });
			if (isActive()) update({ desktop: result.desktop });
		} catch (error) {
			if (!lifetime.signal.aborted) update({ error: error.message });
		} finally {
			update({ busy: false });
		}
	}

	async function animate(name = "coin") {
		if (!isActive()) return;
		try {
			await request({ type: "animate", name });
		} catch {
			// A one-shot animation is best effort; never surface it as a task error.
		}
	}

	return { request, sendPending, sendSelection, navigate, poll, toggle, animate };
}

module.exports = { createBridge };
