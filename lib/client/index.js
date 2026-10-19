const {
	PROVIDER,
	STATUS_EVENT,
	THEME_EVENT,
	FORTUNE_STYLE_ID,
	THEME_STATUS_STYLE_ID
} = require("./constants");
const { createStore } = require("./store");
const { createBridge } = require("./bridge");
const { createTheme } = require("./theme");
const { createFortuneControl } = require("./fortune");
const { createMeritListener } = require("./merit");
const { FORTUNE_CSS, THEME_STATUS_CSS } = require("./styles");

module.exports = function createPlugin(React) {
	function apply(ctx) {
		let active = true;
		let theme;
		const lifetime = new AbortController();
		const store = createStore({
			desktop: null,
			error: "",
			busy: false,
			themeIntegrated: window.__DSH_CAISHEN_STATUS_V1__?.version === 1
		});
		const update = (patch) => {
			if (!active) return;
			store.update(patch);
			theme?.sync();
			window.dispatchEvent(new Event(STATUS_EVENT));
		};
		const bridge = createBridge({ ctx, store, update, lifetime, isActive: () => active });
		theme = createTheme({
			window,
			document,
			store,
			update,
			toggle: bridge.toggle,
			provider: PROVIDER,
			themeEvent: THEME_EVENT,
			statusEvent: STATUS_EVENT,
			styleId: THEME_STATUS_STYLE_ID,
			css: THEME_STATUS_CSS
		});
		const Control = createFortuneControl({ React, store, toggle: bridge.toggle });

		ctx.effect(() => {
			if (typeof document === "undefined") return () => {};
			const style = document.createElement("style");
			style.dataset.pluginCss = FORTUNE_STYLE_ID;
			style.textContent = FORTUNE_CSS;
			document.head.append(style);
			return () => style.remove();
		}, "pet-caishen: fortune styles");

		ctx.effect(() => theme.start(), "pet-caishen: fortune status integration");
		ctx.effect(() => createMeritListener({ document, animate: bridge.animate }), "pet-caishen: merit coin animation");

		ctx.effect(() => {
			const off = ctx.uiSession.sessionStatus.subscribe(() => void bridge.sendPending(true));
			const offSelection = ctx.uiSession.current?.subscribe(() => void bridge.sendSelection())
				?? ctx.sessions.list.subscribe?.(() => void bridge.sendSelection());
			const onFocus = () => void bridge.sendSelection();
			window.addEventListener("focus", onFocus);
			const timer = setInterval(() => void bridge.poll(), 2_000);
			void bridge.poll();
			return () => {
				active = false;
				lifetime.abort();
				clearInterval(timer);
				off();
				offSelection?.();
				window.removeEventListener("focus", onFocus);
			};
		}, "pet-caishen: bridge and navigation");

		for (const name of ["conversation.session.header.utilities", "conversation.hero.options"]) {
			ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, id: "pet-caishen-control", order: 90 }, Control)), `pet-caishen: ${name}`);
		}
	}

	return { apply, inject: ["slots", "uiSession", "uiWorkspace", "sessions"] };
};
