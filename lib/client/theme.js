/**
 * Theme hand-off: publish the pet provider, listen for a theme that owns the
 * single fortune control, and keep the compatibility stylesheet in sync.
 */
function createTheme({ window, document, store, update, toggle, provider, themeEvent, statusEvent, styleId, css }) {
	let style = null;

	function sync() {
		if (typeof document === "undefined") return;
		if (store.getSnapshot().themeIntegrated) {
			style?.remove();
			style = null;
			return;
		}
		if (style) return;
		style = document.createElement("style");
		style.dataset.pluginCss = styleId;
		style.textContent = css;
		document.head.append(style);
	}

	function start() {
		const face = { version: 1, getSnapshot: store.getSnapshot, toggle };
		window[provider] = face;
		sync();
		const onTheme = () => update({ themeIntegrated: window.__DSH_CAISHEN_STATUS_V1__?.version === 1 });
		window.addEventListener(themeEvent, onTheme);
		window.dispatchEvent(new Event(statusEvent));
		return () => {
			window.removeEventListener(themeEvent, onTheme);
			if (window[provider] === face) delete window[provider];
			style?.remove();
			style = null;
			window.dispatchEvent(new Event(statusEvent));
		};
	}

	return { start, sync };
}

module.exports = { createTheme };
