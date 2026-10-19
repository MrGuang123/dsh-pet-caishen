/** Small observable snapshot store shared by the control and the bridge. */
function createStore(initial) {
	let snapshot = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		update(patch) {
			snapshot = { ...snapshot, ...patch };
			for (const listener of [...listeners]) listener();
			return snapshot;
		}
	};
}

module.exports = { createStore };
